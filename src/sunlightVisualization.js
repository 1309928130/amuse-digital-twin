/**
 * Sunlight analysis mesh (Ladybug Direct Sun Hours → baked GLB).
 * Loads a coloured (or material) mesh and can temporarily hide design GLBs.
 */

import { getViewer } from './cesiumViewer.js';
import { loadLargeModel, removeLargeModel } from './largeModelLoader.js';
import { ZUIDAS_CENTER } from './config.js';

export const SUNLIGHT_GLB_PATH = './simulation_data/sunlight/sunlight_analysis_wgs84ready.glb';
export const SUNLIGHT_PLACEMENT_PATH = './simulation_data/sunlight/sunlight_placement.json';

let sunlightEntity = null;
let sunlightEnabled = false;
/** Design GLB entities hidden while sunlight is shown */
let hiddenDesignEntities = [];

async function resolvePlacement() {
    const fallback = {
        position: {
            longitude: ZUIDAS_CENTER.longitude,
            latitude: ZUIDAS_CENTER.latitude,
            height: 0,
        },
        orientation: { heading: 90, pitch: 0, roll: 0 },
        scale: 1.0,
    };
    try {
        const res = await fetch(SUNLIGHT_PLACEMENT_PATH, { cache: 'no-store' });
        if (!res.ok) return fallback;
        const meta = await res.json();
        const p = meta.placement_wgs84 || {};
        const o = meta.orientation_hint || fallback.orientation;
        return {
            position: {
                longitude: Number.isFinite(p.longitude) ? p.longitude : fallback.position.longitude,
                latitude: Number.isFinite(p.latitude) ? p.latitude : fallback.position.latitude,
                height: Number.isFinite(p.height) ? p.height : 0,
            },
            orientation: {
                heading: o.heading ?? 90,
                pitch: o.pitch ?? 0,
                roll: o.roll ?? 0,
            },
            scale: Number.isFinite(meta.scale) ? meta.scale : 1.0,
            meta,
        };
    } catch (e) {
        console.warn('[Sunlight] placement JSON missing, using Zuidas center', e);
        return fallback;
    }
}

/**
 * Hide design building GLBs so sunlight mesh is visible.
 * @param {Cesium.Entity[]} [extraEntities]
 */
function hideDesignGlbs(extraEntities = []) {
    const viewer = getViewer();
    hiddenDesignEntities = [];
    const candidates = [...extraEntities];
    try {
        for (const entity of viewer.entities.values) {
            if (!entity || !entity.model) continue;
            const name = String(entity.name || '');
            if (
                name.startsWith('Zuidas Datamodel') ||
                name === 'Building Block 1' ||
                name.includes('Datamodel') ||
                name.includes('export_for_visualization')
            ) {
                candidates.push(entity);
            }
        }
    } catch (_) { /* ignore */ }

    const seen = new Set();
    candidates.forEach((entity) => {
        if (!entity || seen.has(entity)) return;
        seen.add(entity);
        try {
            if (entity.show !== false) {
                entity.show = false;
                hiddenDesignEntities.push(entity);
            }
        } catch (_) { /* ignore */ }
    });
    console.log(`[Sunlight] Hid ${hiddenDesignEntities.length} design GLB entity(ies)`);
}

function restoreDesignGlbs() {
    hiddenDesignEntities.forEach((entity) => {
        try { entity.show = true; } catch (_) { /* ignore */ }
    });
    if (hiddenDesignEntities.length) {
        console.log(`[Sunlight] Restored ${hiddenDesignEntities.length} design GLB entity(ies)`);
    }
    hiddenDesignEntities = [];
}

function showSunlightLegend() {
    const panel = document.getElementById('sunlightLegend');
    if (panel) panel.style.display = 'block';
}

function hideSunlightLegend() {
    const panel = document.getElementById('sunlightLegend');
    if (panel) panel.style.display = 'none';
}

/**
 * Load Ladybug sunlight mesh. Temporarily hides design GLBs.
 * @param {{ designEntities?: Cesium.Entity[] }} [options]
 */
export async function loadSunlightAnalysis(options = {}) {
    clearSunlightAnalysis();
    const { position, orientation, scale } = await resolvePlacement();

    hideDesignGlbs(options.designEntities || []);

    let entity;
    try {
        entity = await loadLargeModel(SUNLIGHT_GLB_PATH, position, {
            name: 'Sunlight Analysis (Ladybug)',
            scale,
            minimumPixelSize: 0,
            maximumScale: 1e9,
            enableShadows: false,
            allowPicking: true,
            showLoadingIndicator: true,
            heightReference: Cesium.HeightReference.NONE,
            orientation,
            // Keep material as exported (do not force white)
            color: null,
            opacity: 1.0,
            // Local asset: don't wait for Cesium's readyPromise (it can stall here)
            readyTimeoutMs: 1500,
        });
    } catch (error) {
        // Do not leave the design massing hidden if the mesh failed to load
        restoreDesignGlbs();
        hideSunlightLegend();
        sunlightEnabled = false;
        console.error('[Sunlight] Mesh failed to load:', error);
        throw error;
    }

    // loadLargeModel resolves with a falsy value only when the entity was not created
    if (!entity) {
        restoreDesignGlbs();
        hideSunlightLegend();
        sunlightEnabled = false;
        throw new Error('Sunlight mesh entity was not created');
    }

    sunlightEntity = entity;
    sunlightEnabled = true;
    showSunlightLegend();
    console.log('[Sunlight] Mesh loaded');
    return sunlightEntity;
}

export function clearSunlightAnalysis() {
    if (sunlightEntity) {
        try { removeLargeModel(sunlightEntity); } catch (_) { /* ignore */ }
        try {
            const viewer = getViewer();
            if (viewer.entities.contains(sunlightEntity)) {
                viewer.entities.remove(sunlightEntity);
            }
        } catch (_) { /* ignore */ }
        sunlightEntity = null;
    }
    restoreDesignGlbs();
    sunlightEnabled = false;
    hideSunlightLegend();
}

export function toggleSunlightAnalysis(show, options = {}) {
    if (show && !sunlightEnabled) {
        return loadSunlightAnalysis(options);
    }
    if (!show && sunlightEnabled) {
        clearSunlightAnalysis();
    }
    return Promise.resolve();
}

export function isSunlightAnalysisEnabled() {
    return sunlightEnabled;
}
