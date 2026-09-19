/**
 * Pedestrian demand heatmap + network flow from PedMac (PedModel) results.
 * Click an edge to show daily total and hourly flow breakdown (no hover).
 */

import { getViewer } from './cesiumViewer.js';
import { ZUIDAS_BOUNDS } from './config.js';

import { resolveExistingPath } from './dataRegistry.js';
import { offsetLineRight, joinOffsetsAtNodes, arrowheadAtMidpoint } from './flowGeometry.js';

let flowEnabled = false;
let demandEnabled = false;
let flowPolylineCollection = null;
let flowArrowCollection = null;
let flowEdges = [];
/**
 * One entry per drawn edge: the primitives plus the data behind them.
 *
 * Kept as a parallel list so the hour control can recolour without rebuilding
 * geometry, and so a tooltip can read the same values that were drawn.
 * @type {{polyline: Object, arrow: Object|null, edge: Object, coords: number[][]}[]}
 */
let flowLines = [];
let spatialCells = new Map(); // "ix,iy" -> edge indices
let cellSizeDeg = 0.0008;
let demandEntity = null;
let demandMeta = null;
let flowMeta = null;
let hoverHandler = null; // click handler (name kept for teardown)
let tooltipEl = null;
let highlightPrimitive = null;
let lastHoverIdx = -1;
let pinnedTooltip = false;

/**
 * Sentinal for "no particular hour": show the daily total.
 *
 * Deliberately not `null` or `undefined`, because those already have meanings
 * here, and not `-1`, which would read as a plausible hour to a caller that
 * forgot to check.
 */
export const HOUR_ALL_DAY = 'all-day';

/**
 * How far each direction is drawn from the road centreline, in metres.
 *
 * Matches `OFFSET_DIST_M` in the Python that produced the published maps, so the
 * two pictures agree. The visible separation is twice this, since the two
 * directions move to opposite sides.
 */
const FLOW_OFFSET_METRES = 1.5;

/**
 * Height above the ellipsoid for flow lines, in metres.
 *
 * The offset already separates the two directions, so this only has to clear the
 * terrain without floating visibly above it.
 */
const FLOW_HEIGHT_METRES = 2.5;

/** Currently rendered hour, or `HOUR_ALL_DAY`. */
let currentHour = HOUR_ALL_DAY;

/** Cached per-hour network totals; null until the first request. */
let networkHourTotalsCache = null;

/** Cached peak hour; null until the first request. */
let networkPeakHourCache = null;

/**
 * The colour cap in force for the current display.
 *
 * Stored rather than recomputed so the highlight can size itself from the same
 * scale the map is using. Kept in a module variable because `highlightEdge` is
 * called from a Cesium input handler, which has no access to the return value of
 * `applyHour`.
 */
let highlightCap = 1;

/**
 * Pending hover preview, and the link it belongs to.
 *
 * `hoverTimer` is the dwell countdown; `pendingHoverIdx` records which link is
 * being waited on so that a move within the same link does not restart the
 * countdown, while a move onto a different link does.
 */
let hoverTimer = null;
let pendingHoverIdx = -1;

/**
 * Dwell time before a hover preview appears, in milliseconds.
 *
 * Sweeping the pointer across the flow layer passes over many links, and showing
 * each one immediately made the tooltip flicker from link to link and read as
 * noise rather than a response to intent. Requiring the pointer to rest first
 * means the preview appears only for the link the user actually stopped on.
 */
const HOVER_DELAY_MS = 500;

/** YlOrRd-like stops (matplotlib YlOrRd) */
const YLORRD = [
    [255, 255, 204],
    [255, 237, 160],
    [254, 217, 118],
    [254, 178, 76],
    [253, 141, 60],
    [252, 78, 42],
    [227, 26, 28],
    [177, 0, 38],
];

function lerpColor(t) {
    const x = Math.max(0, Math.min(1, t));
    const n = YLORRD.length - 1;
    const f = x * n;
    const i = Math.min(n - 1, Math.floor(f));
    const a = YLORRD[i];
    const b = YLORRD[i + 1];
    const u = f - i;
    return Cesium.Color.fromBytes(
        Math.round(a[0] + (b[0] - a[0]) * u),
        Math.round(a[1] + (b[1] - a[1]) * u),
        Math.round(a[2] + (b[2] - a[2]) * u),
        230
    );
}

