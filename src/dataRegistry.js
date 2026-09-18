/**
 * Per-study data resolution.
 *
 * Every assessment layer reads its input from this module rather than from a
 * literal path, so a proposal's results can live in three different places
 * without the visualisation code knowing about any of them:
 *
 *   1. **Built in, per proposal** — `simulation_data/<study>/<file>`. What the
 *      repository ships for Proposal 1, and what later assessments add.
 *   2. **Built in, shared** — `simulation_data/<file>`. The original layout,
 *      which predates proposals and still holds the flow, demand and heat files.
 *      Kept as a fallback so nothing that worked before breaks.
 *   3. **Uploaded by the visitor** — held in memory for the session. A file the
 *      user drops into the Tools page resolves like any other, and takes
 *      precedence over both of the above, because choosing a file is an explicit
 *      statement about which results to show.
 *
 * ## Why object URLs rather than a virtual filesystem
 *
 * Uploaded files are wrapped in `URL.createObjectURL`. Everything downstream
 * already fetches a URL — JSON, CSV and even the GLB loader — so a blob URL is
 * the one shape that needs no changes in the five visualisation modules. The
 * alternative, teaching each loader to branch on "is this a File or a path",
 * would have meant touching every call site instead of one.
 *
 * Blob URLs are revoked when replaced or when the study is removed, so a session
 * that uploads several revisions does not accumulate memory.
 *
 * ## What this module deliberately does not do
 *
 * It does not validate that a file *is* what its slot claims. Parsing and
 * checking happen at upload time (`toolsView.js`), where a failure can be shown
 * to the person who chose the file. By the time a path is resolved here the file
 * has already been accepted.
 */

import { getActiveStudyIdOrDefault, PROPOSALS } from './pageConfig.js';

/**
 * The assessment qualities a proposal can carry results for.
 *
 * `id` is what the Tools page shows and what uploads are keyed by; `file` is the
 * filename used for the built-in per-proposal layout. The pairing lives here
 * rather than in the Tools page so that a new quality is added in one place.
 *
 * @typedef {Object} QualityDef
 * @property {string} id
 * @property {string} label
 * @property {string} file      Filename under `simulation_data/<study>/`
 * @property {string} accept    `accept` attribute for the file input
 * @property {string} format    Human-readable format, shown in the UI
 * @property {string} consumer  Which page reads it, for the UI's benefit
 * @property {'json'|'csv'|'glb'} kind  How the file is validated on upload
 */

/** @type {QualityDef[]} */
export const QUALITIES = [
    {
        id: 'wind',
        label: 'Wind',
        file: 'wind_field.json',
        accept: '.json,application/json',
        format: 'JSON probe grid',
        consumer: 'Wind page',
        kind: 'json',
    },
    {
        id: 'pollution',
        label: 'Pollution',
        file: 'pollution_field.json',
        accept: '.json,application/json',
        format: 'JSON probe grid',
        consumer: 'Pollution page',
        kind: 'json',
    },
    {
        id: 'sunlight',
        label: 'Sunlight',
        file: 'sunlight_analysis_wgs84ready.glb',
        accept: '.glb,.gltf,model/gltf-binary',
        format: 'glTF / GLB mesh',
        consumer: 'Sunlight page',
        kind: 'glb',
    },
    {
        id: 'heat',
        label: 'Urban heat',
        file: 'simulation_results_heat_wgs84.csv',
        accept: '.csv,text/csv',
        format: 'CSV point field',
        consumer: 'Urban heat page',
        kind: 'csv',
    },
    {
        id: 'flow',
        label: 'Pedestrian flow',
        file: 'network_flow_edges.json',
        accept: '.json,application/json',
        format: 'JSON link network',
        consumer: 'Pedestrian flow page',
        kind: 'json',
    },
    {
        id: 'demand',
        label: 'Pedestrian demand',
        file: 'pedestrian_demand.json',
        accept: '.json,application/json',
        format: 'JSON raster',
        consumer: 'Micro-mobility page',
        kind: 'json',
    },
];

/** Root for built-in data, both per-proposal and the shared legacy files. */
const DATA_PREFIX = './simulation_data';

/**
 * Uploaded overrides: `studyId -> qualityId -> {url, name, size}`.
 *
 * Keyed by study then quality, mirroring how the Tools page presents things
 * ("under each proposal, add different quality results"), so clearing one
 * quality cannot disturb another.
 *
 * @type {Map<string, Map<string, {url: string, name: string, size: number}>>}
 */
const uploads = new Map();

