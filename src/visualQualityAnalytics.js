/**
 * Floating analytics overlay for the visual-quality page.
 *
 * ## What floats, and what does not
 *
 * The numbers are floating cards. The detections are **not** drawn as a picture
 * of the frame that was analysed: that frame is a second, second-stale copy of
 * the render, so showing it puts a duplicate scene view in front of the scene.
 * Instead each detected box is mapped back through the same stretch the detector
 * applied and drawn onto a transparent layer covering the live view, so a box
 * sits on the person it found while that person is still walking.
 *
 * Everything is translucent, and the overlay ignores pointer events entirely, so
 * the globe stays pannable and clickable underneath.
 *
 * ## What it shows
 *
 *  - boxes on the people detected in the current view;
 *  - the count, the number of agents the simulation is drawing, and the gap;
 *  - the visual-quality index and its terms, weighted and evaluated live.
 */

import { detectInView, renderedAgentCount, loadModel, isModelReady } from './pedestrianDetector.js';
import { getViewer } from './cesiumViewer.js';
import {
    getVisualQualityTerms,
    getVisualQualityIndex,
    setDetectedPedestrians,
} from './visualQualityIndex.js';

/**
 * How often the analytics run, in milliseconds.
 *
 * About one pass per second. Detection costs roughly 230 ms on the CPU, so
 * running it per animation frame would halve the scene's frame rate for a number
 * that only needs to be roughly current.
 */
const ANALYTICS_INTERVAL_MS = 1000;

let rootEl = null;
let boxLayer = null;
let running = false;
let timer = null;
let lastResult = null;
let resizeBound = false;

/** Rolling history of the detected count, drawn as a sparkline. */
const history = [];
const MAX_HISTORY = 60;

/**
 * Build the overlay's markup once.
 *
 * Four free-floating clusters rather than one panel, so the live scene shows
 * through the gaps between them and no single rectangle covers the view. Each is
 * positioned at a corner or edge that the page's other furniture leaves free.
 */
function build() {
    if (!rootEl) return;
    rootEl.innerHTML = `
        <!--
            Detection boxes, drawn straight onto a transparent canvas that covers
            the scene. The analysed frame is *not* shown: it is a second copy of
            the view, one second stale, and a duplicate of the render is exactly
            the wrong thing to put in front of the render. The boxes are mapped
            back onto the live view instead, so a box sits on the person it
            detected.
        -->
        <canvas class="vq-box-layer" id="vqBoxLayer"></canvas>

        <!--
            One card, foldable.

            The counts and the index were two cards in opposite corners, which
            split a single reading across the screen: the index is the summary of
            the counts, and having to look in two places to connect them was work
            the reader should not have to do. The header folds the whole thing
            away, which is what makes it acceptable to keep it on screen while
            looking at the scene.
        -->
        <div class="vq-float vq-float-stats" id="vqA_card">
            <div class="vq-float-title vq-fold-head" id="vqA_foldHead" role="button" tabindex="0"
                 aria-expanded="true" aria-controls="vqA_cardBody">
                <span>Eye-level visual quality</span><span class="vq-fold-chevron">▶</span>
            </div>
            <div class="vq-fold-body" id="vqA_cardBody">
            <div class="vq-stat">
                <span class="vq-stat-label">People detected</span>
                <span class="vq-stat-value" id="vqA_count">–</span>
            </div>
            <div class="vq-stat">
                <span class="vq-stat-label">Agents drawn</span>
                <span class="vq-stat-value vq-muted" id="vqA_rendered">–</span>
            </div>
            <div class="vq-stat">
                <span class="vq-stat-label">Inference</span>
                <span class="vq-stat-value vq-muted" id="vqA_timing">–</span>
            </div>
            <div class="vq-spark">
                <div class="vq-stat-label">Last minute</div>
                <svg viewBox="0 0 240 40" preserveAspectRatio="none"
                     style="width:100%;height:36px;display:block;" aria-hidden="true">
                    <polyline id="vqA_sparkLine" fill="none" stroke="#FFD54F" stroke-width="1.5"
                              points=""></polyline>
                </svg>
            </div>

            <div class="vq-card-divider"></div>

            <div class="vq-float-title vq-small">Visual-quality index</div>
            <div class="vq-formula" id="vqA_formula"></div>
            <div class="vq-index-row">
                <span class="vq-stat-label">Index</span>
                <!--
                    Two values, deliberately. The large one is the live index; the
                    muted one is what the same weights produce with every term at
                    its neutral default. The gap between them is how much of the
                    reading comes from the one measured term versus the placeholder
                    assumptions, which is the honest way to show a partly-measured
                    index.
                -->
                <span>
                    <span class="vq-stat-value" id="vqA_index">–</span>
                    <span class="vq-index-baseline" id="vqIndexValue">–</span>
                </span>
            </div>
            <div class="vq-analytics-note">
                Weights are placeholders. Terms marked <b>default</b> are not measured,
                so the index is a structure to argue with, not a result.
            </div>
            </div>
        </div>

        <!-- Transient status: model load, or a failure. Empty and hidden at rest. -->
        <div class="vq-float vq-float-status" id="vqAnalyticsIdle"></div>
    `;
    boxLayer = document.getElementById('vqBoxLayer');
    // A resized viewport invalidates the last set of boxes, since they are in
    // screen coordinates. Cleared rather than rescaled: the next pass is at most
    // a second away, and a stretched box on the wrong person is worse than none.
    if (!resizeBound) {
        resizeBound = true;
        window.addEventListener('resize', clearBoxes);
    }
    wireFold();
}

