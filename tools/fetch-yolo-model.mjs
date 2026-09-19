#!/usr/bin/env node
/**
 * Fetch a YOLO ONNX model for the in-browser pedestrian counter.
 *
 * ## Why a separate download step
 *
 * The model is ~15 MB of binary. Committing it to git would bloat the repository
 * and its history irreversibly, and it is reproducible from a URL, so it is
 * fetched on demand and gitignored -- the same reasoning already applied to the
 * Zuidas GLB and the vendored GTFS snapshot.
 *
 * ## Which model
 *
 * `yolov5n` is the smallest of the YOLOv5 family: about 4 MB of weights against
 * 14 MB for `yolov5s`. The detector runs on the same GPU that is already drawing
 * the scene, so the smallest usable model is the right default -- a heavier one
 * buys accuracy on photographs that this task, counting flat-lit figures a few
 * metres away, does not need.
 *
 * The export is done through `ultralytics`' ONNX exporter with a fixed 640 px
 * input and no dynamic axes, because the post-processing in `pedestrianDetector.js`
 * assumes the `[1, 25200, 85]` layout that shape produces.
 *
 * Usage:
 *   node tools/fetch-yolo-model.mjs           # download if missing
 *   node tools/fetch-yolo-model.mjs --force   # re-download
 */

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../models/yolov5n-pedestrian.onnx');

/**
 * Candidate URLs, tried in order.
 *
 * The first is YOLOv5's own published ONNX export at the v7.0 tag -- the same
 * model the reviewer's `yolov5-deepsort-pedestrian-counting` fork uses, so the
 * browser counter and the Python count line up. Verified to exist; the
 * `ultralytics/assets` v8.x releases only carry YOLO11 exports, and the
 * ONNX Model Zoo path 404s, which is how the first attempt at this failed.
 */
const CANDIDATES = [
    'https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5n.onnx',
    'https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5s.onnx',
];

const force = process.argv.includes('--force');

async function exists(path) {
    try {
        const s = await stat(path);
        return s.size > 0;
    } catch {
        return false;
    }
}

async function main() {
    if (!force && (await exists(OUT))) {
        const s = await stat(OUT);
        console.log(`Model already present: ${OUT} (${(s.size / 1e6).toFixed(1)} MB)`);
        console.log('Pass --force to re-download.');
        return;
    }

    await mkdir(dirname(OUT), { recursive: true });

    for (const url of CANDIDATES) {
        process.stdout.write(`Trying ${url}\n`);
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (!res.ok) {
                console.log(`  -> HTTP ${res.status}, skipping`);
                continue;
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            // A redirect to an HTML error page would otherwise be written out as
            // a "model" and only fail much later, inside the browser.
            if (buffer.length < 1_000_000) {
                console.log(`  -> only ${buffer.length} bytes, not a model; skipping`);
                continue;
            }
            await writeFile(OUT, buffer);
            console.log(`  -> wrote ${(buffer.length / 1e6).toFixed(1)} MB to ${OUT}`);
            return;
        } catch (error) {
            console.log(`  -> ${error.message}`);
        }
    }

    console.error(
        '\nCould not download a model automatically.\n' +
        'Export one yourself with:\n' +
        '  pip install ultralytics\n' +
        '  yolo export model=yolov5n.pt format=onnx imgsz=640\n' +
        `then copy the .onnx to ${OUT}\n`
    );
    process.exitCode = 1;
}

main();