function flowNorm(flow, meta) {
    const vmax = (meta && meta.flow_p95) || (meta && meta.flow_max) || 1;
    if (!(vmax > 0)) return 0;
    return Math.min(1, flow / vmax);
}

/**
 * Line width for a normalised value in 0..1.
 *
 * Split out from `flowWidth` so the hour control can set a width from a value it
 * has already scaled against that hour's own cap, without re-deriving the cap or
 * going through a meta object that no longer describes what is on screen.
 *
 * @param {number} t Normalised value, 0..1.
 * @returns {number} Width in pixels.
 */
function flowWidthFor(t) {
    const clamped = Math.max(0, Math.min(1, t));
    return 1.5 + clamped * 6.5;
}

/**
 * Update the legend's stated range to match the hour being shown.
 *
 * Without this the legend keeps claiming "0 - <daily P95> ped/day" while the map
 * is coloured by one hour, so the two disagree exactly when a reader is trying to
 * use one to interpret the other.
 *
 * @param {number} cap The upper bound currently mapped to the top colour.
 * @param {boolean} allDay Whether the display is the daily total.
 * @param {number} hour Hour 0-23, when not the daily total.
 */
function updateLegendRange(cap, allDay, hour) {
    const range = document.getElementById('networkFlowLegendRange');
    if (!range) return;
    const label = allDay
        ? 'ped/day (P95 cap)'
        : `ped/h, ${String(hour).padStart(2, '0')}:00 (P95 of this hour)`;
    range.textContent = `0 – ${formatFlow(cap)} ${label}`;
}

function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'networkFlowTooltip';
    tooltipEl.style.cssText = [
        'position:absolute',
        'display:none',
        'z-index:10050',
        'pointer-events:auto',
        'background:rgba(20,20,20,0.92)',
        'color:#fff',
        'font-family:sans-serif',
        'font-size:12px',
        'line-height:1.35',
        'padding:10px 12px',
        'border-radius:6px',
        'box-shadow:0 4px 14px rgba(0,0,0,0.45)',
        'max-width:300px',
        'max-height:70vh',
        'overflow-y:auto',
        'white-space:normal',
    ].join(';');
    document.body.appendChild(tooltipEl);
    return tooltipEl;
}

function formatFlow(x) {
    if (!Number.isFinite(x)) return '—';
    if (x >= 100) return x.toFixed(0);
    if (x >= 10) return x.toFixed(1);
    return x.toFixed(2);
}