/**
 * Make the card header fold its body.
 *
 * The state is kept in memory rather than in sessionStorage, unlike the panel
 * folds: this is a view of the scene, and a reader who collapsed it on one visit
 * is not asking for it collapsed on the next. It also returns to expanded on
 * every page entry, which is the state that shows the measurement.
 */
function wireFold() {
    const head = document.getElementById('vqA_foldHead');
    const body = document.getElementById('vqA_cardBody');
    if (!head || !body || head.dataset.vqFoldWired) return;
    head.dataset.vqFoldWired = '1';

    const setOpen = (open) => {
        body.style.display = open ? '' : 'none';
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        head.classList.toggle('vq-folded', !open);
    };
    const toggle = () => setOpen(head.getAttribute('aria-expanded') !== 'true');

    head.addEventListener('click', toggle);
    // Keyboard-operable, since the header is a control rather than decoration.
    head.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();
        toggle();
    });
}

/** Show the floating overlay. */
export function openVisualQualityAnalytics() {
    if (!rootEl) return;
    rootEl.hidden = false;
    build();
    renderStats();
}

/** Hide the overlay, stopping the loop. */
export function closeVisualQualityAnalytics() {
    stop();
    if (!rootEl) return;
    rootEl.hidden = true;
}

/** Whether the analytics loop is running. */
export function isAnalyticsRunning() {
    return running;
}

/**
 * Start the analytics, unless already running.
 *
 * Idempotent, so the page controller can call it on open without checking first.
 * That is what makes the analysis on by default: opening the page starts it, and
 * the button is there to switch it off rather than to switch it on.
 */
export async function startVisualQualityAnalytics() {
    if (running) return;
    await start();
}

/**
 * Start the loop, or stop it if already running.
 *
 * @returns {boolean} The new running state.
 */
export async function toggleVisualQualityAnalytics() {
    if (running) {
        stop();
        return false;
    }
    await start();
    return running;
}

/** Start detecting on an interval. */
async function start() {
    if (!rootEl) return;
    const status = document.getElementById('vqAnalyticsIdle');

    // Awaited before the loop begins, so a model-load failure is reported once
    // rather than as a rejected promise inside every tick.
    if (!isModelReady()) {
        setStatus(status, 'Loading the detection model — about 4 MB, once per session.');
    }
    try {
        await loadModel();
    } catch (error) {
        setStatus(status, `Detection unavailable: ${error.message}`);
        return;
    }

    running = true;
    setStatus(status, '');
    syncButton();
    await tick();
    timer = window.setInterval(() => {
        if (!running) return;
        tick();
    }, ANALYTICS_INTERVAL_MS);
}

