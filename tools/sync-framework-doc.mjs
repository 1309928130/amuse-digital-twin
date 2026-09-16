#!/usr/bin/env node
/**
 * Sync the framework documentation into the web app.
 *
 * The source of truth is the standalone docs repo cloned at
 * `docs/Documentation_for_MultSensory_DigitalTwins/` (a nested git clone with
 * its own remotes). The viewer serves a *copy* under
 * `visualization/framework/`, because the published site must be self-contained
 * and the source directory also carries research artefacts — Grasshopper
 * definitions, a git history, analysis scratch files — that have no business
 * being uploaded to a web host.
 *
 * A copy can drift, which is what this script prevents. Run it after editing
 * the documentation, then reload the viewer:
 *
 *   node tools/sync-framework-doc.mjs
 *
 * Pass `--check` to verify without writing, for use in CI or a pre-deploy step;
 * it exits non-zero when the copy is stale.
 *
 *   node tools/sync-framework-doc.mjs --check
 *
 * ## What is copied
 *
 *   README.md   -> framework/README.md
 *   figures/*   -> framework/figures/*
 *
 * Figures are filtered against the ones the Markdown actually references, so
 * unreferenced research images (Result1.png, Result2.png, ...) are not shipped.
 * They are never *deleted* from the destination without this script having put
 * them there, so a hand-added asset in the web copy survives.
 */

import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(VIEWER_ROOT, '..');

const SOURCE_DIR = path.join(REPO_ROOT, 'docs/Documentation_for_MultSensory_DigitalTwins');
const SOURCE_README = path.join(SOURCE_DIR, 'README.md');
const SOURCE_FIGURES = path.join(SOURCE_DIR, 'figures');

const DEST_DIR = path.join(VIEWER_ROOT, 'framework');
const DEST_README = path.join(DEST_DIR, 'README.md');
const DEST_FIGURES = path.join(DEST_DIR, 'figures');

const CHECK_ONLY = process.argv.includes('--check');

/**
 * Asset filenames referenced by the Markdown, relative to the document.
 *
 * Covers both image sources and link targets: the figures are raw `<img>` tags,
 * and each one is wrapped in an `<a href>` pointing at the source PDF, so
 * scanning only images would silently leave every linked PDF stale.
 *
 * Only the basename is kept, since the document references assets relatively.
 */