function buildTooltipHtml(edge) {
    const name = edge.name || 'Unnamed link';
    const hwy = edge.highway || 'unknown';
    const hourly = edge.hourly || [];
    const peakHour = hourly.reduce((best, v, i) => (v > (hourly[best] || -1) ? i : best), 0);
    const maxH = Math.max(...hourly, 1e-6);
    // The hour the map is currently showing, so the tooltip cannot disagree with
    // the colour of the link under the pointer.
    const shown = currentHour;
    const showingOneHour = shown !== HOUR_ALL_DAY;
    const bars = hourly.map((v, h) => {
        const pct = Math.round((v / maxH) * 100);
        const peak = h === peakHour && v > 0 ? 'font-weight:600;color:#FFD54F;' : '';
        const isShown = showingOneHour && h === shown;
        const row = isShown ? 'background:rgba(255,213,79,0.16);border-radius:3px;' : '';
        return `<div style="display:flex;align-items:center;gap:6px;margin:1px 0;${row}">
            <span style="width:28px;opacity:0.85;${peak}">${String(h).padStart(2, '0')}</span>
            <div style="flex:1;height:6px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#ffe082,#e53935);"></div>
            </div>
            <span style="width:42px;text-align:right;opacity:0.9;${peak}">${formatFlow(v)}</span>
        </div>`;
    }).join('');

    // When one hour is displayed, lead with that hour: it is what the pointer is
    // asking about, and burying it under the daily total reads as a contradiction.
    const headline = showingOneHour
        ? `<div style="margin-bottom:8px;">At <b>${String(shown).padStart(2, '0')}:00</b>: <b>${formatFlow(hourValue(edge, shown))}</b> ped/h<br>
             <span style="opacity:0.7;">Daily total: ${formatFlow(edge.flow)} ped/day</span></div>`
        : `<div style="margin-bottom:8px;">Daily flow: <b>${formatFlow(edge.flow)}</b> ped/day</div>`;

    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;">
            <div style="font-weight:600;">${name}</div>
            <button type="button" id="networkFlowTooltipClose" style="background:none;border:none;color:#fff;opacity:0.7;cursor:pointer;font-size:16px;line-height:1;padding:0;">×</button>
        </div>
        <div style="opacity:0.8;margin-bottom:6px;">${hwy} · UVK (${edge.u}, ${edge.v}, ${edge.k})</div>
        ${headline}
        <div style="opacity:0.85;margin-bottom:4px;font-size:11px;">Hourly flow (ped/h)</div>
        ${bars}`;
}

function showFlowLegend(meta) {
    const panel = document.getElementById('networkFlowLegend');
    const bar = document.getElementById('networkFlowLegendBar');
    const range = document.getElementById('networkFlowLegendRange');
    if (!panel || !bar) return;
    bar.style.background = `linear-gradient(to right, ${YLORRD.map(([r, g, b]) => `rgb(${r},${g},${b})`).join(', ')})`;
    if (range) {
        const vmax = meta.flow_p95 || meta.flow_max || 0;
        range.textContent = `0 – ${formatFlow(vmax)} ped/day (P95 cap)`;
    }
    panel.style.display = 'block';
}

function hideFlowLegend() {
    const panel = document.getElementById('networkFlowLegend');
    if (panel) panel.style.display = 'none';
}

function showDemandLegend(meta) {
    const panel = document.getElementById('demandHeatLegend');
    const bar = document.getElementById('demandHeatLegendBar');
    const range = document.getElementById('demandHeatLegendRange');
    if (!panel || !bar) return;
    bar.style.background = 'linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)';
    if (range) {
        const vmax = meta.demand_p95 || meta.demand_max || 0;
        range.textContent = `0 – ${formatFlow(vmax)} trips/day (P95 cap)`;
    }
    panel.style.display = 'block';
}

function hideDemandLegend() {
    const panel = document.getElementById('demandHeatLegend');
    if (panel) panel.style.display = 'none';
}

function clearHighlight() {
    const viewer = getViewer();
    if (highlightPrimitive && viewer) {
        try { viewer.scene.primitives.remove(highlightPrimitive); } catch (_) { /* ignore */ }
        try { highlightPrimitive.destroy(); } catch (_) { /* ignore */ }
        highlightPrimitive = null;
    }
    lastHoverIdx = -1;
}

function highlightEdge(edge, idx) {
    if (idx === lastHoverIdx) return;
    clearHighlight();
    lastHoverIdx = idx;
    const viewer = getViewer();
    if (!viewer || !edge || !edge.coords || edge.coords.length < 2) return;

    // Drawn on the *offset* line that this edge was rendered as, not on the raw
    // centreline. Highlighting the centreline would put a white line between the
    // two directions and undo the separation the layer exists to show.
    const line = flowLines[idx];
    const coords = line ? line.coords : edge.coords;

    highlightPrimitive = new Cesium.PolylineCollection();
    viewer.scene.primitives.add(highlightPrimitive);
    const flat = [];
    coords.forEach(([lon, lat]) => flat.push(lon, lat, FLOW_HEIGHT_METRES + 0.2));
    // Sized from what is currently drawn, so the highlight matches the hour on
    // screen rather than the daily total it is not showing.
    const shownValue = currentHour === HOUR_ALL_DAY ? edge.flow : hourValue(edge, currentHour);
    const cap = currentHour === HOUR_ALL_DAY
        ? (flowMeta && (flowMeta.flow_p95 || flowMeta.flow_max)) || 1
        : highlightCap || 1;
    highlightPrimitive.add({
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
        width: Math.max(8, flowWidthFor(cap > 0 ? shownValue / cap : 0) + 3),
        material: Cesium.Material.fromType('Color', {
            color: Cesium.Color.WHITE.withAlpha(0.95),
        }),
    });
}

function buildSpatialIndex(edges) {
    spatialCells = new Map();
    // Picking is done against the *offset* geometry, so the index is built from
    // that rather than from the raw centreline. Using the centreline would leave
    // the drawn lines just outside their own cells, and clicking a link at the far
    // edge of a cell would miss it.
    edges.forEach((edge, idx) => {
        const line = flowLines[idx];
        const coords = (line && line.coords) || edge.coords;
        if (!coords || coords.length < 2) return;
        let minLon = Infinity;
        let maxLon = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        coords.forEach(([lon, lat]) => {
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        });
        const ix0 = Math.floor(minLon / cellSizeDeg);
        const ix1 = Math.floor(maxLon / cellSizeDeg);
        const iy0 = Math.floor(minLat / cellSizeDeg);
        const iy1 = Math.floor(maxLat / cellSizeDeg);
        for (let ix = ix0; ix <= ix1; ix++) {
            for (let iy = iy0; iy <= iy1; iy++) {
                const key = `${ix},${iy}`;
                if (!spatialCells.has(key)) spatialCells.set(key, []);
                spatialCells.get(key).push(idx);
            }
        }
    });
}

function distPointToSeg2(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const ab2 = abx * abx + aby * aby;
    let t = ab2 > 0 ? (apx * abx + apy * aby) / ab2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy;
}

function findNearestEdge(lon, lat, maxDistDeg = 0.00035) {
    const ix = Math.floor(lon / cellSizeDeg);
    const iy = Math.floor(lat / cellSizeDeg);
    const candidates = new Set();
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const list = spatialCells.get(`${ix + dx},${iy + dy}`);
            if (list) list.forEach((i) => candidates.add(i));
        }
    }
    let bestIdx = -1;
    let bestD = maxDistDeg * maxDistDeg;
    candidates.forEach((idx) => {
        const edge = flowEdges[idx];
        // Measured against the offset geometry that is actually on screen, so
        // clicking a link picks the direction drawn under the pointer rather than
        // whichever of the pair happens to share the centreline.
        const line = flowLines[idx];
        const coords = (line && line.coords) || edge.coords;
        for (let i = 0; i < coords.length - 1; i++) {
            const d = distPointToSeg2(
                lon, lat,
                coords[i][0], coords[i][1],
                coords[i + 1][0], coords[i + 1][1]
            );
            if (d < bestD) {
                bestD = d;
                bestIdx = idx;
            }
        }
    });
    return bestIdx;
}

function hidePinnedTooltip() {
    pinnedTooltip = false;
    hoverIdx = -1;
    const tip = ensureTooltip();
    tip.style.display = 'none';
    clearHighlight();
}

function showPinnedTooltip(edge, idx, screenPosition) {
    const tip = ensureTooltip();
    tip.innerHTML = buildTooltipHtml(edge);
    tip.style.display = 'block';
    tip.style.left = `${Math.min(window.innerWidth - 320, screenPosition.x + 14)}px`;
    tip.style.top = `${Math.min(window.innerHeight - 40, screenPosition.y + 14)}px`;
    pinnedTooltip = true;
    highlightEdge(edge, idx);

    const closeBtn = document.getElementById('networkFlowTooltipClose');
    if (closeBtn) {
        closeBtn.onclick = (ev) => {
            ev.stopPropagation();
            hidePinnedTooltip();
        };
    }
}

function detachClickHandler() {
    // Cancelled before the handler is destroyed: otherwise a countdown started
    // just before teardown would fire later and show a tooltip over a layer that
    // is no longer on screen.
    cancelPendingHover();
    if (hoverHandler) {
        try { hoverHandler.destroy(); } catch (_) { /* ignore */ }
        hoverHandler = null;
    }
    hidePinnedTooltip();
}

/**
 * Tooltip interaction mode for link inspection.
 *  - 'hover': moving over a link previews it live (flow assessment page)
 *  - 'click': links are read-only until clicked (multi-layer overlap page)
 * @type {'hover'|'click'}
 */
let tooltipMode = 'click';

/** Link currently previewed by hover (not pinned). */
let hoverIdx = -1;

/**
 * @param {'hover'|'click'} mode
 */
export function setFlowTooltipMode(mode) {
    const next = mode === 'hover' ? 'hover' : 'click';
    if (next === tooltipMode) return;
    tooltipMode = next;
    console.log(`[Network Flow] Link tooltip mode: ${tooltipMode}`);
    // Leaving hover mode with a preview on screen would strand a tooltip whose
    // input action no longer exists, so it is cleared before re-attaching.
    if (next !== 'hover') {
        cancelPendingHover();
        hideHoverTooltip();
    }
    // Re-attach so the correct Cesium input actions are registered.
    if (flowEnabled) attachClickHandler();
}

export function getFlowTooltipMode() {
    return tooltipMode;
}

function showHoverTooltip(edge, idx, screenPosition) {
    if (pinnedTooltip) return; // a pinned tooltip wins until it is closed
    if (idx === hoverIdx) return;
    hoverIdx = idx;
    const tip = ensureTooltip();
    tip.innerHTML = buildTooltipHtml(edge);
    tip.style.display = 'block';
    tip.style.left = `${Math.min(window.innerWidth - 320, screenPosition.x + 14)}px`;
    tip.style.top = `${Math.min(window.innerHeight - 40, screenPosition.y + 14)}px`;
    highlightEdge(edge, idx);
}

/**
 * Start (or continue waiting) the dwell countdown for a link.
 *
 * Moving within the same link must not restart the timer, or a pointer drifting
 * a pixel would reset it and the preview would never appear. Only a move onto a
 * *different* link cancels the pending one and begins again.
 *
 * `screenPosition` is captured now and not read again when the timer fires: the
 * tooltip should appear where the pointer came to rest, not wherever it has
 * drifted to by then.
 */
function scheduleHoverTooltip(edge, idx, screenPosition) {
    if (pinnedTooltip) return;
    if (idx === hoverIdx) return; // already shown for this link
    if (idx === pendingHoverIdx) return; // already counting down for it
    cancelPendingHover();
    pendingHoverIdx = idx;
    hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        pendingHoverIdx = -1;
        // Re-checked because the layer or the page may have changed while the
        // countdown ran, in which case the preview would be stale or unwanted.
        if (!flowEnabled || tooltipMode !== 'hover') return;
        showHoverTooltip(edge, idx, screenPosition);
    }, HOVER_DELAY_MS);
}

/** Abandon a pending hover preview, if any. */
function cancelPendingHover() {
    if (hoverTimer !== null) {
        window.clearTimeout(hoverTimer);
        hoverTimer = null;
    }
    pendingHoverIdx = -1;
}

function hideHoverTooltip() {
    if (pinnedTooltip) return;
    cancelPendingHover();
    hoverIdx = -1;
    const tip = ensureTooltip();
    tip.style.display = 'none';
    clearHighlight();
}

/**
 * Resolve the nearest PedMac link under a screen position.
 * @returns {{ edge: Object, idx: number }|null}
 */
function pickEdgeAt(screenPosition) {
    const viewer = getViewer();
    if (!viewer) return null;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    const cartesian = viewer.camera.pickEllipsoid(screenPosition, ellipsoid);
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const idx = findNearestEdge(
        Cesium.Math.toDegrees(carto.longitude),
        Cesium.Math.toDegrees(carto.latitude)
    );
    if (idx < 0) return null;
    return { edge: flowEdges[idx], idx };
}

function attachClickHandler() {
    detachClickHandler();
    hoverIdx = -1;
    const viewer = getViewer();
    if (!viewer) return;
    ensureTooltip();
    hoverHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    // Click always works: it pins the tooltip (also the only interaction in 'click' mode)
    hoverHandler.setInputAction((click) => {
        if (!flowEnabled) return;
        const hit = pickEdgeAt(click.position);
        if (!hit) {
            hidePinnedTooltip();
            return;
        }
        showPinnedTooltip(hit.edge, hit.idx, click.position);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    if (tooltipMode !== 'hover') return;

    // Hover preview: only registered on pages that ask for it, and only after
    // the pointer has rested on one link for HOVER_DELAY_MS.
    hoverHandler.setInputAction((movement) => {
        if (!flowEnabled) return;
        const hit = pickEdgeAt(movement.endPosition);
        if (!hit) {
            cancelPendingHover();
            hideHoverTooltip();
            return;
        }
        scheduleHoverTooltip(hit.edge, hit.idx, movement.endPosition);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

/**
 * Load PedMac network flow edges as colored polylines.
 *
 * Two things happen here that did not before.
 *
 * **Bidirectional.** Each edge is offset to the right of its own direction of
 * travel, so the reverse of a two-way street is drawn as a separate line on the
 * other side rather than hidden underneath. Reciprocal pairs carry different
 * flows, so without this one direction was simply invisible -- see
 * `flowGeometry.js` for the full reasoning and for the algorithms, which are
 * ports of the Python that produced the published maps.
 *
 * **Hourly.** Every edge carries a 24-value `hourly` array, so the colouring is
 * late-bound: the geometry is built once and only the colours change when the
 * hour changes. That keeps the hour slider responsive, since a recolour does not
 * need to rebuild 28,000 polylines.
 */
export async function loadNetworkFlow(jsonPath, options = {}) {
    const viewer = getViewer();
    clearNetworkFlow();

    const res = await fetch(jsonPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${jsonPath}`);
    const data = await res.json();
    const edges = data.edges || [];
    flowMeta = data.meta || {};
    if (!edges.length) throw new Error('Network flow JSON has no edges');

    flowPolylineCollection = new Cesium.PolylineCollection();
    viewer.scene.primitives.add(flowPolylineCollection);
    flowArrowCollection = new Cesium.PolylineCollection();
    viewer.scene.primitives.add(flowArrowCollection);
    flowEdges = [];
    flowLines = [];

    // Geometry is computed per edge, then joined node-by-node. The join needs the
    // whole set at once, which is why this is two passes rather than one.
    const staged = edges
        .filter((edge) => edge.coords && edge.coords.length >= 2)
        .map((edge) => ({
            u: edge.u,
            v: edge.v,
            coords: offsetLineRight(edge.coords, FLOW_OFFSET_METRES),
            edge,
        }));

    const adjusted = joinOffsetsAtNodes(staged, FLOW_OFFSET_METRES);
    console.log(`[Network Flow] Offset ${staged.length} edges, joined ${adjusted} endpoints at nodes`);

    for (const item of staged) {
        const { coords, edge } = item;
        const flat = [];
        // Slightly above the ground; the offset already separates the directions,
        // so this only has to clear terrain, not another line.
        coords.forEach(([lon, lat]) => flat.push(lon, lat, FLOW_HEIGHT_METRES));

        const polyline = flowPolylineCollection.add({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
            // Placeholder width; `applyHour` below sets the real one from the
            // value for whichever hour is being displayed.
            width: 1.5,
            material: Cesium.Material.fromType('Color', {
                color: lerpColor(flowNorm(edge.flow, flowMeta)),
            }),
        });

        // The arrow is placed on the offset line, so it points along the direction
        // this edge is actually walked -- which is the whole point of drawing the
        // two directions apart.
        const arrowCoords = arrowheadAtMidpoint(coords);
        let arrow = null;
        if (arrowCoords) {
            const arrowFlat = [];
            arrowCoords.forEach(([lon, lat]) => arrowFlat.push(lon, lat, FLOW_HEIGHT_METRES));
            arrow = flowArrowCollection.add({
                positions: Cesium.Cartesian3.fromDegreesArrayHeights(arrowFlat),
                width: 1.6,
                material: Cesium.Material.fromType('Color', {
                    color: Cesium.Color.WHITE.withAlpha(0.75),
                }),
            });
        }

        flowEdges.push(edge);
        flowLines.push({ polyline, arrow, edge, coords });
    }

    buildSpatialIndex(flowEdges);
    flowEnabled = true;
    showFlowLegend(flowMeta);
    attachClickHandler();

    // Start at the daily total, which is what the page showed before the hour
    // control existed, so the default reading is unchanged.
    applyHour(HOUR_ALL_DAY);

    if (options.flyTo === true) {
        viewer.camera.flyTo({
            destination: Cesium.Rectangle.fromDegrees(
                ZUIDAS_BOUNDS.west,
                ZUIDAS_BOUNDS.south,
                ZUIDAS_BOUNDS.east,
                ZUIDAS_BOUNDS.north
            ),
            duration: 1.2,
        });
    }

    console.log(`[Network Flow] Loaded ${flowEdges.length} edges from ${jsonPath}`);
    return flowEdges.length;
}