/**
 * Proposals the visitor has added.
 *
 * The built-in three are authored in `pageConfig.js`; anything created on the
 * Tools page is kept here. Kept in this module rather than in the Tools page so
 * `getStudyList()` can return one combined view and the case-studies page does
 * not need to know the difference.
 *
 * Names are persisted to `localStorage` (see `persistStudies`), because a
 * proposal is something the visitor typed and losing it on refresh is not
 * defensible. Uploaded *files* are a different matter and are not persisted —
 * see the note on `uploads`.
 *
 * @type {Map<string, {id: string, label: string, note: string, hasData: boolean, userAdded: boolean}>}
 */
const addedStudies = new Map();

/**
 * Where added proposals are remembered between visits.
 *
 * `localStorage` rather than `sessionStorage`: a proposal is authored content,
 * not a transient view state, and a visitor who names one and comes back the
 * next day reasonably expects it to still be there. The page's own copy says
 * results are not saved, and that stays true — only the names persist.
 */
const STUDIES_KEY = 'pedmodel.tools.addedStudies';

/**
 * Where a proposal's profile image is remembered, keyed by study id.
 *
 * Stored as a data URL rather than a blob URL, and that is a real trade rather
 * than an oversight.
 *
 * The uploads proper use blob URLs, which is cheaper and keeps the bytes out of
 * storage. But this image has to survive a reload to be worth anything — a
 * proposal's picture in the case-studies picker is part of how the proposal
 * presents itself, and one that vanished on refresh would look like the same
 * disappearing-file bug the upload slots already have to apologise for. A blob
 * URL is dead as soon as the document that made it goes away, so it cannot carry
 * anything across sessions; a data URL can.
 *
 * The cost is `localStorage` quota (a few MB). So the image is downscaled before
 * it is stored (see `imageStore.js`), which keeps a typical screenshot to tens of
 * kilobytes, and a failure to store is reported rather than swallowed, because
 * the visitor's mental model is "my proposal has a picture" and they need to know
 * if that is not going to hold.
 *
 * Built-in proposals have no entry here: their artwork is a file in the repo, and
 * nothing should be able to overwrite it.
 */
const IMAGES_KEY = 'pedmodel.tools.proposalImages';

/** @type {Map<string, string>} study id -> data URL. Loaded once at module init. */
const proposalImages = new Map();

/** Read stored proposal images back from `localStorage`. */
function loadPersistedImages() {
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(IMAGES_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        Object.entries(parsed).forEach(([id, value]) => {
            // Validated as a data URL specifically. This is user-writable storage
            // and the value is fed straight to `img.src`, so anything else —
            // a remote URL, a `javascript:` string — must not get through.
            if (typeof id !== 'string' || !id) return;
            if (typeof value !== 'string' || !value.startsWith('data:image/')) return;
            proposalImages.set(id, value);
        });
    } catch (error) {
        console.warn('[dataRegistry] Could not read stored proposal images:', error);
    }
}

/**
 * Persist proposal images, reporting whether it worked.
 *
 * Distinguished from `persistStudies` by its return value: names are small and
 * a failure there is a shrug, but an image can exceed the quota, and a visitor
 * who uploaded one and then lost it silently would have no idea why. The caller
 * shows the outcome.
 *
 * @returns {{ok: boolean, error?: string}}
 */
function persistImages() {
    if (typeof localStorage === 'undefined') {
        return { ok: false, error: 'This browser has no local storage available.' };
    }
    try {
        const payload = Object.fromEntries(proposalImages);
        if (proposalImages.size === 0) {
            localStorage.removeItem(IMAGES_KEY);
        } else {
            localStorage.setItem(IMAGES_KEY, JSON.stringify(payload));
        }
        return { ok: true };
    } catch (error) {
        // Overwhelmingly a quota error: the image is too large to keep. Named as
        // such because "it did not save" without a reason invites a retry that
        // will fail identically.
        return {
            ok: false,
            error: 'Too large to save in this browser. The image is used for this session only.',
        };
    }
}

/**
 * The profile image for a study, or `null` when it has none of its own.
 *
 * Built-in proposals resolve to their authored file; visitor-added ones resolve
 * to their stored image. A visitor-added proposal with no image resolves to
 * `null` rather than borrowing anyone else's picture — the case-studies card
 * renders an empty slot for that, which is honest, where a borrowed image is
 * actively misleading.
 *
 * @param {string} studyId
 * @returns {string|null}
 */
