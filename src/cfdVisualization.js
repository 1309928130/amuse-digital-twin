/**
 * CFD field visualisation: wind vectors and pollution concentration.
 *
 * Both layers read the probe exports produced by `tools/build-cfd-data.mjs` from
 * the Eddy3D / OpenFOAM case, so the two fields are sampled at the same points
 * and can be compared directly. Wind is drawn as a single `PolylineCollection`
 * and pollution as a single `PointPrimitiveCollection`: with ~18–22 k probes,
 * one entity each would cost thousands of draw calls and stall the globe,
 * whereas a batched primitive collection is one call.
 *
 * Wind direction is drawn from the probe's horizontal velocity (u,v). Pollutant
 * `s` is a *relative* concentration — the case used a placeholder emission rate
 * — so the legend is deliberately worded as relative, not µg/m³.
 */

import { getViewer } from './cesiumViewer.js';

// `Cesium` is provided as a global by the CDN <script> tag in index.html — the
// same convention the other visualisation modules rely on. Read it lazily so a
// missing/blocked CDN surfaces as a clear error at call time rather than a
// module-load crash that takes the whole bundle down.
const Cesium = globalThis.Cesium;
if (!Cesium) {
    console.error('[cfd] Cesium global is not available — check the CDN script tag.');
}

const WIND_URL = './simulation_data/wind/wind_field.json';
const POLLUTION_URL = './simulation_data/pollution/pollution_field.json';

/** Plausible wind cap, m/s. Above this the solver output is not trustworthy. */
const SPEED_CAP = 15;

/**
 * Arrow length in metres per m/s.
 *
 * The site block is roughly 215 m across, and the CFD domain about 414 x 483 m.
 * At 3 m per m/s a typical 3 m/s probe draws a 9 m arrow — a readable tick —
 * while the 15 m/s cap reaches 45 m, which reads as a long streak spanning about
 * a fifth of the block. Larger constants made single arrows longer than the
 * whole domain and pushed their endpoints off screen.
 */
const METRES_PER_SPEED = 3;

/** Minimum arrow length, so near-calm probes stay visible as a dot of colour. */
const MIN_ARROW_METRES = 3;

/**
 * Height above the ground added to every arrow, in metres.
 *
 * The probe grid samples at z = 2 m, which is below the imported building
 * massing, so drawn as-is the arrows disappear inside the blocks. Lifting them
 * puts the whole field on one readable plane.
 */
const ARROW_HEIGHT_LIFT = 40;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{wind: object|null, pollution: object|null}} */
const cache = { wind: null, pollution: null };

/** @type {{collection: any, count: number}|null} */
let windLayer = null;
/** @type {{collection: any, count: number}|null} */
let pollutionLayer = null;

let windVisible = false;
let pollutionVisible = false;

/**
 * @typedef {Object} WindOptions
 * @property {number} [speedCap]      Upper end of the colour ramp (m/s)
 * @property {number} [arrowScale]    Multiplier on arrow length
 * @property {boolean} [showSuspect]  Draw probes flagged as implausible
 * @property {number} [maxProbes]     Cap on drawn arrows (perf guard)
 */

/**
 * @typedef {Object} PollutionOptions
 * @property {number} [rangeMax]   Upper end of the colour ramp
 * @property {number} [pointSize]  Point diameter in pixels
 * @property {number} [maxProbes]  Cap on drawn points (perf guard)
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Fetch + memoise one of the field files. */
async function loadField(kind) {
    if (cache[kind]) return cache[kind];
    const url = kind === 'wind' ? WIND_URL : POLLUTION_URL;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
    }
    const data = await response.json();
    cache[kind] = data;
    return data;
}

/**
 * Linear interpolation through a colour ramp.
 * @param {Array<[number, number, number]>} stops RGB triplets, 0–255
 * @param {number} t Normalised position, 0–1
 */
function rampColor(stops, t) {
    const clamped = Math.max(0, Math.min(1, t));
    const scaled = clamped * (stops.length - 1);
    const i = Math.min(Math.floor(scaled), stops.length - 2);
    const f = scaled - i;
    const a = stops[i];
    const b = stops[i + 1];
    return Cesium.Color.fromBytes(
        Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
        255
    );
}

