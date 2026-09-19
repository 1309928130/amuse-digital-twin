/**
 * Sunlight analysis mesh (Ladybug Direct Sun Hours → baked GLB).
 * Loads a coloured (or material) mesh and can temporarily hide design GLBs.
 */

import { getViewer } from './cesiumViewer.js';
import { loadLargeModel, removeLargeModel } from './largeModelLoader.js';
import { ZUIDAS_CENTER } from './config.js';
import { resolveExistingPath } from './dataRegistry.js';

/**
 * Resolve the Sunlight GLB for the active study.
 *
 * Kept as a function rather than a constant because the file now depends on
 * which proposal is selected. Returns null when no mesh exists for the study,
 * so the caller can report that instead of attempting a fetch that will 404.
 */
async function resolveSunlightGlb() {
    return resolveExistingPath('sunlight');
}

/**
 * Resolve the companion placement file that positions the mesh.
 *
 * `sunlight_placement.json` sits beside the GLB and is uploaded with it, so it
 * is not a separate quality slot. Deriving it from the directory of whichever
 * GLB resolved keeps the pair together: an uploaded mesh with its own placement
 * file finds that one, and a built-in mesh finds the published one.
 *
 * There is no `HEAD` probe here because the caller already tolerates a miss by
 * falling back to the site centre, which is the pre-existing behaviour.
 */
function placementUrlFor(glbUrl) {
    if (!glbUrl) return null;
    const base = glbUrl.slice(0, glbUrl.lastIndexOf('/'));
    return `${base}/sunlight_placement.json`;
}

let sunlightEntity = null;
let sunlightEnabled = false;
/** Design GLB entities hidden while sunlight is shown */
let hiddenDesignEntities = [];

async function resolvePlacement(glbUrl) {
    const fallback = {
        position: {
            longitude: ZUIDAS_CENTER.longitude,
            latitude: ZUIDAS_CENTER.latitude,
            height: 0,
        },
        orientation: { heading: 90, pitch: 0, roll: 0 },
        scale: 1.0,
    };
    const placementUrl = placementUrlFor(glbUrl);
    if (!placementUrl) return fallback;
    try {
        const res = await fetch(placementUrl, { cache: 'no-store' });
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

    const glbUrl = await resolveSunlightGlb();
    if (!glbUrl) {
        // No mesh for this study. Report and leave the design massing alone,
        // rather than hiding it for a layer that is not going to appear.
        console.warn('[sunlight] No sunlight mesh for the active study.');
        hideSunlightLegend();
        return;
    }

    const { position, orientation, scale } = await resolvePlacement(glbUrl);

    hideDesignGlbs(options.designEntities || []);

    // ## Why the failsafe is short here
    //
    // `loadLargeModel` waits on a readiness signal that Cesium does not provide
    // for these models. Measured on this mesh and on the Zuidas massing:
    //
    //   * `entity.model` is a `ModelGraphics` -- the *description* -- and has no
    //     `ready` and no `readyPromise`, so the loader's promise branch is never
    //     taken.
    //   * It falls through to polling `model.ready`, which never becomes true.
    //   * `Cesium.Model.fromGltfAsync` is no better: it resolves immediately to
    //     an unpopulated object with no `readyPromise`.
    //
    // So there is nothing to wait for, and the timeout is the *entire* wait
    // rather than a safety net. The mesh is composited by Cesium on its own
    // schedule regardless, which is why the page works today.
    //
    // Left at the 12 s default this blocked the page for 12 s every time. The
    // value below only has to be long enough that a fast machine settles before
    // it, so it trades a little certainty about timing for a much shorter block
    // -- and `preloadSunlightMesh` moves the bytes earlier so there is less to
    // wait for in the first place.
    let entity;
    try {
        entity = await loadLargeModel(glbUrl, position, {
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
            // No loading banner. The mesh is pre-warmed by
            // `preloadSunlightMesh` and Cesium composites it as soon as it can,
            // so a "Loading ..." notice would appear and vanish within a frame
            // or two -- which reads as a glitch rather than as progress. The
            // other callers still show one, where the wait is real.
            showLoadingIndicator: false,
            // Retained for compatibility with the loader's signature. Nothing
            // blocks on it any more; see the note in `loadLargeModel`.
            readyTimeoutMs: 1200,
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
