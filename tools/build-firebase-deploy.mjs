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
const COPY_FILES = ['index.html', 'main.js'];

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

async function main() {
    if (!existsSync(path.join(APP_ROOT, 'index.html'))) {
        console.error(`[deploy] No index.html in ${APP_ROOT}; run from the app root.`);
        process.exit(1);
    }

    const copied = { files: 0, bytes: 0 };
    const skipped = [];

    async function copyTree(from, to, relBase = '') {
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
                await copyTree(real, dst, rel);
            } else {
                if (DRY_RUN) {
                    copied.files += 1;
                    copied.bytes += info.size;
                    continue;
                }
                await copyFile(real, dst);
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

    for (const dir of COPY_DIRS) {
        const from = path.join(APP_ROOT, dir);
        if (!existsSync(from)) {
            console.warn(`[deploy] skipping missing directory: ${dir}`);
            continue;
        }
        await copyTree(from, path.join(OUT, dir), dir);
        console.log(`[deploy] dir   ${dir}/`);
    }

    for (const file of COPY_FILES) {
        const from = path.join(APP_ROOT, file);
        if (!existsSync(from)) {
            console.warn(`[deploy] skipping missing file: ${file}`);
            continue;
        }
        if (!DRY_RUN) await copyFile(from, path.join(OUT, file));
        copied.files += 1;
        copied.bytes += (await stat(from)).size;
        console.log(`[deploy] file  ${file}`);
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
