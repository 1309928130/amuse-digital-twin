/**
 * Upload validation.
 *
 * A viewer that accepts a file and then draws nothing is worse than one that
 * refuses it: the user cannot tell whether the data is wrong, the coordinate
 * system is wrong, or the tool is broken. So every upload is parsed here and
 * either accepted with a summary of what was found, or rejected with a reason
 * specific enough to act on.
 *
 * ## What is checked, and what is not
 *
 * The checks are the ones that distinguish a *plausible* file from a *wrong*
 * one — the column names each module reads, whether coordinates fall inside the
 * site area, whether values are finite. They are deliberately not exhaustive:
 * this validates that a file will render somewhere sensible, not that the
 * simulation behind it was correct, which no parser can know.
 *
 * All parsing happens in the browser and nothing is transmitted; the only thing
 * that changes is which blob URL the resolver hands to a layer.
 */

import { QUALITIES } from './dataRegistry.js';

/**
 * Plausible coordinate window around the Zuidas case.
 *
 * Used to catch the most common and most confusing failure: a file written in
 * projected metres (or in the wrong hemisphere) that parses cleanly but lands
 * thousands of kilometres away. Generous enough to admit a larger study area
 * around the case, tight enough that a projected x/y is obviously foreign.
 */
const SITE_WINDOW = {
    lonMin: 4.7,
    lonMax: 5.1,
    latMin: 52.2,
    latMax: 52.5,
};

/** @typedef {{ok: boolean, summary: string, detail?: string, warnings?: string[]}} Check */

function fail(summary, detail) {
    return { ok: false, summary, detail };
}

function pass(summary, detail, warnings = []) {
    return { ok: true, summary, detail, warnings };
}