/**
 * Recolour and rescale the network for a given hour.
 *
 * `HOUR_ALL_DAY` restores the daily totals, which is the reading the page had
 * before the hour control existed. Otherwise the per-edge `hourly` value for that
 * hour is used for both colour and width, scaled against the same hour across the
 * whole network so hours stay comparable with each other.
 *
 * Mutating the existing primitives keeps this cheap enough to run on every slider
 * step: no geometry is rebuilt, only a colour and a width per line.
 *
 * @param {number} hour Hour 0-23, or `HOUR_ALL_DAY`.
 * @returns {Object} Summary `{ hour, total, range, peakHour }` for the panel.
 */
export function applyHour(hour) {
    currentHour = hour;
    if (!flowLines.length) return null;

    const allDay = hour === HOUR_ALL_DAY;

    // Scale against this hour's own P95 rather than the daily P95, or a quiet hour
    // would render almost uniformly pale and the pattern would be invisible.
    const values = flowLines.map(({ edge }) =>
        allDay ? edge.flow : hourValue(edge, hour)
    );
    const cap = allDay
        ? (flowMeta.flow_p95 || flowMeta.flow_max || 1)
        : percentile(values, 0.95) || 1;

    let total = 0;
    let max = 0;
    flowLines.forEach(({ polyline, arrow, edge }) => {
        const value = allDay ? edge.flow : hourValue(edge, hour);
        total += value;
        if (value > max) max = value;

        const t = cap > 0 ? Math.min(1, value / cap) : 0;
        polyline.material = Cesium.Material.fromType('Color', { color: lerpColor(t) });
        polyline.width = flowWidthFor(t);
        // Fade the arrow out with the flow, so an empty hour does not show a
        // network of confident white arrowheads over invisible links.
        if (arrow) arrow.material = Cesium.Material.fromType('Color', {
            color: Cesium.Color.WHITE.withAlpha(0.2 + 0.6 * t),
        });
    });

    // Keep the tooltip and the spatial index reading the same numbers that are
    // drawn, so a link's readout matches its colour.
    highlightCap = cap;
    updateLegendRange(cap, allDay, hour);

    return {
        hour,
        total,
        max,
        cap,
        peakHour: networkPeakHour(),
        allDay,
    };
}