/**
 * Thin a probe list down to `max` entries by taking a uniform stride.
 *
 * The grid is regular, so an even stride keeps spatial coverage rather than
 * clustering in one corner. Returns the input untouched when it already fits.
 */
function thinProbes(probes, max) {
    if (!max || probes.length <= max) return probes;
    const stride = probes.length / max;
    const out = [];
    for (let i = 0; i < max; i++) {
        out.push(probes[Math.floor(i * stride)]);
    }
    return out;
}

/** Remove a polyline collection and its GPU resources. */
function destroyLayer(layer) {
    if (!layer) return;
    try {
        const viewer = getViewer();
        if (viewer && !viewer.isDestroyed()) {
            viewer.scene.primitives.remove(layer.collection);
        }
    } catch (error) {
        console.warn('[cfd] Could not remove layer cleanly:', error);
    }
}

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

/**
 * Render the wind field as coloured, direction-aligned arrows.
 *
 * @param {WindOptions} [options]
 * @returns {Promise<{count: number, suspect: number, omitted: number}|null>}
 */
export async function showWindField(options = {}) {
    const {
        speedCap = SPEED_CAP,
        arrowScale = 1,
        showSuspect = false,
        maxProbes = 6000,
    } = options;

    const viewer = getViewer();
    if (!viewer || viewer.isDestroyed()) return null;

    let data;
    try {
        data = await loadField('wind');
    } catch (error) {
        console.error('[cfd] Wind field unavailable:', error);
        return null;
    }

    clearWindField();

    // Suspect probes are dropped by default: they are solver artefacts, and
    // drawing them would dominate the colour ramp and hide the real pattern.
    const usable = showSuspect ? data.probes : data.probes.filter((p) => !p.suspect);
    const omitted = data.probes.length - usable.length;
    const probes = thinProbes(usable, maxProbes);

    const collection = new Cesium.PolylineCollection();
    // Arrows are oriented per-probe and drawn without depth testing against
    // terrain, so order does not matter and sorting would only cost time.
    collection.show = true;

    for (const probe of probes) {
        // Clamp only for the ramp; the arrow geometry still uses capped length.
        const display = Math.min(probe.speed, speedCap);
        const color = rampColor(WIND_RAMP, display / speedCap);

        const length = Math.max(MIN_ARROW_METRES, display * METRES_PER_SPEED * arrowScale);

        // (u,v) are already east/north components in m/s, so the horizontal
        // heading is atan2(east, north) — no need to go via degrees.
        const norm = Math.hypot(probe.u, probe.v) || 1;
        const eastPerMetre = probe.u / norm;
        const northPerMetre = probe.v / norm;

        // Metres -> degrees at this latitude. Longitude degrees are shorter
        // than latitude degrees away from the equator, hence the cos() term.
        const latRad = (probe.latitude * Math.PI) / 180;
        const dLon = (eastPerMetre * length) / (111320 * Math.cos(latRad));
        const dLat = (northPerMetre * length) / 111320;

        // The probe grid sits at z = 2 m, which is below the roofline of the
        // imported massing and would be hidden behind it. Lift the arrows to a
        // consistent reading height so they float over the blocks.
        const drawHeight = probe.height + ARROW_HEIGHT_LIFT;

        const positions = [
            Cesium.Cartesian3.fromDegrees(probe.longitude, probe.latitude, drawHeight),
            Cesium.Cartesian3.fromDegrees(
                probe.longitude + dLon,
                probe.latitude + dLat,
                drawHeight
            ),
        ];

        collection.add({
            positions,
            width: 3,
            material: Cesium.Material.fromType('Color', { color }),
        });
    }

    viewer.scene.primitives.add(collection);
    windLayer = { collection, count: probes.length };
    windVisible = true;

    console.log(
        `[cfd] Wind field: ${probes.length} arrows` +
            (omitted ? ` (${omitted} suspect probes hidden)` : '')
    );
    return { count: probes.length, suspect: data.suspectCount || 0, omitted };
}

/** Blue → cyan → green → yellow → red, matching the wind legend. */
const WIND_RAMP = [
    [0, 0, 255],
    [0, 255, 255],
    [0, 255, 0],
    [255, 255, 0],
    [255, 0, 0],
];

/** Remove the wind layer. */
export function clearWindField() {
    destroyLayer(windLayer);
    windLayer = null;
    windVisible = false;
}

export function isWindFieldVisible() {
    return windVisible;
}