export function getProposalImage(studyId) {
    const stored = proposalImages.get(studyId);
    if (stored) return stored;
    // Built-in artwork comes from `pageConfig`, consulted via the caller that
    // already has it (the case-studies picker) rather than duplicated here.
    return null;
}

/**
 * Attach an image to a study, as a data URL.
 *
 * @param {string} studyId
 * @param {string} dataUrl Already downscaled by `imageStore.js`.
 * @returns {{ok: boolean, error?: string}}
 */
export function setProposalImage(studyId, dataUrl) {
    if (!addedStudies.has(studyId)) {
        // Built-in proposals keep their authored artwork. Refusing here means no
        // code path can quietly replace a file that ships with the site.
        return { ok: false, error: 'Only proposals you added can have an image set.' };
    }
    proposalImages.set(studyId, dataUrl);
    const result = persistImages();
    emitChange();
    return result;
}

/** Remove a study's image, if it has one. */
export function clearProposalImage(studyId) {
    if (!proposalImages.delete(studyId)) return false;
    persistImages();
    emitChange();
    return true;
}

/** Read added proposals back from `localStorage`. */
function loadPersistedStudies() {
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(STUDIES_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        parsed.forEach((entry) => {
            // Validated field by field: this is user-writable storage, so a
            // malformed or hand-edited value must not be able to inject a study
            // with a missing id or label and break every list that renders it.
            if (!entry || typeof entry.id !== 'string' || !entry.id) return;
            if (typeof entry.label !== 'string' || !entry.label) return;
            addedStudies.set(entry.id, {
                id: entry.id,
                label: entry.label,
                note: typeof entry.note === 'string' ? entry.note : '',
                hasData: false,
                userAdded: true,
            });
        });
    } catch (error) {
        // A corrupt entry is not worth breaking the page over; start clean.
        console.warn('[dataRegistry] Could not read stored proposals:', error);
    }
}

/** Write added proposals to `localStorage`. Only names, never file data. */
function persistStudies() {
    if (typeof localStorage === 'undefined') return;
    try {
        const payload = [...addedStudies.values()].map(({ id, label, note }) => ({
            id,
            label,
            note,
        }));
        localStorage.setItem(STUDIES_KEY, JSON.stringify(payload));
    } catch (error) {
        // Private browsing and quota errors both land here. Losing persistence is
        // better than losing the in-memory proposal, so this does not propagate.
        console.warn('[dataRegistry] Could not store proposals:', error);
    }
}

// Restored at module load so the list is complete before any view renders.
loadPersistedStudies();
loadPersistedImages();

/** Fired whenever uploads or added studies change, so views can refresh. */
const listeners = new Set();

/** Subscribe to registry changes. Returns an unsubscribe function. */
export function onDataRegistryChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emitChange() {
    listeners.forEach((fn) => {
        try {
            fn();
        } catch (error) {
            console.warn('[dataRegistry] listener failed:', error);
        }
    });
}

