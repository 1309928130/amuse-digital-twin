/**
 * The visual-quality index shown on the Visual quality page.
 *
 * ## What this is, honestly
 *
 * A **placeholder** index. The terms are named, the weights are adjustable, and
 * the arithmetic is real -- but the weights are not calibrated against anything
 * and the terms are not all measured yet. It exists so the structure of the
 * intended index is visible and can be argued with, which is more useful at this
 * stage than a number that pretends to be a result.
 *
 * The panel says so in as many words. Presenting invented weights as a
 * calibrated score would be the most misleading thing this page could do, so the
 * formula is labelled as a placeholder wherever it appears.
 *
 * ## The terms
 *
 * Chosen because they are the ones the visual-quality literature keeps
 * returning to and because each is measurable from data the project has or plans
 * to have:
 *
 *  - **pedestrians** -- other people in view. The only term measured live, by
 *    `pedestrianDetector.js` running on the rendered frame.
 *  - **greenery** -- visible vegetation. Not measured yet; the reviewer plans to
 *    colour elements in the 3D model so this reduces to counting pixels of a
 *    known colour, which is exact where a detector would be a guess.
 *  - **sky view** -- the sky view factor, a standard urban-climate measure.
 *  - **façade articulation** -- how much detail the street wall presents, which
 *    Ewing & Handy single out among the design qualities that relate to
 *    walkability.
 *  - **enclosure** -- the sense of a defined street space, related to the
 *    height-to-width ratio.
 *
 * ## Shape of the function
 *
 * A weighted sum, kept linear and explicit rather than hidden behind a scoring
 * service, so a reader can see exactly what moves the number. Terms are
 * normalised to 0..1 before weighting so the weights are comparable; a term that
 * saturates is clamped rather than allowed to run away.
 */

import { detectInView, renderedAgentCount, loadModel, isModelReady } from './pedestrianDetector.js';
import { applyCameraPreset } from './cameraPresets.js';

/**
 * The index terms, their default weights, and how each is described.
 *
 * `measured` records whether a term currently has a real input. Terms that are
 * not measured are held at a neutral placeholder so the formula still evaluates,
 * and the read-out marks them so nobody mistakes a default for a measurement.
 */
const TERMS = [
    {
        id: 'pedestrians',
        label: 'Other pedestrians',
        symbol: 'P',
        weight: 0.20,
        measured: true,
        help: 'People detected in the current view, normalised against a full street.',
    },
    {
        id: 'greenery',
        label: 'Greenery',
        symbol: 'G',
        weight: 0.25,
        measured: false,
        help: 'Visible vegetation. Not measured yet — planned as a colour mask on the 3D model.',
    },
    {
        id: 'sky',
        label: 'Sky view',
        symbol: 'S',
        weight: 0.20,
        measured: false,
        help: 'Sky view factor. Not measured yet.',
    },
    {
        id: 'facade',
        label: 'Façade articulation',
        symbol: 'F',
        weight: 0.20,
        measured: false,
        help: 'Detail along the street wall. Not measured yet.',
    },
    {
        id: 'enclosure',
        label: 'Enclosure',
        symbol: 'E',
        weight: 0.15,
        measured: false,
        help: 'Definition of the street space. Not measured yet.',
    },
];

/**
 * Detection cadence, in milliseconds.
 *
 * Deliberately not every frame. Inference costs a few hundred milliseconds on
 * the CPU, and running continuously would make the scene itself stutter -- a
 * metric that degrades the thing it measures is not worth having. About one
 * update per second reads as live while leaving the renderer alone.
 */
const DETECT_INTERVAL_MS = 1000;

/**
 * The pedestrian count that saturates the pedestrian term.
 *
 * A busier-than-this view does not score higher, which stops a crowd scene from
 * dominating the index. Chosen to suit a street-level view of the simulated
 * area; it is part of the placeholder, not a finding.
 */
const PEDESTRIAN_SATURATION = 25;

/** Neutral value used for terms that are not measured, so they do not skew the sum. */
const UNMEASURED_NEUTRAL = 0.5;

let running = false;
let detectTimer = null;
let wired = false;
let lastDetection = null;