/** Is a number finite and present? */
function isNum(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Format a count for a message. */
function n(count) {
    return Number(count).toLocaleString('en-GB');
}

/** How many coordinates fall outside the site window. */
function outsideSite(points) {
    let outside = 0;
    points.forEach(([lon, lat]) => {
        if (
            !Number.isFinite(lon) ||
            !Number.isFinite(lat) ||
            lon < SITE_WINDOW.lonMin ||
            lon > SITE_WINDOW.lonMax ||
            lat < SITE_WINDOW.latMin ||
            lat > SITE_WINDOW.latMax
        ) {
            outside += 1;
        }
    });
    return outside;
}

/**
 * Warn when coordinates look projected rather than geographic.
 *
 * Values in the hundreds of thousands are metres in a national grid, and a
 * clean-looking file full of them is the classic "rendered in the wrong place"
 * bug. Reported as a warning rather than a rejection because a study area far
 * from Zuidas is legitimate, just unusual, and the same check cannot tell the
 * two apart.
 */
function crsWarning(points) {
    if (!points.length) return [];
    const magnitude = points.map(([lon, lat]) => Math.max(Math.abs(lon), Math.abs(lat)));
    const looksProjected = magnitude.filter((m) => m > 1000).length > points.length / 2;
    if (!looksProjected) return [];
    return [
        'Coordinates are in the hundreds of thousands, which usually means a projected ' +
            'grid (metres) rather than longitude/latitude in degrees. Expect the result ' +
            'to land in the wrong place — convert to WGS84 first.',
    ];
}

/** Parse JSON, turning a syntax error into a readable failure. */
function parseJson(text, label) {
    try {
        return { value: JSON.parse(text) };
    } catch (error) {
        return { error: fail(`${label} is not valid JSON`, String(error.message || error)) };
    }
}

/** Validation for the wind and pollution probe grids. */
function checkProbeField(quality, data) {
    if (!data || typeof data !== 'object') {
        return fail('Expected a JSON object');
    }
    if (!Array.isArray(data.probes)) {
        return fail(
            'No "probes" array',
            'Both CFD fields are a JSON object with a "probes" array; each probe carries ' +
                'longitude, latitude and its value.'
        );
    }
    if (!data.probes.length) {
        return fail('The "probes" array is empty');
    }

    const isWind = quality.id === 'wind';
    const sample = data.probes[0];

    // The published files use the spelled-out keys; `lon`/`lat` are accepted
    // because they are what most exports produce and the layer reads either.
    const lonKey = 'longitude' in sample ? 'longitude' : 'lon' in sample ? 'lon' : null;
    const latKey = 'latitude' in sample ? 'latitude' : 'lat' in sample ? 'lat' : null;
    if (!lonKey || !latKey) {
        return fail(
            'Probes have no coordinates',
            `A probe needs longitude and latitude (or lon and lat). Found the keys: ${
                Object.keys(sample).join(', ') || '(none)'
            }.`
        );
    }

    const components = isWind ? ['u', 'v'] : ['s'];
    const missing = components.filter((key) => !(key in sample));
    if (missing.length) {
        return fail(
            `Probes are missing ${missing.join(', ')}`,
            isWind
                ? 'A wind probe needs u and v components in m/s (w is optional).'
                : 'A pollution probe needs a scalar concentration at "s".'
        );
    }

    const points = [];
    let badValues = 0;
    data.probes.forEach((probe) => {
        const lon = Number(probe[lonKey]);
        const lat = Number(probe[latKey]);
        points.push([lon, lat]);
        if (components.some((key) => !Number.isFinite(Number(probe[key])))) badValues += 1;
    });

    const warnings = crsWarning(points);
    const outside = outsideSite(points);
    if (outside) {
        warnings.push(
            `${n(outside)} of ${n(points.length)} probes fall outside the Zuidas area. ` +
                'Those points will draw off-site or not at all.'
        );
    }
    if (badValues) {
        warnings.push(
            `${n(badValues)} probes carry a non-numeric value and will be skipped when drawn.`
        );
    }

    const stats = data.stats || {};
    const range = isNum(stats.min) && isNum(stats.max) ? ` Range ${stats.min}–${stats.max}.` : '';
    const plural = data.probes.length === 1 ? 'probe' : 'probes';
    return pass(
        `${n(data.probes.length)} ${plural}`,
        `${isWind ? 'Wind' : 'Pollution'} field with ${lonKey}/${latKey} coordinates.${range}`,
        warnings
    );
}

/** Validation for the heat CSV, whose columns are read by header name. */
function checkHeatCsv(text) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
    if (lines.length < 2) {
        return fail('The CSV has no data rows', 'Expected a header row and at least one row.');
    }

    const headers = lines[0].split(',').map((h) => h.trim());

    // Column precedence matters: the exported heat CSV carries both the Rhino
    // plane coordinates (x, y — metres) and the projected ones (longitude,
    // latitude — degrees). Picking `x`/`y` first would compare metres against a
    // geographic window and report the entire file as off-site. The layer's own
    // parser prefers the geographic names, so this must too.
    //
    // Resolved by iterating the candidate names in order and taking the first
    // that is present. Iterating the headers instead would return whichever of
    // the two happens to come first in the file, which is the opposite of the
    // precedence this needs.
    const findCol = (names) => {
        for (const name of names) {
            const index = headers.indexOf(name);
            if (index >= 0) return index;
        }
        return -1;
    };
    const lonIndex = findCol(['longitude', 'lon', 'x']);
    const latIndex = findCol(['latitude', 'lat', 'y']);
    if (lonIndex < 0 || latIndex < 0) {
        return fail(
            'No longitude/latitude columns',
            `Found the columns: ${headers.join(', ') || '(none)'}. The heat CSV is read by ` +
                'header name, so it needs longitude/latitude (or lon/lat, or x/y).'
        );
    }

    const points = [];
    let malformed = 0;
    for (let i = 1; i < lines.length; i += 1) {
        const cols = lines[i].split(',');
        const lon = parseFloat(cols[lonIndex]);
        const lat = parseFloat(cols[latIndex]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            malformed += 1;
            continue;
        }
        points.push([lon, lat]);
    }

    if (!points.length) {
        return fail('No usable coordinate rows', `All ${n(lines.length - 1)} rows failed to parse.`);
    }

    const warnings = crsWarning(points);
    const outside = outsideSite(points);
    if (outside) {
        warnings.push(`${n(outside)} of ${n(points.length)} rows fall outside the Zuidas area.`);
    }
    if (malformed) {
        warnings.push(`${n(malformed)} rows have unparseable coordinates and will be skipped.`);
    }

    const hasVectors = headers.includes('vx') && headers.includes('vy');
    return pass(
        `${n(points.length)} ${points.length === 1 ? "row" : "rows"}`,
        hasVectors
            ? 'Point field with per-row direction vectors, read as a flow field.'
            : 'Point field. No vx/vy columns, so this renders as a scalar field without ' +
                  'direction arrows.',
        warnings
    );
}