/** Stop the loop, keeping the last readings on screen so the result is still readable. */
function stop() {
    running = false;
    if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
    }
    // Boxes go, the numbers stay. A box is a claim about where a person is *now*;
    // frozen, it would drift off the person within a second and start lying,
    // whereas the last count is still a true statement about the last sample.
    clearBoxes();
    syncButton();
}

/**
 * Run one pass and redraw.
 *
 * Errors are surfaced in the overlay rather than only logged: on a deployed site
 * the console is not somewhere a supervisor will look, and a silently frozen
 * count is worse than a visible failure.
 */
async function tick() {
    const status = document.getElementById('vqAnalyticsIdle');
    try {
        const result = await detectInView();
        if (!result) {
            setStatus(status, 'Could not read the rendered frame.');
            return;
        }
        lastResult = result;
        history.push(result.count);
        if (history.length > MAX_HISTORY) history.shift();
        // Pushed into the index so the formula evaluates the same count drawn on
        // the frame beside it. Without this the two would disagree in the one
        // place a reader compares them.
        setDetectedPedestrians(result.count);
        setStatus(status, '');
        // Boxes are redrawn every pass, so they track the people as they walk
        // rather than lingering where they were when the frame was grabbed.
        drawBoxes(result);
        drawSparkline();
        renderStats();
    } catch (error) {
        setStatus(status, `Detection failed: ${error.message}`);
        stop();
    }
}

/** Write or clear the transient status line. */
function setStatus(el, text) {
    if (!el) return;
    el.textContent = text || '';
    el.style.display = text ? '' : 'none';
}

/**
 * Draw the detection boxes straight onto the scene.
 *
 * The detector inverts its own letterbox before returning, so boxes arrive in
 * scene-canvas pixels and only need backing-store-to-CSS scaling. That is why the
 * frame is not shown -- the boxes are placed on the live render, and a faded copy
 * of the render underneath them would be a second, second-stale instance of the
 * same picture.
 *
 * @param {Object} result Detection result, in scene-canvas pixel coordinates.
 */
function drawBoxes(result) {
    const viewer = getViewer();
    const source = viewer && viewer.scene && viewer.scene.canvas;
    if (!boxLayer || !source || !source.clientWidth) return;

    const w = source.clientWidth;
    const h = source.clientHeight;
    // Backing store matched to CSS pixels so the one-pixel box strokes stay crisp
    // rather than being resampled by the compositor.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (boxLayer.width !== Math.round(w * dpr) || boxLayer.height !== Math.round(h * dpr)) {
        boxLayer.width = Math.round(w * dpr);
        boxLayer.height = Math.round(h * dpr);
        boxLayer.style.width = `${w}px`;
        boxLayer.style.height = `${h}px`;
    }

    const ctx = boxLayer.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!result.detections.length) return;

    // Boxes arrive in *canvas backing-store pixels* (the detector inverts its own
    // letterbox), so the only correction left is backing store to CSS pixels.
    // This used to divide by FRAME_SIZE, which was correct while the frame was
    // stretched to a square; with letterboxing in place that would place every
    // box in the wrong spot.
    const sx = source.clientWidth / source.width;
    const sy = source.clientHeight / source.height;

    ctx.lineWidth = 2;
    ctx.font = '600 13px sans-serif';
    ctx.textBaseline = 'middle';
    for (const det of result.detections) {
        const [x1, y1, x2, y2] = det.box;
        const bx = x1 * sx;
        const by = y1 * sy;
        const bw = (x2 - x1) * sx;
        const bh = (y2 - y1) * sy;

        // A dark halo under the stroke keeps it legible over a bright façade or
        // a pale sky without needing an opaque plate.
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 4;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.strokeStyle = '#FFD54F';
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, bw, bh);

        // The score is drawn just *above* the box, not inside it. Inside, it sat
        // on the figure's head and made the box look like it started lower than
        // it does. Clamped to the viewport so a box at the top edge keeps its
        // label visible instead of having it clipped away.
        const label = det.score.toFixed(2);
        const tw = ctx.measureText(label).width;
        const labelY = Math.max(0, by - 18);
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(bx, labelY, tw + 10, 17);
        ctx.fillStyle = '#FFD54F';
        ctx.fillText(label, bx + 5, labelY + 9);
    }
}