/** Current weight per term id, so the sliders and the read-out share one source. */
const weights = new Map(TERMS.map((t) => [t.id, t.weight]));

/** Latest normalised value per term id. */
const values = new Map(TERMS.map((t) => [t.id, UNMEASURED_NEUTRAL]));

/**
 * Render the formula with the live values substituted.
 *
 * Written as an explicit string rather than built from a maths library, because
 * the point is that a reader can check it by eye -- it has to survive being
 * screenshotted into a report.
 */
function renderFormula() {
    const el = document.getElementById('vqFormula');
    if (!el) return;

    const lines = [`VQ = ${TERMS.map((t) => `${t.weight.toFixed(2)}·${t.symbol}`).join(' + ')}`, ''];

    for (const t of TERMS) {
        const v = values.get(t.id);
        const w = weights.get(t.id);
        const shown = Number.isFinite(v) ? v.toFixed(2) : '–';
        // Unmeasured terms are marked so a default cannot be read as a result.
        const mark = t.measured ? '' : '  ← default';
        lines.push(`${t.symbol} = ${shown}  (${t.label})${mark}`);
    }

    const index = computeIndex();
    lines.push('', `VQ = ${index === null ? '–' : index.toFixed(3)}`);
    el.textContent = lines.join('\n');
}

/**
 * Evaluate the weighted sum.
 *
 * @returns {number|null} The index, or null when no term is measured yet.
 */
function computeIndex() {
    let sum = 0;
    let weightSum = 0;
    for (const t of TERMS) {
        const w = weights.get(t.id) || 0;
        const v = values.get(t.id);
        sum += w * (Number.isFinite(v) ? v : UNMEASURED_NEUTRAL);
        weightSum += w;
    }
    if (weightSum <= 0) return null;
    // Normalised by the total weight so the index stays comparable when a reader
    // drags the sliders: otherwise turning every weight down would look like a
    // worse street.
    return sum / weightSum;
}

/** Update the index read-out. */
function renderIndex() {
    const el = document.getElementById('vqIndexValue');
    if (!el) return;
    const index = computeIndex();
    el.textContent = index === null ? '–' : `${index.toFixed(3)} (placeholder)`;
}

/** Build the weight sliders once, from `TERMS`. */
function buildWeightControls() {
    const host = document.getElementById('vqWeightControls');
    if (!host || host.dataset.built === '1') return;
    host.dataset.built = '1';

    host.innerHTML = TERMS.map((t) => `
        <div style="margin:6px 0;">
            <div style="display:flex;justify-content:space-between;font-size:11px;opacity:0.85;">
                <span>${t.symbol} — ${t.label}</span>
                <span id="vqW_${t.id}_val" style="font-variant-numeric:tabular-nums;">${t.weight.toFixed(2)}</span>
            </div>
            <input type="range" id="vqW_${t.id}" min="0" max="1" step="0.05" value="${t.weight}"
                   style="width:100%;margin-top:2px;">
            <div class="param-help" style="font-size:10px;">${t.help}</div>
        </div>
    `).join('');

    for (const t of TERMS) {
        const input = document.getElementById(`vqW_${t.id}`);
        const out = document.getElementById(`vqW_${t.id}_val`);
        if (!input) continue;
        input.addEventListener('input', () => {
            const w = Number(input.value);
            weights.set(t.id, w);
            if (out) out.textContent = w.toFixed(2);
            renderFormula();
            renderIndex();
        });
    }
}

/**
 * Run one detection pass and update the read-out.
 *
 * @returns {Promise<Object|null>} The detection result, or null on failure.
 */
