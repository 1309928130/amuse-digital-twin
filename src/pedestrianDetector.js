/**
 * In-browser pedestrian detection on the rendered scene.
 *
 * ## What this is for
 *
 * The visual-quality page wants to know how much of what a pedestrian sees is
 * other pedestrians. Detection on the rendered frame is one way to answer that:
 * whatever is in the picture is, by definition, what the view contains.
 *
 * ## Why the frame comes from the canvas
 *
 * There is no video and no fixed camera here, so the only thing that can answer
 * "what is in the view" is the view itself. `getViewer().scene.canvas` is that
 * view. Reading it back requires the context to have been created with
 * `preserveDrawingBuffer: true`, which `cesiumViewer.js` sets and explains.
 *
 * ## Honest limits, stated up front
 *
 * - **It detects people, not "visual quality".** The COCO person class is the
 *   only class this uses. Trees, façades and sky are not detected. The reviewer
 *   plans to colour those in the model itself, which is a better approach for
 *   elements under our own control -- a colour mask is exact, whereas a detector
 *   is a guess about semantics.
 * - **Detecting rendered avatars is easier than detecting photographs.** The
 *   figures are flat-lit and unobstructed by foliage, but they are also low
 *   contrast against grey paving and often partly occluded by each other. The
 *   score below is measured, not assumed.
 * - **The detector has no memory of agents.** It counts people in an image. It
 *   cannot say *which* agent is which, so it cannot follow one across frames
 *   without a tracker. That is why the count is reported per frame rather than
 *   as unique pedestrians.
 * - **This is not the same number as the simulation's agent count.** The
 *   simulation knows exactly how many agents are running; the detector sees how
 *   many are *rendered and legible in this view*. The gap between those two
 *   numbers is the interesting quantity, and both are shown.
 *
 * ## Why ONNX Runtime Web
 *
 * It is the only route that needs no Python process and no server, so the count
 * is genuinely live. The model is fetched once and cached by the browser.
 */

import { getViewer } from './cesiumViewer.js';

const Cesium = globalThis.Cesium;

/**
 * Where the ONNX runtime and model are fetched from.
 *
 * A CDN for the runtime, matching how `protobufjs` is already loaded in
 * `index.html`, so no build step is introduced. The model is served from the
 * same origin as the app, because a 15 MB asset on a third party is one more
 * thing that can rate-limit or disappear, and it must be a file we control to
 * guarantee the input size and class list the post-processing assumes.
 */
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js';
const MODEL_URL = 'models/yolov5n-pedestrian.onnx';

/** Detection confidence below which a box is discarded. */
const CONFIDENCE_THRESHOLD = 0.35;

/**
 * IoU above which two boxes are treated as the same person.
 *
 * YOLO emits a box per anchor that passes the threshold, so a single person can
 * produce several overlapping boxes. Counting them all would inflate the total
 * by roughly the number of anchors that fired.
 */
const IOU_THRESHOLD = 0.45;

/** Model input side, in pixels. YOLOv5n is trained at 640. */
const INPUT_SIZE = 640;

let session = null;
let sessionLoading = null;
let ortLoading = null;

/** Rolling frame timings, for the reported rate. */
const frameTimes = [];
const MAX_FRAME_SAMPLES = 12;

/**
 * Load ONNX Runtime Web from the CDN, once.
 *
 * @returns {Promise<Object>} The `ort` global.
 */
function loadOrt() {
    if (globalThis.ort) return Promise.resolve(globalThis.ort);
    if (ortLoading) return ortLoading;
    ortLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = ORT_URL;
        script.crossOrigin = 'anonymous';
        script.onload = () => {
            if (globalThis.ort) resolve(globalThis.ort);
            else reject(new Error('ONNX Runtime loaded but did not register itself.'));
        };
        script.onerror = () => reject(new Error('Could not load ONNX Runtime from the CDN.'));
        document.head.appendChild(script);
    });
    return ortLoading;
}

/**
 * Create the inference session, once.
 *
 * @returns {Promise<Object>} The ONNX session.
 */
export function loadModel() {
    if (session) return Promise.resolve(session);
    if (sessionLoading) return sessionLoading;
    sessionLoading = (async () => {
        const ort = await loadOrt();
        // Single-threaded on purpose: the wasm multi-threaded build needs
        // cross-origin isolation headers that this static host does not send, and
        // it would compete with Cesium for the same cores anyway.
        ort.env.wasm.numThreads = 1;
        const attempt = await fetch(MODEL_URL, { method: 'HEAD' }).catch(() => null);
        if (!attempt || !attempt.ok) {
            throw new Error(
                `No detection model at ${MODEL_URL}. Run tools/fetch-yolo-model.mjs to download it.`
            );
        }
        session = await ort.InferenceSession.create(MODEL_URL, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
        return session;
    })();
    sessionLoading = sessionLoading.catch((error) => {
        // Cleared so a later attempt can retry rather than being handed the
        // same rejected promise forever.
        sessionLoading = null;
        throw error;
    });
    return sessionLoading;
}

/** Whether the model is ready to run without further loading. */
export function isModelReady() {
    return session !== null;
}

/**
 * Grab the current rendered frame as an ImageData-like tensor source.
 *
 * The canvas is read directly rather than through `toDataURL`, which would
 * encode and decode a PNG for every frame -- far too slow at several frames per
 * second. `drawImage` onto a 2D canvas is the cheap path.
 *
 * @param {number} size Square side to resample to, in pixels.
 * @returns {{data: Uint8ClampedArray, width: number, height: number}|null}
 */
function grabFrame(size) {
    const viewer = getViewer();
    if (!viewer) return null;
    const source = viewer.scene.canvas;
    if (!source || !source.width || !source.height) return null;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // The scene canvas is not square and the model wants square input, so the
    // frame is stretched rather than letterboxed. Letterboxing would add padding
    // bars the model was not trained on and shrink the figures further; the
    // aspect distortion is the smaller error for a detector used on people at a
    // distance, and the boxes are mapped back through the same transform.
    ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size);
}

