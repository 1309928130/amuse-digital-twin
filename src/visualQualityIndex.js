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
const PEDESTRIAN_SATURATION = 25;

/** Neutral value used for terms that are not measured, so they do not skew the sum. */
const UNMEASURED_NEUTRAL = 0.5;

/**
 * Detection used to live here; it now lives in `visualQualityAnalytics.js`.
 *
 * The split follows the two different jobs. This module owns the *arithmetic* --
 * what the terms are, what they weigh, and what the sum comes to -- and knows
 * nothing about frames or cameras. The analytics module owns the *measurement*
 * and pushes a count in through `setDetectedPedestrians`. Keeping detection out
 * of here means the index can be exercised without a viewer, a canvas or a model,
 * and it is why the slider handlers below do not have to guard against the
 * detector having started.
 */

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

/**
 * The weighted mean with every term at its neutral default.
 *
 * Shown beside the live index so a reader can see how much of the reading comes
 * from the one measured term and how much from the placeholder assumptions. With
 * all weights equal it is just the neutral value, but it moves as the sliders do,
 * which is the point.
 *
 * @returns {number|null} The baseline, or null when no weight is non-zero.
 */
function computeBaseline() {
    let sum = 0;
    let total = 0;
    for (const t of TERMS) {
        const w = weights.get(t.id) || 0;
        if (w === 0) continue;
        total += Math.abs(w);
        sum += w * UNMEASURED_NEUTRAL;
    }
    return total === 0 ? null : sum / total;
}

/** Update the index read-out. */
function renderIndex() {
    const el = document.getElementById('vqIndexValue');
    if (!el) return;
    const baseline = computeBaseline();
    el.textContent = baseline === null ? '–' : baseline.toFixed(2);
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
 * Wire the sliders and paint the initial state.
 *
 * Called when the Visual quality page is shown. Detection is not started here:
 * it is driven by the centre-panel analytics, which owns the button.
 */
export function initVisualQualityIndex() {
    buildWeightControls();
    const eye = document.getElementById('vqDetectEye');
    if (eye && !eye.dataset.vqWired) {
        eye.dataset.vqWired = '1';
        eye.addEventListener('click', () => applyCameraPreset('eye-level'));
    }
    renderFormula();
    renderIndex();
}

/**
 * Nothing to tear down.
 *
 * The detection loop belongs to `visualQualityAnalytics.js`, which stops itself
 * when its overlay closes. Kept as a named export so the controller's page-change
 * branch stays symmetric with the other takeover pages.
 */
export function disposeVisualQualityIndex() {
    /* no-op: see above */
}

/** Whether the counter is currently running, for tests and diagnostics. */
export function isCounting() {
    return running;
}

/**
 * The index terms with their current weights and values.
 *
 * Exported so the centre-panel read-out can render them without duplicating the
 * term list, which would let the two drift apart the first time a term changed.
 *
 * @returns {Object[]} Entries `{ id, label, symbol, weight, value, measured }`.
 */
export function getVisualQualityTerms() {
    return TERMS.map((t) => ({
        id: t.id,
        label: t.label,
        symbol: t.symbol,
        weight: weights.get(t.id) || 0,
        value: values.get(t.id),
        measured: t.measured,
    }));
}

/**
 * The current index value.
 *
 * @returns {number|null} The weighted mean, or null when no weight is non-zero.
 */
export function getVisualQualityIndex() {
    return computeIndex();
}

/**
 * Feed a measured pedestrian count into the index.
 *
 * Called by the centre-panel analytics when detection returns, so the formula
 * reflects the same count the reader can see. Kept as an explicit setter rather
 * than having the detector reach into this module, so the dependency runs one
 * way and the index stays testable without a running detector.
 *
 * @param {number} count Pedestrians detected in view.
 * @returns {number} The normalised value stored for the term.
 */
export function setDetectedPedestrians(count) {
    const n = Number.isFinite(count) ? Math.max(0, count) : 0;
    const normalised = Math.min(1, n / PEDESTRIAN_SATURATION);
    values.set('pedestrians', normalised);
    renderFormula();
    renderIndex();
    return normalised;
}

/** The saturation count used to normalise the pedestrian term. */
export function getPedestrianSaturation() {
    return PEDESTRIAN_SATURATION;
}