function referencedAssets(markdown) {
    const names = new Set();
    const patterns = [
        /<img[^>]*\bsrc=["']([^"']+)["']/gi, // raw HTML image
        /<a[^>]*\bhref=["']([^"']+)["']/gi, // raw HTML link
        /!\[[^\]]*\]\(([^)\s]+)/g, // markdown image
        /(?<!!)\[[^\]]*\]\(([^)\s]+)/g, // markdown link
    ];
    for (const re of patterns) {
        for (const match of markdown.matchAll(re)) {
            const src = match[1];
            if (/^(https?:|mailto:|tel:|data:|#)/i.test(src)) continue;
            // Directory links (e.g. the cross-repo `../../visualization/`) are
            // pointers to other trees, not assets to mirror.
            if (src.endsWith('/')) continue;
            const base = path.basename(src);
            // Only mirror things the destination can actually serve as a file.
            if (!/\.[a-z0-9]{2,5}$/i.test(base)) continue;
            names.add(base);
        }
    }
    return names;
}

async function main() {
    if (!existsSync(SOURCE_README)) {
        console.error(`[framework] Source README not found: ${SOURCE_README}`);
        console.error('[framework] Is the docs repo cloned at that path?');
        process.exit(1);
    }

    const sourceMarkdown = await readFile(SOURCE_README, 'utf8');
    const wanted = referencedAssets(sourceMarkdown);

    // --- README ------------------------------------------------------------
    const currentDest = existsSync(DEST_README) ? await readFile(DEST_README, 'utf8') : null;
    const readmeChanged = currentDest !== sourceMarkdown;

    // --- Assets ------------------------------------------------------------
    const available = existsSync(SOURCE_FIGURES)
        ? (await readdir(SOURCE_FIGURES)).filter((f) => !f.startsWith('.'))
        : [];

    const toCopy = [];
    const missing = [];
    for (const name of wanted) {
        const from = path.join(SOURCE_FIGURES, name);
        if (!available.includes(name)) {
            missing.push(name);
            continue;
        }
        const to = path.join(DEST_FIGURES, name);
        // Compare bytes, not mtime: `copyFile` stamps a new mtime on the
        // destination, so comparing timestamps flagged every figure as stale on
        // every run and the script could never report itself up to date.
        // Figures are small and few, so a full compare is cheap.
        let stale = true;
        if (existsSync(to)) {
            const [a, b] = await Promise.all([readFile(from), readFile(to)]);
            stale = !a.equals(b);
        }
        if (stale) toCopy.push({ name, from, to });
    }

    // A referenced asset that is not in the source is a broken document, not
    // just a stale copy — the web copy would serve a dead link. Surface it on
    // sync, and fail `--check` so CI/pre-deploy catches it.
    if (missing.length) {
        console.warn(`[framework] ${missing.length} referenced asset(s) not found in source:`);
        missing.forEach((m) => console.warn(`[framework]    missing: ${m}`));
    }

    // Orphans: files already in the destination that the document no longer
    // references. These are safe to prune because the destination directory is
    // owned by this script — it only ever writes assets it copied from source.
    // Without this, a figure removed from the document lingers in the web copy
    // and gets deployed for no reason.
    const destPresent = existsSync(DEST_FIGURES)
        ? (await readdir(DEST_FIGURES)).filter((f) => !f.startsWith('.'))
        : [];
    const orphans = destPresent.filter((f) => !wanted.has(f) && available.includes(f));

    const unchanged = !readmeChanged && !toCopy.length && !orphans.length;

    if (CHECK_ONLY) {
        if (unchanged && !missing.length) {
            console.log('[framework] In sync.');
            process.exit(0);
        }
        if (readmeChanged) console.error('[framework] STALE: framework/README.md differs from source.');
        if (toCopy.length) {
            console.error(
                `[framework] STALE: ${toCopy.length} asset(s) need copying: ` +
                    toCopy.map((f) => f.name).join(', ')
            );
        }
        if (orphans.length) {
            console.error(
                `[framework] STALE: ${orphans.length} orphaned asset(s) to prune: ` + orphans.join(', ')
            );
        }
        if (missing.length) {
            console.error(
                `[framework] BROKEN: ${missing.length} referenced asset(s) missing from source: ` +
                    missing.join(', ')
            );
        }
        console.error('[framework] Run: node tools/sync-framework-doc.mjs');
        process.exit(1);
    }

    if (unchanged) {
        console.log('[framework] Already in sync — nothing to do.');
        console.log(`[framework]   README.md (${(sourceMarkdown.length / 1024).toFixed(1)} KB)`);
        console.log(`[framework]   ${wanted.size} referenced assets`);
        return;
    }

    await mkdir(DEST_FIGURES, { recursive: true });

    if (readmeChanged) {
        await writeFile(DEST_README, sourceMarkdown, 'utf8');
        console.log(
            `[framework] README.md  ${currentDest === null ? 'created' : 'updated'} ` +
                `(${(sourceMarkdown.length / 1024).toFixed(1)} KB)`
        );
    }

    for (const { name, from, to } of toCopy) {
        await copyFile(from, to);
        console.log(`[framework] asset      ${name}`);
    }

    for (const name of orphans) {
        await rm(path.join(DEST_FIGURES, name), { force: true });
        console.log(`[framework] pruned     ${name}`);
    }

    console.log(
        `[framework] Synced: ${readmeChanged ? '1 doc' : '0 docs'}, ${toCopy.length} figure(s).`
    );
    console.log(`[framework]   ${wanted.size} referenced, ${available.length} available in source.`);
    if (available.length > wanted.size) {
        const skipped = available.filter((f) => !wanted.has(f));
        console.log(`[framework]   not referenced (not shipped): ${skipped.join(', ')}`);
    }
}

main().catch((error) => {
    console.error('[framework] Sync failed:', error);
    process.exit(1);
});