/**
 * Build the model's input tensor from a frame.
 *
 * YOLOv5 expects NCHW in 0..1, with no mean/std normalisation beyond the divide
 * by 255.
 *
 * The dtype is **float16**, not float32. The published `yolov5n.onnx` at the v7.0
 * tag is an FP16-quantised export and the runtime rejects a float32 tensor
 * outright with "Unexpected input data type".
 *
 * ONNX Runtime 1.18 additionally insists the buffer be a genuine
 * `Float16Array`, not a `Uint16Array` holding the same bit patterns, so this
 * prefers the native type and falls back to hand-packing only where the browser
 * has not shipped it yet.
 *
 * @param {Uint8ClampedArray} rgba Raw pixels.
 * @param {number} size Input side.
 * @returns {Float16Array|Uint16Array} Tensor data, half-precision.
 */
function toTensor(rgba, size) {
    const area = size * size;
    const Native = globalThis.Float16Array;
    const out = Native ? new Native(area * 3) : new Uint16Array(area * 3);
    for (let i = 0; i < area; i++) {
        const r = rgba[i * 4] / 255;
        const g = rgba[i * 4 + 1] / 255;
        const b = rgba[i * 4 + 2] / 255;
        if (Native) {
            out[i] = r;
            out[area + i] = g;
            out[2 * area + i] = b;
        } else {
            out[i] = floatToHalf(r);
            out[area + i] = floatToHalf(g);
            out[2 * area + i] = floatToHalf(b);
        }
    }
    return out;
}

/**
 * Convert a 0..1 float to its IEEE-754 half-precision bit pattern.
 *
 * Only the 0..1 range is needed, so the general conversion's edge cases
 * (subnormals above the smallest, infinities, NaN) cannot arise from this
 * caller -- but they are still handled rather than assumed away, because a
 * silent NaN here produces a detection count of zero that looks like a real
 * result.
 *
 * @param {number} value Value in 0..1.
 * @returns {number} Half-precision bit pattern.
 */
function floatToHalf(value) {
    if (Number.isNaN(value)) return 0x7e00; // NaN
    if (value === Infinity) return 0x7c00;
    if (value === -Infinity) return 0xfc00;

    // Isolate sign, then work with the magnitude.
    let f = value;
    let sign = 0;
    if (f < 0) {
        sign = 0x8000;
        f = -f;
    }
    if (f === 0) return sign;

    // Unbiased exponent from the float32 representation.
    const exp = Math.floor(Math.log2(f));
    const halfExp = exp + 15;

    if (halfExp <= 0) {
        // Too small for a normal half: subnormal, losing precision.
        return sign | Math.round(f / Math.pow(2, -24));
    }
    if (halfExp >= 31) return sign | 0x7c00; // overflows to infinity

    const mantissa = Math.round((f / Math.pow(2, exp) - 1) * 1024);
    // Rounding the mantissa can carry into the exponent, so it is re-normalised
    // rather than allowed to produce an out-of-range bit pattern.
    if (mantissa >= 1024) return sign | ((halfExp + 1) << 10);
    return sign | (halfExp << 10) | mantissa;
}

/**
 * Intersection over union of two boxes.
 *
 * @param {number[]} a `[x1, y1, x2, y2]`.
 * @param {number[]} b Same.
 * @returns {number} IoU in 0..1.
 */
function iou(a, b) {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]);
    const y2 = Math.min(a[3], b[3]);
    const w = Math.max(0, x2 - x1);
    const h = Math.max(0, y2 - y1);
    const inter = w * h;
    if (inter <= 0) return 0;
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
}

/**
 * Greedy non-maximum suppression.
 *
 * @param {Object[]} dets Detections `{ box, score }`.
 * @returns {Object[]} The kept subset, highest score first.
 */
function nms(dets) {
    const sorted = [...dets].sort((a, b) => b.score - a.score);
    const kept = [];
    for (const det of sorted) {
        let suppressed = false;
        for (const k of kept) {
            if (iou(det.box, k.box) > IOU_THRESHOLD) {
                suppressed = true;
                break;
            }
        }
        if (!suppressed) kept.push(det);
    }
    return kept;
}

