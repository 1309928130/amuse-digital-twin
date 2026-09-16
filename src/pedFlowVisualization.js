/**
 * Pedestrian demand heatmap + network flow from PedMac (PedModel) results.
 * Click an edge to show daily total and hourly flow breakdown (no hover).
 */

import { getViewer } from './cesiumViewer.js';
import { ZUIDAS_BOUNDS } from './config.js';

export const NETWORK_FLOW_JSON = './simulation_data/network_flow_edges.json';
export const PEDESTRIAN_DEMAND_JSON = './simulation_data/pedestrian_demand.json';

let flowEnabled = false;
let demandEnabled = false;
let flowPolylineCollection = null;
let flowEdges = [];
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

function flowWidth(flow, meta) {
    const t = flowNorm(flow, meta);
    return 1.5 + t * 6.5;
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
    const bars = hourly.map((v, h) => {
        const pct = Math.round((v / maxH) * 100);
        const peak = h === peakHour && v > 0 ? 'font-weight:600;color:#FFD54F;' : '';
        return `<div style="display:flex;align-items:center;gap:6px;margin:1px 0;">
            <span style="width:28px;opacity:0.85;${peak}">${String(h).padStart(2, '0')}</span>
            <div style="flex:1;height:6px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#ffe082,#e53935);"></div>
            </div>
            <span style="width:42px;text-align:right;opacity:0.9;${peak}">${formatFlow(v)}</span>
        </div>`;
    }).join('');

    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;">
            <div style="font-weight:600;">${name}</div>
            <button type="button" id="networkFlowTooltipClose" style="background:none;border:none;color:#fff;opacity:0.7;cursor:pointer;font-size:16px;line-height:1;padding:0;">×</button>
        </div>
        <div style="opacity:0.8;margin-bottom:6px;">${hwy} · UVK (${edge.u}, ${edge.v}, ${edge.k})</div>
        <div style="margin-bottom:8px;">Daily flow: <b>${formatFlow(edge.flow)}</b> ped/day</div>
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
    highlightPrimitive = new Cesium.PolylineCollection();
    viewer.scene.primitives.add(highlightPrimitive);
    const flat = [];
    edge.coords.forEach(([lon, lat]) => flat.push(lon, lat, 5));
    highlightPrimitive.add({
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
        width: Math.max(8, flowWidth(edge.flow, flowMeta) + 3),
        material: Cesium.Material.fromType('Color', {
            color: Cesium.Color.WHITE.withAlpha(0.95),
        }),
    });
}

function buildSpatialIndex(edges) {
    spatialCells = new Map();
    edges.forEach((edge, idx) => {
        const coords = edge.coords;
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
        const coords = edge.coords;
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

function hideHoverTooltip() {
    if (pinnedTooltip) return;
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

    // Hover preview: only registered on pages that ask for it
    hoverHandler.setInputAction((movement) => {
        if (!flowEnabled) return;
        const hit = pickEdgeAt(movement.endPosition);
        if (!hit) {
            hideHoverTooltip();
            return;
        }
        showHoverTooltip(hit.edge, hit.idx, movement.endPosition);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

/**
 * Load PedMac network flow edges as colored polylines.
 */
export async function loadNetworkFlow(jsonPath = NETWORK_FLOW_JSON, options = {}) {
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
    flowEdges = [];

    edges.forEach((edge) => {
        if (!edge.coords || edge.coords.length < 2) return;
        const flat = [];
        edge.coords.forEach(([lon, lat]) => flat.push(lon, lat, 3));
        flowPolylineCollection.add({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
            width: flowWidth(edge.flow, flowMeta),
            material: Cesium.Material.fromType('Color', {
                color: lerpColor(flowNorm(edge.flow, flowMeta)),
            }),
        });
        flowEdges.push(edge);
    });

    buildSpatialIndex(flowEdges);
    flowEnabled = true;
    showFlowLegend(flowMeta);
    attachClickHandler();

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

export function clearNetworkFlow() {
    const viewer = getViewer();
    detachClickHandler();
    if (flowPolylineCollection && viewer) {
        try { viewer.scene.primitives.remove(flowPolylineCollection); } catch (_) { /* ignore */ }
        try { flowPolylineCollection.destroy(); } catch (_) { /* ignore */ }
    }
    flowPolylineCollection = null;
    flowEdges = [];
    spatialCells = new Map();
    flowEnabled = false;
    flowMeta = null;
    hideFlowLegend();
}

export function toggleNetworkFlow(show, options = {}) {
    if (show && !flowEnabled) {
        return loadNetworkFlow(NETWORK_FLOW_JSON, options);
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

export async function loadPedestrianDemand(jsonPath = PEDESTRIAN_DEMAND_JSON, options = {}) {
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
        return loadPedestrianDemand(PEDESTRIAN_DEMAND_JSON, options);
    }
    if (!show && demandEnabled) {
        clearPedestrianDemand();
    }
    return Promise.resolve();
}

export function isPedestrianDemandEnabled() {
    return demandEnabled;
}
