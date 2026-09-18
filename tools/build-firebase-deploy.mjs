#!/usr/bin/env node
/**
 * Assemble the Firebase Hosting bundle from the app source.
 *
 * Firebase serves a single static directory, so the app is staged into
 * `firebase-deploy/` and published from there. That directory is a build
 * output: it is git-ignored and safe to wipe, because everything in it is
 * derived. It used to be maintained by hand, which is how it drifted several
 * days behind the app and shipped without the framework document at all.
 *
 *   node tools/build-firebase-deploy.mjs            # build
 *   node tools/build-firebase-deploy.mjs --dry-run  # report, write nothing
 *
 * The bundle deliberately excludes:
 *
 *   node_modules/   dependencies are served from a CDN
 *   tools/          build tooling, not part of the site
 *   *.md (root)     developer guides, not linked from the app
 *   _*.png          local UI-tuning screenshots
 *
 * but *includes* `framework/`, which the app fetches at runtime for the
 * framework page. `--check-docs` should be run first so the shipped
 * documentation is known to be current.
 */

import { readdir, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const OUT = path.join(APP_ROOT, 'firebase-deploy');
const DRY_RUN = process.argv.includes('--dry-run');

/** Directories copied wholesale into the bundle. */
const COPY_DIRS = ['src', 'framework', 'simulation_data', 'models', 'data', 'cases'];

/**
 * Directories excluded from the bundle even though they sit inside a copy root.
 *
 * The GTFS feed directories are multi-gigabyte raw downloads that the static
 * site does not read: the host serves a draft viewer, and the transit features
 * that consume them are dormant there. Shipping them would mean a ~4.6 GB
 * upload for no benefit. They are regenerated locally with
 * `npm run download-static` when the transit layer is actually needed.
 *
 * Paths are relative to the app root.
 */
const EXCLUDE_DIRS = new Set([
    'data/static-gtfs/gtfs-extracted',
    'data/static-gtfs/gtfs-nl',
    'data/static-gtfs/gtfs-zuidas',
    'data/static-gtfs/gtfs-zuidas-2025-12-15',
    'data/static-gtfs/gtfs-zuidas-2025-12-17',
    'data/static-gtfs/snapshots',
]);

/**
 * Individual files excluded from the bundle.
 *
 * The 237-268 MB legacy GLBs are not loaded by the app (`LARGE_MODEL_CONFIG`
 * pins `modelPaths` to the small export), and the GTFS zip is a 261 MB archive
 * the static site never opens.
 */
const EXCLUDE_FILES = new Set([
    'data/static-gtfs/gtfs-nl.zip',
    'models/250808_Datamodel Zuidas_SortByEnshan.glb',
    'models/250808_Datamodel Zuidas_SortByEnshan_final.glb',
    'models/250808_Datamodel Zuidas_SortByEnshan_noTrees.glb',
    'models/250808_Datamodel Zuidas_SortByEnshan_compressed.glb',
    'models/250808_Datamodel Zuidas_SortByEnshan_optimized.glb',
]);

/** Root-level files copied into the bundle. */
const COPY_FILES = [
    'index.html',
    'main.js',
    // Favicons. Listed explicitly because this is an allowlist: anything not
    // named here is silently left out of the deployed site, which is how the tab
    // icon would go missing while working locally.
    'favicon.svg',
    'favicon-32.png',
    'favicon-192.png',
    'favicon-512.png',
    'apple-touch-icon.png',
];

/**
 * Files resolved through symlinks rather than copied as links.
 *
 * `data` and `models` are symlinks in the working tree. Committing or deploying
 * a symlink would publish a path that only resolves on this machine, so the
 * link is followed and its contents are copied.
 */
async function isSymlink(p) {
    try {
        return (await stat(p)).isSymbolicLink?.() ?? false;
    } catch {
        return false;
    }
}

/**
 * Rewrite relative `import`/`export` specifiers in a JS file to carry a version
 * query, so a deploy cannot leave a visitor on a stale module graph.
 *
 * ## The problem this solves, and why stamping only `index.html` was not enough
 *
 * The app's JavaScript is served with `cache-control: max-age=3600`. Browsers
 * apply that to ES module fetches, and they key the module registry by resolved
 * URL. So:
 *
 *   1. A visitor loads the site and caches `src/caseStudies.js`.
 *   2. A deploy adds a new export to that file and adds a consumer of it.
 *   3. The visitor returns within the hour. `index.html` is re-fetched, but
 *      `caseStudies.js` comes from cache, so the consumer's import fails with
 *      "does not provide an export named …" and the app never boots.
 *
 * Stamping the entry point alone does not help, because `main.js` imports its
 * dependencies by plain path: the cache-busting stops at the first hop.
 *
 * So every relative specifier gets the same query. A non-relative specifier (a
 * bare package name, or a URL) is left alone — those are either resolved by an
 * import map with its own caching story, or served by someone else.
 *
 * ## Why the version is repeated in every file rather than defined once
 *
 * A module cannot know its own query string: `import.meta.url` carries it, but
 * imports are resolved statically, before any code runs. So the value has to be
 * written in literally wherever a specifier appears, which is what this does.
 *
 * @param {string} code
 * @param {string} version
 * @returns {{code: string, rewritten: number}}
 */
function versionModuleSpecifiers(code, version) {
    let rewritten = 0;

    // Matches `from './x.js'`, `from "../lib/x.js"`, and `import('./x.js')`.
    // Deliberately narrow: only relative specifiers ending in `.js`, which is
    // every import in this app, so a bare specifier or an already-versioned URL
    // cannot be mangled by a broad pattern.
    const pattern = /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+\.js)\2/g;

    const output = code.replace(pattern, (match, lead, quote, spec) => {
        // A specifier that already carries a query is left as it is: the build
        // should be idempotent, and double-stamping would produce a URL that
        // changes on every run.
        if (spec.includes('?')) return match;
        rewritten += 1;
        return `${lead}${quote}${spec}?v=${version}${quote}`;
    });

    return { code: output, rewritten };
}