async function runDetection() {
    const status = document.getElementById('vqDetectStatus');
    try {
        const result = await detectInView();
        if (!result) {
            if (status) status.textContent = 'Could not read the rendered frame.';
            return null;
        }
        lastDetection = result;

        const detected = document.getElementById('vqDetectedCount');
        const rendered = document.getElementById('vqRenderedCount');
        const timing = document.getElementById('vqInferenceMs');
        if (detected) detected.textContent = String(result.count);
        if (rendered) rendered.textContent = String(renderedAgentCount());
        if (timing) timing.textContent = `${Math.round(result.ms)} ms · ${result.fps.toFixed(1)} fps`;

        // The pedestrian term is the fraction of the saturation level, clamped.
        values.set('pedestrians', Math.min(1, result.count / PEDESTRIAN_SATURATION));
        renderFormula();
        renderIndex();

        drawPreview(result);
        return result;
    } catch (error) {
        // Surfaced in the panel rather than only the console: on a deployed site
        // the console is not somewhere a supervisor will look.
        if (status) status.textContent = `Detection unavailable: ${error.message}`;
        return null;
    }
}

/**
 * Draw the detected boxes over a thumbnail of the frame that produced them.
 *
 * A count on its own is hard to trust -- a reader cannot tell a missed figure
 * from a correct zero. The thumbnail makes the result checkable at a glance.
 *
 * @param {Object} result Detection result.
 */
function drawPreview(result) {
    const canvas = document.getElementById('vqDetectPreview');
    if (!canvas || !result.frame) return;

    const { data, width, height } = result.frame;
    // The frame is already the model's square input, so the preview is drawn at
    // the same aspect and the stored boxes map onto it without rescaling.
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const offCtx = off.getContext('2d');
    offCtx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(off, 0, 0);

    ctx.strokeStyle = '#FFD54F';
    ctx.lineWidth = 2;
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#FFD54F';
    for (const det of result.detections) {
        const [x1, y1, x2, y2] = det.box;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.fillText(det.score.toFixed(2), x1 + 2, Math.max(10, y1 - 2));
    }
    canvas.style.display = 'block';
}

/** Start the detection loop. */
async function start() {
    if (running) return;
    const status = document.getElementById('vqDetectStatus');
    const toggle = document.getElementById('vqDetectToggle');
    const readout = document.getElementById('vqDetectReadout');

    running = true;
    if (toggle) toggle.textContent = 'Stop counting';
    if (status) {
        status.textContent = isModelReady()
            ? 'Running.'
            : 'Loading the detection model — the first run downloads about 4 MB.';
    }

    // The model load is awaited explicitly so a failure is reported before the
    // loop starts, rather than as a rejected promise inside a timer.
    try {
        await loadModel();
    } catch (error) {
        running = false;
        if (toggle) toggle.textContent = 'Start counting';
        if (status) status.textContent = `Detection unavailable: ${error.message}`;
        return;
    }

    if (!running) return;
    if (readout) readout.style.display = 'block';
    if (status) status.textContent = 'Running — counts update about once a second.';

    await runDetection();
    detectTimer = window.setInterval(() => {
        if (!running) return;
        runDetection();
    }, DETECT_INTERVAL_MS);
}

/** Stop the detection loop. */
function stop() {
    running = false;
    if (detectTimer !== null) {
        window.clearInterval(detectTimer);
        detectTimer = null;
    }
    const toggle = document.getElementById('vqDetectToggle');
    const status = document.getElementById('vqDetectStatus');
    if (toggle) toggle.textContent = 'Start counting';
    if (status) {
        status.textContent = lastDetection
            ? `Stopped. Last count: ${lastDetection.count} in view.`
            : 'Not running.';
    }
}

/**
 * Wire the controls and paint the initial state.
 *
 * Called when the Visual quality page is shown.
 */
export function initVisualQualityIndex() {
    buildWeightControls();
    if (!wired) {
        wired = true;
        const toggle = document.getElementById('vqDetectToggle');
        const eye = document.getElementById('vqDetectEye');
        if (toggle) toggle.addEventListener('click', () => (running ? stop() : start()));
        if (eye) eye.addEventListener('click', () => applyCameraPreset('eye-level'));
    }
    renderFormula();
    renderIndex();
}

/**
 * Stop detection when leaving the page.
 *
 * Detection competes with the renderer for the same hardware, so it must not
 * keep running behind a page that no longer shows its output.
 */
export function disposeVisualQualityIndex() {
    if (running) stop();
}

/** Whether the counter is currently running, for tests and diagnostics. */
export function isCounting() {
    return running;
}