/**
 * Flow for one edge at one hour.
 *
 * Falls back to the daily total spread evenly across the day when an edge has no
 * hourly array, so a partial dataset still renders rather than disappearing.
 *
 * @param {Object} edge Flow edge.
 * @param {number} hour Hour 0-23.
 * @returns {number} Pedestrians per hour.
 */
export function hourValue(edge, hour) {
    const hourly = edge.hourly;
    if (!Array.isArray(hourly) || hourly.length !== 24) {
        return Number.isFinite(edge.flow) ? edge.flow / 24 : 0;
    }
    const v = hourly[hour];
    return Number.isFinite(v) ? v : 0;
}

/**
 * The hour with the highest network-wide flow.
 *
 * Computed once and cached, because it cannot change: it depends only on the
 * loaded dataset, and the chart marks it on every render.
 *
 * @returns {number} Hour 0-23.
 */
export function networkPeakHour() {
    if (networkPeakHourCache !== null) return networkPeakHourCache;
    const totals = networkHourTotals();
    let best = 0;
    for (let h = 1; h < 24; h++) {
        if (totals[h] > totals[best]) best = h;
    }
    networkPeakHourCache = best;
    return best;
}

/**
 * Network-wide flow for each of the 24 hours.
 *
 * This is what the panel's bar chart plots: every edge's contribution summed by
 * hour, so the shape of the day is visible at a glance and the current hour can
 * be marked on it.
 *
 * @returns {number[]} 24 totals, in pedestrians per hour.
 */