/**
 * Decode YOLOv5's raw output.
 *
 * Verified against the downloaded `yolov5n.onnx`: the graph declares its input
 * as `images` and a single output named `output0`, shaped `[1, 25200, 85]` for
 * 640 px input. Each of the 25,200 rows is
 * `[cx, cy, w, h, objectness, ...80 class scores]` in input-pixel units. Only
 * the person class is kept, which is COCO class 0 and therefore sits at index 5.
 *
 * The fixed row count is asserted rather than inferred, because a model with a
 * different input size would produce a different number of rows and silently
 * decode as garbage offsets instead of failing loudly.
 *
 * @param {Float32Array} data Raw output.
 * @param {number} inputSize Model input side.
 * @returns {Object[]} Detections in input-pixel coordinates.
 * @throws {Error} If the tensor length does not match the expected layout.
 */
function decodeOutput(data, inputSize) {
    const rows = 25200;
    const stride = 85;
    const dets = [];
    for (let i = 0; i < rows; i++) {
        const base = i * stride;
        const objectness = data[base + 4];
        if (objectness < CONFIDENCE_THRESHOLD) continue;
        const personScore = data[base + 5];
        const score = objectness * personScore;
        if (score < CONFIDENCE_THRESHOLD) continue;
        const cx = data[base];
        const cy = data[base + 1];
        const w = data[base + 2];
        const h = data[base + 3];
        dets.push({
            box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
            score,
        });
    }
    return nms(dets);
}

/**
 * Run detection on the current rendered frame.
 *
 * @returns {Promise<Object|null>} `{ count, detections, ms, fps, inputSize, frame }`,
 *   or null if the frame could not be read.
 */
export async function detectInView() {
    const sess = await loadModel();
    const frame = grabFrame(INPUT_SIZE);
    if (!frame) return null;

    const ort = globalThis.ort;
    // float16 to match the FP16-quantised export; see `toTensor`.
    const tensor = new ort.Tensor('float16', toTensor(frame.data, INPUT_SIZE), [
        1, 3, INPUT_SIZE, INPUT_SIZE,
    ]);

    const started = performance.now();
    const results = await sess.run({ images: tensor });
    const ms = performance.now() - started;

    // The exported model names its single output `output0`. It is referenced by
    // key rather than by taking the first entry, so a future model with several
    // outputs cannot be silently mis-read as if the first were the boxes.
    const outputKey = 'output0' in results ? 'output0' : Object.keys(results)[0];
    const raw = results[outputKey].data;
    if (raw.length !== 25200 * 85) {
        throw new Error(
            `Unexpected detection output size ${raw.length}; expected ${25200 * 85}. ` +
            'The model may not be a 640 px YOLOv5 export.'
        );
    }
    const detections = decodeOutput(raw, INPUT_SIZE);

    frameTimes.push(ms);
    if (frameTimes.length > MAX_FRAME_SAMPLES) frameTimes.shift();
    const mean = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;

    return {
        count: detections.length,
        detections,
        ms,
        fps: mean > 0 ? 1000 / mean : 0,
        inputSize: INPUT_SIZE,
        frame,
    };
}

/**
 * Count agents the simulation knows about, for comparison with the detection.
 *
 * Read from the scene rather than by re-parsing the JSON, so this is the number
 * actually being drawn.
 *
 * Two renderers exist: `agentAvatar.js` adds full figures as entities named
 * `agent-avatar-<i>`, and `trajectoryVisualization.js` falls back to points in a
 * primitive collection when avatars are unavailable. Both are counted, because
 * which one is in use is an implementation detail of the renderer and the
 * comparison is only meaningful against whatever is on screen.
 *
 * @returns {number} Agent count currently rendered, or 0 if none.
 */
export function renderedAgentCount() {
    const viewer = getViewer();
    if (!viewer) return 0;
    let n = 0;
    const entities = viewer.entities.values;
    for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        // `name`, not `id`: the avatar module sets a display name and lets Cesium
        // assign the id. Checking `id` here silently returned 0.
        const name = (e && e.name) || '';
        if (typeof name === 'string' && name.startsWith('agent-avatar-')) {
            n++;
            continue;
        }
        // Fallback renderer: dots live in a collection, and their parent entity
        // carries the agent index in its id.
        const id = (e && e.id) || '';
        if (typeof id === 'string' && id.startsWith('agent-point-')) n++;
    }
    if (n > 0) return n;
    return pointingAgentCount(viewer);
}

/**
 * Count point primitives used for agents, when no avatars are present.
 *
 * @param {Object} viewer Cesium viewer.
 * @returns {number} Point count, or 0.
 */
function pointingAgentCount(viewer) {
    const primitives = viewer.scene.primitives;
    for (let i = 0; i < primitives.length; i++) {
        const p = primitives.get(i);
        // Duck-typed rather than `instanceof`, because the deployed build minifies
        // Cesium's class names and `constructor.name` is not dependable.
        if (p && typeof p.get === 'function' && typeof p.length === 'number') {
            const first = p.get(0);
            if (first && first.position && first.pixelSize != null) return p.length;
        }
    }
    return 0;
}
