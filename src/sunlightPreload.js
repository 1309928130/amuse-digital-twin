/**
 * Warm the sunlight mesh before the reader opens the page.
 *
 * ## Why this exists
 *
 * Opening the Sunlight page costs a ~2 MB fetch of `sunlight_analysis_*.glb`.
 * That fetch is the only part of the wait that can genuinely be shortened: the
 * loader that consumes it blocks on a fixed failsafe timer (see
 * `largeModelLoader.js`), and Cesium never reports the model as ready for
 * either the massing or this mesh, so there is no signal to wait on instead.
 * Moving the bytes earlier is therefore the whole of the available win.
 *
 * ## Why not `resolveExistingPath`
 *
 * That helper probes each candidate with a `HEAD` request to find out which of
 * them exists. A preload only needs the file itself, and the probe would add a
 * round trip in front of the fetch it is meant to accelerate, so the built-in
 * candidate is fetched directly. Uploaded meshes use `blob:` URLs and are
 * already local, so they need no warming at all.
 *
 * ## What "preload" means here
 *
 * The response is fetched and read to completion, then dropped. This is
 * deliberate: it puts the bytes in the HTTP cache so the later Cesium fetch is
 * served locally. Reading the body is required for that -- a bare `fetch`
 * resolves on the headers and leaves the body undownloaded, which would warm
 * nothing. The cost is that the bytes are held briefly; 2 MB is not a concern.
 *
 * Failure is silent by design. A preload is an optimisation, and a reader who
 * is offline or on a proposal with no mesh should reach the page and see the
 * ordinary "no result" message rather than an error from the warmer.
 */

import { getActiveStudyIdOrDefault } from './pageConfig.js';

/** The published mesh, relative to the site root. */
const SUNLIGHT_MESH_PATH = './simulation_data/proposal-1/sunlight_analysis_wgs84ready.glb';

/**
 * In-flight or completed warm-up, so repeated calls share one request.
 * `null` means "not started yet".
 * @type {Promise<void>|null}
 */
let warmPromise = null;

/** Studies whose mesh has already been requested this session. */
const warmedStudies = new Set();

/**
 * Fetch the sunlight mesh so the browser holds it before the page needs it.
 *
 * Safe to call repeatedly and from several places: the work happens at most
 * once per study per session, and concurrent callers await the same request.
 *
 * @param {string} [studyId] Study to warm; defaults to the active one.
 * @returns {Promise<void>} Resolves when the bytes are cached, or immediately
 *   if the study is already warm or has no built-in mesh to warm.
 */
export async function preloadSunlightMesh(studyId) {
    const study = studyId || getActiveStudyIdOrDefault();
    if (!study) return;
    if (warmedStudies.has(study)) return;
    if (study !== 'proposal-1') {
        // Only the built-in proposal ships a mesh on this path. A visitor's
        // upload is a blob URL and already local, so there is nothing to warm.
        warmedStudies.add(study);
        return;
    }
    if (warmPromise) return warmPromise;

    warmPromise = (async () => {
        try {
            const res = await fetch(SUNLIGHT_MESH_PATH);
            if (!res.ok) return;
            await res.arrayBuffer();
            warmedStudies.add(study);
        } catch (_) {
            /* Optimisation only -- the loader will fetch it itself on demand. */
        } finally {
            warmPromise = null;
        }
    })();
    return warmPromise;
}