/**
 * Validation for the sunlight GLB.
 *
 * Only the header is inspected. Parsing a full mesh to validate it would mean
 * decoding megabytes the viewer will decode again, and a GLB with a valid magic
 * number and length is about as much as can be established without a renderer.
 */
function checkGlb(buffer) {
    if (buffer.byteLength < 12) {
        return fail('The file is too small to be a GLB');
    }
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    // 'glTF' little-endian
    if (magic !== 0x46546c67) {
        return fail(
            'Not a binary glTF file',
            'A .glb starts with the ASCII characters "glTF". A .gltf is JSON and would ' +
                'need to be exported as binary, or converted first.'
        );
    }
    const version = view.getUint32(4, true);
    if (version !== 2) {
        return fail(`Unsupported glTF version ${version}`, 'glTF 2.0 is required.');
    }
    const declared = view.getUint32(8, true);
    const warnings = [];
    if (declared !== buffer.byteLength) {
        warnings.push(
            `The header declares ${n(declared)} bytes but the file is ${n(buffer.byteLength)} ` +
                'bytes. It may be truncated.'
        );
    }
    return pass(
        `${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB mesh`,
        'glTF 2.0 binary. Vertex colours are used as exported, so bake the false-colour ' +
            'result into the mesh before exporting.',
        warnings
    );
}

/** Validation for the flow link network. */
function checkNetwork(data) {
    const links = Array.isArray(data) ? data : data?.links || data?.edges;
    if (!Array.isArray(links)) {
        return fail(
            'No link array',
            'Expected either an array of links or an object with a "links" (or "edges") ' +
                'array. Each link names its endpoints and its flow value.'
        );
    }
    if (!links.length) return fail('The link array is empty');

    const sample = links[0];
    const keys = Object.keys(sample || {});
    const hasFlow = keys.some((k) => /flow|count|volume|value/i.test(k));
    const warnings = [];
    if (!hasFlow) {
        warnings.push(
            'No obvious flow column (expected a key matching flow, count, volume or value). ' +
                `Found: ${keys.join(', ') || '(none)'}.`
        );
    }
    return pass(
        `${n(links.length)} ${links.length === 1 ? "link" : "links"}`,
        `Pedestrian network links. Keys found: ${keys.join(', ') || '(none)'}.`,
        warnings
    );
}

/** Validation for the demand raster. */
function checkDemand(data) {
    const cells = Array.isArray(data) ? data : data?.cells || data?.points || data?.demand;
    if (!Array.isArray(cells)) {
        return fail(
            'No demand array',
            'Expected an array of cells, or an object with a "cells" (or "points") array, ' +
                'each carrying a location and a trip count.'
        );
    }
    if (!cells.length) return fail('The demand array is empty');
    const keys = Object.keys(cells[0] || {});
    return pass(
        `${n(cells.length)} ${cells.length === 1 ? "cell" : "cells"}`,
        `Pedestrian demand raster. Keys found: ${keys.join(', ') || '(none)'}.`
    );
}

/**
 * Validate one uploaded file against the quality slot it was dropped into.
 *
 * @param {string} qualityId
 * @param {File} file
 * @returns {Promise<Check>}
 */
export async function validateUpload(qualityId, file) {
    const quality = QUALITIES.find((q) => q.id === qualityId);
    if (!quality) return fail(`Unknown quality "${qualityId}"`);

    // Read as text for the parsers and as a buffer for the GLB header, choosing
    // one so a large mesh is not turned into a string first.
    try {
        if (quality.kind === 'glb') {
            const buffer = await file.arrayBuffer();
            const check = checkGlb(buffer);
            if (!check.ok) return check;
            // A GLB has no meaningful companion parse, so wrap the result.
            return check;
        }

        const text = await file.text();

        if (quality.kind === 'csv') {
            return checkHeatCsv(text);
        }

        const parsed = parseJson(text, quality.label);
        if (parsed.error) return parsed.error;
        const data = parsed.value;

        switch (quality.id) {
            case 'wind':
            case 'pollution':
                return checkProbeField(quality, data);
            case 'flow':
                return checkNetwork(data);
            case 'demand':
                return checkDemand(data);
            default:
                // A JSON quality with no specific schema check: accept it, but
                // say plainly that it was only checked for being valid JSON.
                return pass(
                    'Valid JSON',
                    'No schema check is defined for this slot, so the file was only ' +
                        'confirmed to parse.'
                );
        }
    } catch (error) {
        return fail('Could not read the file', String(error.message || error));
    }
}