/**
 * Copy the app's JavaScript, versioning every relative import specifier.
 *
 * @param {string} from
 * @param {string} to
 * @param {string} version
 * @returns {Promise<number>} Specifiers rewritten.
 */
async function copyVersionedJs(from, to, version) {
    const code = await fs.readFile(from, 'utf8');
    const { code: stamped, rewritten } = versionModuleSpecifiers(code, version);
    await fs.writeFile(to, stamped, 'utf8');
    return rewritten;
}

/**
 * Copy `index.html`, replacing the module-cache stamp with the build time.
 *
 * Pairs with {@link versionModuleSpecifiers}: this stamps the entry point, and
 * that stamps everything the entry point reaches. Both are needed. Without this
 * one, the browser reuses the cached `main.js` and nothing below it is even
 * requested; without that one, `main.js` loads but its dependencies come from
 * the cache.
 *
 * @param {string} from
 * @param {string} to
 * @param {string} version
 */
async function writeStampedHtml(from, to, version) {
    const html = await fs.readFile(from, 'utf8');
    if (!html.includes('__BUILD_V__')) {
        // Not an error: an unstamped source still deploys, it just keeps the
        // caching behaviour. Worth a warning because it is almost certainly not
        // what the person building intends.
        console.warn('[deploy] index.html has no __BUILD_V__ placeholder; module caching will not be busted.');
        await copyFile(from, to);
        return;
    }
    await fs.writeFile(to, html.replaceAll('__BUILD_V__', version), 'utf8');
}