export function networkHourTotals() {
    if (networkHourTotalsCache) return networkHourTotalsCache;
    const totals = new Array(24).fill(0);
    for (const { edge } of flowLines) {
        for (let h = 0; h < 24; h++) totals[h] += hourValue(edge, h);
    }
    networkHourTotalsCache = totals;
    return totals;
}

/**
 * The value at a given percentile of an unsorted list.
 *
 * Used to derive the colour cap per hour. Nearest-rank rather than interpolated,
 * which is accurate enough for a colour scale and avoids a second array copy on
 * a path that runs on every slider step.
 *
 * @param {number[]} values Values.
 * @param {number} p Percentile as a fraction, e.g. 0.95.
 * @returns {number} The value at that percentile, or 0 for an empty list.
 */
function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[idx];
}

export function clearNetworkFlow() {
    const viewer = getViewer();
    detachClickHandler();
    for (const collection of [flowPolylineCollection, flowArrowCollection]) {
        if (collection && viewer) {
            try { viewer.scene.primitives.remove(collection); } catch (_) { /* ignore */ }
            try { collection.destroy(); } catch (_) { /* ignore */ }
        }
    }
    flowPolylineCollection = null;
    flowArrowCollection = null;
    flowEdges = [];
    flowLines = [];
    spatialCells = new Map();
    flowEnabled = false;
    flowMeta = null;
    currentHour = HOUR_ALL_DAY;
    networkHourTotalsCache = null;
    networkPeakHourCache = null;
    hideFlowLegend();
}