/** Wipe the box layer, e.g. when the loop stops or the viewport changes. */
function clearBoxes() {
    if (!boxLayer) return;
    const ctx = boxLayer.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, boxLayer.width, boxLayer.height);
}

/** Redraw the count sparkline. */
function drawSparkline() {
    const line = document.getElementById('vqA_sparkLine');
    if (!line) return;
    if (history.length < 2) {
        line.setAttribute('points', '');
        return;
    }
    const max = Math.max(...history, 1);
    const stepX = 240 / (MAX_HISTORY - 1);
    // Right-aligned so the newest sample is always at the right edge, which keeps
    // the shape readable while the buffer is still filling.
    const offset = 240 - (history.length - 1) * stepX;
    const points = history.map((v, i) => {
        const x = offset + i * stepX;
        const y = 38 - (v / max) * 34;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    line.setAttribute('points', points.join(' '));
}

/** Write the numbers into the overlay. */
function renderStats() {
    const count = document.getElementById('vqA_count');
    const rendered = document.getElementById('vqA_rendered');
    const timing = document.getElementById('vqA_timing');
    const index = document.getElementById('vqA_index');
    const formula = document.getElementById('vqA_formula');

    if (count) count.textContent = lastResult ? String(lastResult.count) : '–';
    if (rendered) rendered.textContent = String(renderedAgentCount());
    if (timing) {
        timing.textContent = lastResult
            ? `${Math.round(lastResult.ms)} ms · ${lastResult.fps.toFixed(1)} fps`
            : '–';
    }
    const vq = getVisualQualityIndex();
    if (index) index.textContent = vq === null ? '–' : vq.toFixed(3);

    if (formula) {
        const terms = getVisualQualityTerms();
        formula.innerHTML = terms.map((t) => {
            const value = Number.isFinite(t.value) ? t.value.toFixed(2) : '–';
            const mark = t.measured ? '' : ' <span class="vq-tag">default</span>';
            return `<div class="vq-formula-row">
                <span class="vq-term">${t.weight.toFixed(2)}·${t.symbol}</span>
                <span class="vq-term-label">${escapeHtml(t.label)}</span>
                <span class="vq-term-value">${value}</span>${mark}
            </div>`;
        }).join('');
    }
}

/** Keep the panel button's label in step with the loop. */
function syncButton() {
    const btn = document.getElementById('vqDetectToggle');
    if (!btn) return;
    btn.textContent = running ? 'Stop eye-level analysis' : 'Analyse eye-level visual quality';
    btn.setAttribute('aria-pressed', running ? 'true' : 'false');
}

/**
 * Escape text for insertion into markup.
 *
 * @param {string} s Raw text.
 * @returns {string} Escaped text.
 */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

/**
 * Wire the overlay to the page.
 *
 * @param {string} rootId Id of the element that hosts the floating overlay.
 */
export function initializeVisualQualityAnalytics(rootId) {
    rootEl = document.getElementById(rootId);
    if (!rootEl) {
        console.warn(`[Visual Quality] Analytics host #${rootId} not found`);
        return;
    }
    build();
    // The overlay floats over the scene, so its on/off button lives in the right
    // panel and is wired here: the two modules would otherwise both own the same
    // element.
    const btn = document.getElementById('vqDetectToggle');
    if (btn && !btn.dataset.vqWired) {
        btn.dataset.vqWired = '1';
        btn.addEventListener('click', () => {
            toggleVisualQualityAnalytics();
        });
    }
    syncButton();
}