async function main() {
    if (!existsSync(path.join(APP_ROOT, 'index.html'))) {
        console.error(`[deploy] No index.html in ${APP_ROOT}; run from the app root.`);
        process.exit(1);
    }

    const copied = { files: 0, bytes: 0 };
    const skipped = [];
    /** Specifiers rewritten across the whole build, reported at the end. */
    let versionedSpecifiers = 0;

    /**
     * Copy a tree into the bundle.
     *
     * `version` is threaded through rather than read from a module-scope
     * variable so it is impossible to copy a JS file with the wrong stamp: the
     * caller has to have the version in hand to recurse.
     *
     * @param {string} from
     * @param {string} to
     * @param {string} [relBase] Path relative to the app root, for exclusions.
     * @param {string} [version] Module cache version, when rewriting JS.
     */
    async function copyTree(from, to, relBase = '', version = '') {
        const entries = await readdir(from, { withFileTypes: true });
        await mkdir(to, { recursive: true });
        for (const entry of entries) {
            const src = path.join(from, entry.name);
            const dst = path.join(to, entry.name);
            const rel = relBase ? `${relBase}/${entry.name}` : entry.name;

            // Skip local scratch and caches that should never be published.
            if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
            if (entry.name.startsWith('.')) continue;
            if (EXCLUDE_DIRS.has(rel) || EXCLUDE_FILES.has(rel)) {
                skipped.push(rel);
                continue;
            }

            // `data` and `models` are symlinks; resolve them so the published
            // bundle contains real files.
            let real = src;
            try {
                real = await fs.realpath(src);
            } catch {
                continue; // dangling link
            }

            const info = await stat(real);
            if (info.isDirectory()) {
                await copyTree(real, dst, rel, version);
            } else {
                if (DRY_RUN) {
                    copied.files += 1;
                    copied.bytes += info.size;
                    continue;
                }
                // Only the app's own source is rewritten. `framework/` holds
                // Markdown and PDFs, and `models/` holds GLBs: neither is an ES
                // module, and rewriting a specifier pattern inside them would
                // corrupt the asset rather than version it.
                if (version && rel.startsWith('src/') && entry.name.endsWith('.js')) {
                    versionedSpecifiers += await copyVersionedJs(real, dst, version);
                } else {
                    await copyFile(real, dst);
                }
                copied.files += 1;
                copied.bytes += info.size;
            }
        }
    }

    if (!DRY_RUN) {
        // Wipe, so removed source files cannot linger in the published bundle.
        await rm(OUT, { recursive: true, force: true });
        await mkdir(OUT, { recursive: true });
    }

    // One version for the whole build: the entry point and every specifier in
    // the graph must agree, or a module could be fetched twice under two URLs
    // and hold two copies of the same state.
    const version = String(Date.now());

    for (const dir of COPY_DIRS) {
        const from = path.join(APP_ROOT, dir);
        if (!existsSync(from)) {
            console.warn(`[deploy] skipping missing directory: ${dir}`);
            continue;
        }
        await copyTree(from, path.join(OUT, dir), dir, version);
        console.log(`[deploy] dir   ${dir}/`);
    }

    for (const file of COPY_FILES) {
        const from = path.join(APP_ROOT, file);
        if (!existsSync(from)) {
            console.warn(`[deploy] skipping missing file: ${file}`);
            continue;
        }
        if (DRY_RUN) {
            copied.files += 1;
            copied.bytes += info.size;
            console.log(`[deploy] file  ${file}`);
            continue;
        }
        if (file === 'index.html') {
            await writeStampedHtml(from, path.join(OUT, file), version);
        } else if (file.endsWith('.js')) {
            // The entry point has to be versioned too, and it is easy to miss
            // because it is copied here rather than through `copyTree`. Missing
            // it is not a cosmetic bug: `index.html` would request
            // `main.js?v=N` while `main.js` itself imported plain paths, so its
            // dependencies would be fetched at *unversioned* URLs and load a
            // second time as separate module instances. Two copies of
            // `cesiumViewer.js` means two `viewer` variables, and the app dies
            // with "Viewer not initialized" — from a file whose import lines
            // look completely ordinary.
            versionedSpecifiers += await copyVersionedJs(from, path.join(OUT, file), version);
        } else {
            await copyFile(from, path.join(OUT, file));
        }
        copied.files += 1;
        copied.bytes += (await stat(from)).size;
        console.log(`[deploy] file  ${file}`);
    }

    if (!DRY_RUN) {
        console.log(`[deploy] module cache version: ${version} (${versionedSpecifiers} specifiers rewritten)`);
    }

    const mb = (copied.bytes / 1048576).toFixed(1);
    console.log(
        `[deploy] ${DRY_RUN ? 'Would copy' : 'Copied'} ${copied.files} files (${mb} MB) -> firebase-deploy/`
    );
    if (skipped.length) {
        console.log(`[deploy] Excluded ${skipped.length} large path(s) not needed by the static site:`);
        skipped.forEach((s) => console.log(`[deploy]   - ${s}`));
    }
    if (!DRY_RUN) {
        console.log('[deploy] Deploy with: npx firebase deploy --only hosting');
    }
}

main().catch((error) => {
    console.error('[deploy] Build failed:', error);
    process.exit(1);
});