export function toggleNetworkFlow(show, options = {}) {
    if (show && !flowEnabled) {
        // Resolved rather than passed, because the flow file may come from the
        // active proposal, from the shared published copy, or from an upload —
        // `resolveExistingPath` picks between them.
        return resolveExistingPath('flow').then((url) =>
            url ? loadNetworkFlow(url, options) : Promise.resolve()
        );
    }
    if (!show && flowEnabled) {
        clearNetworkFlow();
    }
    return Promise.resolve();
}

export function isNetworkFlowEnabled() {
    return flowEnabled;
}

function createDemandMaterial(points, bounds, opacity, vmax) {
    const canvas = document.createElement('canvas');
    const width = 1024;
    const height = 1024;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;
    const cap = vmax > 0 ? vmax : 1;

    points.forEach((p) => {
        const x = ((p.lon - bounds.west) / lonSpan) * width;
        const y = ((bounds.north - p.lat) / latSpan) * height;
        const intensity = Math.min(1, (p.demand || 0) / cap);
        if (intensity <= 0) return;
        const radius = 8 + intensity * 28;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        const a = opacity * (0.25 + 0.75 * intensity);
        gradient.addColorStop(0, `rgba(255, 0, 0, ${a})`);
        gradient.addColorStop(0.35, `rgba(255, 255, 0, ${a * 0.65})`);
        gradient.addColorStop(0.7, `rgba(0, 255, 0, ${a * 0.35})`);
        gradient.addColorStop(1, 'rgba(0, 0, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    });

    return new Cesium.ImageMaterialProperty({
        image: canvas,
        transparent: true,
    });
}

export async function loadPedestrianDemand(jsonPath, options = {}) {
    const viewer = getViewer();
    clearPedestrianDemand();

    const res = await fetch(jsonPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${jsonPath}`);
    const data = await res.json();
    const points = data.points || [];
    demandMeta = data.meta || {};
    if (!points.length) throw new Error('Demand JSON has no points');

    const vmax = demandMeta.demand_p95 || demandMeta.demand_max || 1;
    const opacity = options.opacity != null ? options.opacity : 0.55;

    demandEntity = viewer.entities.add({
        id: 'pedestrian-demand-heatmap',
        rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(
                ZUIDAS_BOUNDS.west,
                ZUIDAS_BOUNDS.south,
                ZUIDAS_BOUNDS.east,
                ZUIDAS_BOUNDS.north
            ),
            material: createDemandMaterial(points, ZUIDAS_BOUNDS, opacity, vmax),
            height: 2,
            classificationType: Cesium.ClassificationType.BOTH,
        },
    });

    demandEnabled = true;
    showDemandLegend(demandMeta);
    console.log(`[Ped Demand] Loaded ${points.length} points from ${jsonPath}`);
    return points.length;
}

export function clearPedestrianDemand() {
    const viewer = getViewer();
    if (demandEntity && viewer) {
        try { viewer.entities.remove(demandEntity); } catch (_) { /* ignore */ }
    }
    demandEntity = null;
    demandEnabled = false;
    demandMeta = null;
    hideDemandLegend();
}

export function togglePedestrianDemand(show, options = {}) {
    if (show && !demandEnabled) {
        // Resolved for the active study, same as the flow network above.
        return resolveExistingPath('demand').then((url) =>
            url ? loadPedestrianDemand(url, options) : Promise.resolve()
        );
    }
    if (!show && demandEnabled) {
        clearPedestrianDemand();
    }
    return Promise.resolve();
}

export function isPedestrianDemandEnabled() {
    return demandEnabled;
}