export function getWindFieldStats() {
    return cache.wind ? cache.wind.stats : null;
}

// ---------------------------------------------------------------------------
// Pollution
// ---------------------------------------------------------------------------

/** Green → lime → yellow → orange → red, matching the pollution legend. */
const POLLUTION_RAMP = [
    [27, 94, 32],
    [174, 213, 129],
    [255, 238, 88],
    [251, 140, 0],
    [183, 28, 28],
];

/** Lift for the ground-level pollution points, in metres.
 *
 * The probes are sampled at z = 2 m, so this is only a nudge to keep the points
 * clear of z-fighting against the basemap imagery — it is deliberately small.
 * It was originally 25 m to escape depth occlusion by the building massing, but
 * `disableDepthTestDistance` handles that properly; a large lift just made the
 * whole field visibly float above the streets.
 */
const GROUND_POINT_LIFT = 2;

/**
 * Render the pollutant concentration field as ground-level points.
 *
 * Uses a `PointPrimitiveCollection` rather than zero-length polylines: a
 * degenerate segment of equal start/end points is culled by Cesium and draws
 * nothing, which made this layer invisible. Point primitives are the correct
 * type for sampled scalar data and batch into a single draw call.
 *
 * @param {PollutionOptions} [options]
 * @returns {Promise<{count: number}|null>}
 */
export async function showPollutionField(options = {}) {
    const { rangeMax = null, pointSize = 9, maxProbes = 12000 } = options;

    const viewer = getViewer();
    if (!viewer || viewer.isDestroyed()) return null;

    let data;
    try {
        data = await loadField('pollution');
    } catch (error) {
        console.error('[cfd] Pollution field unavailable:', error);
        return null;
    }

    clearPollutionField();

    // The p95 is a far more stable upper bound than the maximum, which is a
    // single stagnation pocket and would wash the rest of the field out.
    const cap = rangeMax || data.stats.p95 || data.stats.max || 1;
    const probes = thinProbes(data.probes, maxProbes);

    const collection = new Cesium.PointPrimitiveCollection();

    for (const probe of probes) {
        collection.add({
            position: Cesium.Cartesian3.fromDegrees(
                probe.longitude,
                probe.latitude,
                probe.height + GROUND_POINT_LIFT
            ),
            color: rampColor(POLLUTION_RAMP, probe.s / cap),
            pixelSize: pointSize,
            // Points must scale with distance or they vanish when zoomed out to
            // the site block, which is the default framing for this page.
            scaleByDistance: new Cesium.NearFarScalar(300, 1.6, 3000, 0.7),
            // Draw through the building massing. The probes are sampled at
            // street level, so without this they sit inside or behind the
            // blocks and the whole field disappears from the default view.
            //
            // A large finite number, not `Number.POSITIVE_INFINITY`: this
            // Cesium build coerces Infinity to null on PointPrimitive, which
            // silently leaves depth testing enabled.
            disableDepthTestDistance: 1e9,
        });
    }

    viewer.scene.primitives.add(collection);
    pollutionLayer = { collection, count: probes.length };
    pollutionVisible = true;

    console.log(`[cfd] Pollution field: ${probes.length} points, ramp 0..${cap}`);
    return { count: probes.length };
}

/** Remove the pollution layer. */
export function clearPollutionField() {
    destroyLayer(pollutionLayer);
    pollutionLayer = null;
    pollutionVisible = false;
}

export function isPollutionFieldVisible() {
    return pollutionVisible;
}

export function getPollutionFieldStats() {
    return cache.pollution ? cache.pollution.stats : null;
}

/** Metadata for the right-hand panel (source, case, counts, units). */
export function getCfdMetadata() {
    return {
        wind: cache.wind
            ? {
                  case: cache.wind.case,
                  time: cache.wind.time,
                  units: cache.wind.units,
                  count: cache.wind.count,
                  inletSpeed: cache.wind.inletSpeed,
                  suspectCount: cache.wind.suspectCount,
                  stats: cache.wind.stats,
              }
            : null,
        pollution: cache.pollution
            ? {
                  case: cache.pollution.case,
                  time: cache.pollution.time,
                  units: cache.pollution.units,
                  count: cache.pollution.count,
                  stats: cache.pollution.stats,
                  note: cache.pollution.note,
              }
            : null,
    };
}