/** A filesystem-safe id for a study the visitor names. */
export function slugifyStudyId(label) {
    const base = String(label || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    // Prefixed so a visitor-created id can never collide with the built-in
    // `proposal-N` ids, which would make an upload appear under the wrong study.
    return base ? `study-${base}` : `study-${Date.now().toString(36)}`;
}

/**
 * Every study: the built-in proposals plus any added this session.
 *
 * @returns {Array<{id: string, label: string, note: string, hasData: boolean, userAdded: boolean}>}
 */
export function getStudyList() {
    const builtIn = PROPOSALS.map((p) => ({
        id: p.id,
        label: p.label,
        note: p.note || '',
        hasData: !!p.hasData,
        userAdded: false,
        builtIn: !!p.builtIn,
    }));
    return [...builtIn, ...addedStudies.values()];
}

/**
 * Add a study the visitor named.
 *
 * @param {string} label
 * @returns {{id: string, label: string}}
 */
export function addStudy(label) {
    const clean = String(label || '').trim() || 'Untitled proposal';
    const id = slugifyStudyId(clean);
    addedStudies.set(id, {
        id,
        label: clean,
        note: 'Added by you. Results are not saved to the server.',
        hasData: false,
        userAdded: true,
    });
    persistStudies();
    emitChange();
    return { id, label: clean };
}

/** Remove an added study and everything uploaded under it. */
export function removeStudy(studyId) {
    if (!addedStudies.has(studyId)) return false;
    clearStudyUploads(studyId);
    // The image goes with the proposal: leaving it behind would strand a stored
    // data URL against an id nothing refers to any more, and that space counts
    // against the same quota the next proposal's image needs.
    if (proposalImages.delete(studyId)) persistImages();
    addedStudies.delete(studyId);
    persistStudies();
    emitChange();
    return true;
}

/**
 * The study whose data the viewer should be showing.
 *
 * Resolved through `pageConfig` so the substitution rule — a proposal with no
 * results falls back to the default — lives in one place and applies here too.
 * Without that, selecting an empty proposal would blank every page instead of
 * showing the results the header says are being shown.
 */
function activeStudyId() {
    return getActiveStudyIdOrDefault();
}

/**
 * Resolve the URL for one quality under one study, or `null` if there is none.
 *
 * Order of precedence: an upload for this study and quality, then the built-in
 * per-proposal file.
 *
 * @param {string} qualityId
 * @param {string} [studyId] Defaults to the active study.
 * @returns {string|null}
 */
export function resolveDataPath(qualityId, studyId = activeStudyId()) {
    const quality = QUALITIES.find((q) => q.id === qualityId);
    if (!quality) return null;

    const uploaded = uploads.get(studyId)?.get(qualityId);
    if (uploaded) return uploaded.url;

    return `${DATA_PREFIX}/${studyId}/${quality.file}`;
}

/**
 * The URLs to try for a quality, most specific first.
 *
 * Every quality now resolves to a per-proposal path, and nothing else. The
 * shared published layout these files used to live under (`wind/wind_field.json`
 * and the rest at the root) is deliberately no longer consulted: keeping it as a
 * fallback meant a quality could appear to work for a proposal that has no file
 * of its own, because a sibling proposal's data answered instead. The files were
 * copied into `proposal-1/`, so the per-proposal path is authoritative and a
 * missing file now reads honestly as "no results".
 *
 * @param {string} qualityId
 * @returns {string[]}
 */
export function candidatePaths(qualityId) {
    const quality = QUALITIES.find((q) => q.id === qualityId);
    if (!quality) return [];

    const study = activeStudyId();
    const uploaded = uploads.get(study)?.get(qualityId);
    if (uploaded) return [uploaded.url];

    return [`${DATA_PREFIX}/${study}/${quality.file}`];

    // --- Former shared-layout fallback, kept for reference ---
    // These were the paths used before the per-proposal folders existed. They are
    // commented out rather than deleted so the old layout stays documented and
    // the mapping back to it is obvious if the files ever need to be re-added.
    // Do not reinstate without also restoring the study guard below, or a
    // proposal with no results will silently display another proposal's data.
    //
    // const candidates = [`${DATA_PREFIX}/${study}/${quality.file}`];
    //
    // // The shared layout only applied to the study those files were authored for.
    // if (study === DEFAULT_PROPOSAL_ID) {
    //     const dir = quality.legacyDir ? `${quality.legacyDir}/` : '';
    //     candidates.push(`${DATA_PREFIX}/${dir}${quality.file}`);
    // }
    // return candidates;
}

/**
 * Find the first candidate that exists.
 *
 * Centralised so every module reports a missing file the same way, and so the
 * fallback order is written once instead of five times.
 *
 * @param {string} qualityId
 * @returns {Promise<string|null>} The URL that resolved, or null.
 */
export async function resolveExistingPath(qualityId) {
    for (const url of candidatePaths(qualityId)) {
        // Blob URLs are always valid; a HEAD against one is wasted work and some
        // browsers reject the method outright on blob: schemes.
        if (url.startsWith('blob:')) return url;
        try {
            const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
            if (res.ok) return url;
        } catch (_) {
            /* try the next candidate */
        }
    }
    return null;
}

/**
 * Register an uploaded file against a study and quality.
 *
 * Any previous object URL for the same slot is revoked, so re-uploading a
 * revision does not leak.
 *
 * @param {string} studyId
 * @param {string} qualityId
 * @param {File} file
 * @returns {{url: string, name: string, size: number}}
 */
export function setUpload(studyId, qualityId, file) {
    let forStudy = uploads.get(studyId);
    if (!forStudy) {
        forStudy = new Map();
        uploads.set(studyId, forStudy);
    }

    const previous = forStudy.get(qualityId);
    if (previous) revokeUrl(previous.url);

    const entry = {
        url: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
    };
    forStudy.set(qualityId, entry);

    // A study with results is no longer "no data", which the case-studies grid
    // and the substitution rule both read.
    const study = addedStudies.get(studyId);
    if (study) study.hasData = true;

    emitChange();
    return entry;
}

/** Remove one upload, freeing its blob URL. */
export function clearUpload(studyId, qualityId) {
    const forStudy = uploads.get(studyId);
    if (!forStudy) return false;
    const entry = forStudy.get(qualityId);
    if (!entry) return false;
    revokeUrl(entry.url);
    forStudy.delete(qualityId);
    syncStudyHasData(studyId);
    emitChange();
    return true;
}

/** Remove every upload for a study. */
export function clearStudyUploads(studyId) {
    const forStudy = uploads.get(studyId);
    if (!forStudy) return;
    forStudy.forEach((entry) => revokeUrl(entry.url));
    forStudy.clear();
    uploads.delete(studyId);
    syncStudyHasData(studyId);
}

/** The upload occupying a slot, or undefined. Used by the Tools page. */
export function getUpload(studyId, qualityId) {
    return uploads.get(studyId)?.get(qualityId);
}

/**
 * A quality that ships with the viewer for this study, if any.
 *
 * Distinguished from an upload because the two are not the same thing: a
 * built-in file is part of the published site, cannot be removed, and cannot
 * change, whereas an upload is the visitor's and can be replaced. The Tools page
 * reports both as loaded but only offers removal for the second, and this is what
 * lets it tell them apart.
 *
 * @param {string} studyId
 * @param {string} qualityId
 * @returns {{url: string, name: string, builtIn: true}|null}
 */
export function getBuiltIn(studyId, qualityId) {
    const study = getStudyList().find((s) => s.id === studyId);
    if (!study?.builtIn) return null;
    const quality = QUALITIES.find((q) => q.id === qualityId);
    if (!quality) return null;
    return {
        url: `${DATA_PREFIX}/${studyId}/${quality.file}`,
        name: quality.file,
        builtIn: true,
    };
}

/**
 * What occupies a slot, whether the visitor put it there or it shipped with the
 * viewer.
 *
 * One lookup for callers that only need to know "is there something here", so
 * the precedence between an upload and a built-in file is decided once.
 *
 * @param {string} studyId
 * @param {string} qualityId
 * @returns {{url: string, name: string, size?: number, builtIn?: true}|null}
 */
export function getSlotContent(studyId, qualityId) {
    return getUpload(studyId, qualityId) || getBuiltIn(studyId, qualityId);
}

/** How many slots a study has filled. */
export function uploadCount(studyId) {
    return uploads.get(studyId)?.size || 0;
}

/**
 * How many slots a study has filled, counting the results it ships with.
 *
 * Separate from `uploadCount` because the two answer different questions: this is
 * "how complete is this proposal", which is what the Tools page shows, while
 * `uploadCount` is "how much has the visitor brought", which the remove
 * confirmation needs. A study that ships complete should not read as empty.
 */
export function filledSlotCount(studyId) {
    const study = getStudyList().find((s) => s.id === studyId);
    if (study?.builtIn) return QUALITIES.length;
    return uploadCount(studyId);
}

/** True when the study has any usable results, built in or uploaded. */
export function studyHasData(studyId) {
    if (uploadCount(studyId) > 0) return true;
    return getStudyList().find((s) => s.id === studyId)?.hasData || false;
}

/** Recompute an added study's `hasData` after its uploads change. */
function syncStudyHasData(studyId) {
    const study = addedStudies.get(studyId);
    if (!study) return;
    study.hasData = (uploads.get(studyId)?.size || 0) > 0;
}

/**
 * Expose the API for synchronous callers that cannot import this module.
 *
 * `pageConfig.resolveStudy` needs to consult the registry, but the registry
 * imports `pageConfig`, so a static import back would be a cycle. Publishing the
 * handful of functions it needs on `window` keeps `resolveStudy` synchronous —
 * which matters because it is called from render paths all over the app — while
 * leaving the module graph acyclic.
 *
 * This is a deliberate trade: a global for one cross-cutting lookup, rather than
 * making every caller asynchronous.
 */
if (typeof window !== 'undefined') {
    window.__dataRegistry = {
        getStudyList,
        studyHasData,
        uploadCount,
        filledSlotCount,
        getUpload,
        getBuiltIn,
        getSlotContent,
        resolveDataPath,
        candidatePaths,
        getProposalImage,
        setProposalImage,
        clearProposalImage,
        QUALITIES,
    };
}

/**
 * Revoke a blob URL, ignoring browsers that reject it.
 *
 * A failure here is not worth surfacing: the URL is already unreachable, and
 * throwing would abort the state update that called us.
 */
function revokeUrl(url) {
    try {
        URL.revokeObjectURL(url);
    } catch (_) {
        /* ignore */
    }
}
