#!/usr/bin/env node
/**
 * Capture the case-studies page snapshots.
 *
 * The case-studies page offers each assessment as a snapshot card, so visitors
 * can see what a page looks like before committing to it. Those snapshots have
 * to be regenerated whenever the viewer's look changes, or they quietly go
 * stale and advertise a layout that no longer exists.
 *
 * This drives a real browser over the DevTools Protocol, waits for each page's
 * layers to settle, and writes a PNG per assessment to
 * `cases/thumbs/<study>/`.
 *
 *   node tools/capture-page-thumbnails.mjs [--port 8080] [--width 1280] [--height 800] [--study proposal-1]
 *
 * Only pages that actually have data for the chosen study are captured, so a
 * proposal with no results writes nothing and its cards stay empty rather than
 * advertising another proposal's snapshots. Run it once per proposal as each
 * set of results lands.
 *
 * The viewer must already be running (`npm start`). Captures go to
 * `cases/thumbs/<study>/<page-id>.png`, which is where `getCaseStudyPages()` in
 * `src/pageConfig.js` looks for them.
 *
 * ## Why a browser and not a headless renderer
 *
 * The pages are Cesium scenes: the snapshot depends on the camera preset, the
 * loaded GLB, and asynchronous layer data. Rendering that outside a browser
 * would mean reimplementing the whole pipeline. Driving the real page also
 * means a page that fails to load produces a visibly broken thumbnail, which is
 * the useful outcome.
 *
 * ## Connecting
 *
 * Uses the Chrome DevTools Protocol over a WebSocket discovered from
 * `http://127.0.0.1:<port>/json`. Only Node built-ins are used, so there is
 * nothing to install.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', '8080'));
const WIDTH = Number(arg('width', '1280'));
const HEIGHT = Number(arg('height', '800'));
/** Proposal folder to write into; must match a PROPOSALS id in pageConfig.js. */
const STUDY = arg('study', 'proposal-1');
const OUT_DIR = path.join(APP_ROOT, 'cases/thumbs', STUDY);
const CDP_HOST = arg('cdp-host', '127.0.0.1');
const CDP_PORT = Number(arg('cdp-port', '9222'));

/** Pages to capture, in the order they appear on the case-studies page. */
const PAGE_IDS = [
    'flow-macro',
    'flow-micro',
    'sunlight',
    'wind',
    'noise',
    'pollution',
    'heat',
    'visibility',
    'visual-quality',
    'overlap',
];

/** How long to let a page settle before capturing (camera flight + layers). */
const SETTLE_MS = Number(arg('settle', '9000'));

/** Minimal CDP client. */
class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        ws.addEventListener('message', (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            }
        });
    }

    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`${method} timed out`));
                }
            }, 60000);
        });
    }

    /** Evaluate an expression in the page and return its value. */
    async eval(expression, awaitPromise = false) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
        });
        if (res.exceptionDetails) {
            throw new Error(res.exceptionDetails.text || 'page evaluation failed');
        }
        return res.result ? res.result.value : undefined;
    }
}

async function connect() {
    const listUrl = `http://${CDP_HOST}:${CDP_PORT}/json`;
    let targets;
    try {
        targets = await fetch(listUrl).then((r) => r.json());
    } catch (error) {
        throw new Error(
            `Could not reach the browser's DevTools endpoint at ${listUrl}.\n` +
                'Start Chrome/Edge with --remote-debugging-port=' +
                CDP_PORT +
                ', or pass --cdp-port for an existing session.'
        );
    }
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('No page target found in the browser.');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
            once: true,
        });
    });
    return new Cdp(ws);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    await mkdir(OUT_DIR, { recursive: true });

    const base = `http://localhost:${PORT}/`;
    console.log(`[thumbs] Viewer: ${base}`);
    console.log(`[thumbs] Study:  ${STUDY}`);
    console.log(`[thumbs] Output: ${path.relative(APP_ROOT, OUT_DIR)}/`);

    const cdp = await connect();

    // Fix the viewport so every thumbnail has the same aspect ratio, which the
    // grid's 16:10 cards rely on.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: WIDTH,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
    });

    // Load the app fresh, bypassing the HTTP cache so a stale bundle cannot
    // produce a stale thumbnail.
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Page.navigate', { url: `${base}?thumbs=${Date.now()}` });

    // Wait for the page controller to build the nav, which is the signal that
    // initialisation finished.
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const ready = await cdp.eval(
            "!!(document.getElementById('navButtons') && document.getElementById('navButtons').querySelectorAll('button').length > 5)"
        );
        if (ready) break;
        if (i === 59) throw new Error('Viewer did not finish initialising.');
    }
    console.log('[thumbs] Viewer ready.');

    // Put the picker on the requested proposal. Its snapshots are the ones
    // being captured; capturing under another proposal's selection would label
    // the images with the wrong study.
    const studyReady = await cdp.eval(`(() => {
        const state = document.getElementById('caseStudyState');
        return !!(state && (state.dataset.effective === ${JSON.stringify(STUDY)}));
    })()`);
    if (!studyReady) {
        console.warn(
            `[thumbs] Study "${STUDY}" is not the active study in this run, so the captured ` +
            'pages would not match. Serving one study at a time, this is expected for any ' +
            'proposal without data — nothing will be written.'
        );
        return;
    }

    // Hide the app chrome so the snapshot shows the scene and its data, not the
    // surrounding UI. This is presentation for the card, not a state change.
    await cdp.eval(`(() => {
        const style = document.createElement('style');
        style.id = '__thumb_capture';
        style.textContent = \`
            #topNav, #paramPanel, #caseStudies, #docView,
            .cesium-viewer-bottom, .cesium-viewer-animationContainer,
            .cesium-viewer-timelineContainer, .cesium-viewer-toolbar,
            .cesium-viewer-fullscreenContainer, .cesium-viewer-geocoderContainer,
            .draggable-panel { display: none !important; }
        \`;
        document.head.appendChild(style);
        return true;
    })()`);

    const captured = [];
    for (const id of PAGE_IDS) {
        const ok = await cdp.eval(
            `(() => {
                const btn = document.querySelector('#navButtons button[data-page="${id}"]');
                if (!btn) return false;
                btn.click();
                return true;
            })()`
        );
        if (!ok) {
            console.warn(`[thumbs] No nav button for "${id}", skipping.`);
            continue;
        }

        await sleep(SETTLE_MS);

        const shot = await cdp.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
        });
        const file = path.join(OUT_DIR, `${id}.png`);
        await writeFile(file, Buffer.from(shot.data, 'base64'));
        captured.push(id);
        console.log(`[thumbs] captured ${id}.png`);
    }

    // Remove the capture-only stylesheet so the viewer returns to normal.
    await cdp.eval("(() => { document.getElementById('__thumb_capture')?.remove(); return true; })()");

    console.log(`[thumbs] Done — ${captured.length} of ${PAGE_IDS.length} captured.`);
    const missing = PAGE_IDS.filter((id) => !captured.includes(id));
    if (missing.length) console.warn(`[thumbs] Not captured: ${missing.join(', ')}`);
}

main().catch((error) => {
    console.error('[thumbs] Capture failed:', error.message);
    process.exit(1);
});
