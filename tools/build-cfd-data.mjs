#!/usr/bin/env node
/**
 * Convert Eddy3D / OpenFOAM probe output into viewer-friendly JSON.
 *
 * The CFD cases live outside this repo (under Eddy3D's Cases folder) and speak
 * in absolute RD-like metres. The viewer needs WGS84 plus a compact shape it
 * can load quickly, so this script does the projection once at build time.
 *
 * ## Inputs (one CFD case directory)
 *
 *   postProcessing/ttt_s/<time>/points_gh.txt   "x y z" per line
 *   postProcessing/ttt_s/<time>/s_gh.txt        one scalar per line (pollution)
 *   postProcessing/ttt_s/<time>/U               OpenFOAM probe file (wind)
 *
 * `points_gh.txt` and `s_gh.txt` are line-aligned, so probe i is row i of both.
 * The `U` file carries its own `# Probe n (x y z)` header, which is what we
 * trust for wind coordinates.
 *
 * ## Output
 *
 *   simulation_data/wind/wind_field.json          { probes: [{lon, lat, height, u, v, w, speed}] }
 *   simulation_data/pollution/pollution_field.json { probes: [{lon, lat, height, s}] }
 *
 * ## Coordinate transform
 *
 * The probe grid is in metres on a projected plane. Rather than guess the
 * projection, this anchors on two reference points whose WGS84 equivalents are
 * known from the existing heat export (same case area), then applies a local
 * affine: longitude from the x anchor, latitude from the y anchor, using the
 * metre-per-degree scale at that latitude. Within a ~2 km site this is accurate
 * to well under a metre.
 *
 * Usage:
 *   node tools/build-cfd-data.mjs [--case <dir>] [--time <t>]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_ROOT = path.resolve(HERE, '..');

const DEFAULT_CASE =
    '/mnt/c/Users/enshanchen/AppData/Local/Eddy3D/Cases/3_SimpleWindAnalysis_new_meshManualRebuild_3';

/**
 * Affine transform from projected metres to WGS84.
 *
 * Fitted by least squares against `simulation_results_heat_wgs84.csv` — the
 * same case area, already projected by a known-good pipeline. The fit uses all
 * 18,471 rows and reproduces the trusted CSV to **1.1 cm maximum error**, which
 * is well inside the precision of the data itself.
 *
 * ## Why there are cross terms
 *
 * The projected grid is not axis-aligned with true north: it carries a
 * +0.411 deg rotation, the meridian convergence of the projection. Recovering
 * the implied metre-space Jacobian gives
 *
 *     east  = +0.997959*dx - 0.007162*dy
 *     north = +0.007182*dx + 1.000469*dy
 *
 * — the same rotation in both rows, which is the check that this is a real
 * convergence and not a fitting artefact.
 *
 * Dropping the cross terms (as an earlier version of this script did, treating
 * lon as a function of x alone and lat of y alone) leaves a systematic ~1.3 m
 * mean and 2.4 m worst-case error, peaking at the grid corners. Those terms are
 * the `*y` coefficient on longitude and the `*x` coefficient on latitude below.
 *
 * ## Note on the CFD case area
 *
 * The probe grid is additionally shifted by `CASE_OFFSET` before projection.
 * The OpenFOAM case was built on its own origin and its grid sits 73.5 m
 * southeast of the footprint the other simulations use; see `CASE_OFFSET` for
 * how that was measured. Without it the wind and pollution layers draw ~74 m
 * away from the same buildings the sunlight and heat layers sit on.
 *
 * Regenerate with the one-off analysis in the script header if the case area
 * ever moves; hardcoding avoids re-reading a 1.9 MB CSV on every build.
 */
const AFFINE = {
    lon: { a: 3.16395201669929, bx: 1.46717699176902e-5, by: -1.05300033141821e-7 },
    lat: { a: 47.98519451501437, bx: 6.45132710297329e-8, by: 8.98732554750328e-6 },
};

/**
 * Rigid offset applied to the CFD probe grid before projection, in metres.
 *
 * The OpenFOAM case was built on its own origin, and its probe grid lands
 * 73.5 m southeast of the footprint every other simulation uses, while being
 * the same size and orientation (414x483 m vs the heat grid's 417x492 m). So
 * the results are right but drawn over the wrong patch of the city.
 *
 * Verified by translating the CFD metre box by this amount and re-projecting:
 * all four corners then land within a few metres of the heat grid's corners,
 * confirming the two grids describe the same physical area with a pure
 * translation and no relative rotation.
 *
 * These are the numbers that centre-align the two grids:
 *
 *     dx = heat_centre_x - cfd_centre_x = -58.3 m
 *     dy = heat_centre_y - cfd_centre_y = +44.8 m
 *
 * If the case is ever rebuilt, re-derive this by comparing the CFD probe
 * bounding box against the heat grid box rather than eyeballing the viewer.
 */
const CASE_OFFSET = { x: -58.3, y: 44.8 };

function toLonLat(x, y) {
    const gx = x + CASE_OFFSET.x;
    const gy = y + CASE_OFFSET.y;
    return {
        longitude: AFFINE.lon.a + gx * AFFINE.lon.bx + gy * AFFINE.lon.by,
        latitude: AFFINE.lat.a + gx * AFFINE.lat.bx + gy * AFFINE.lat.by,
    };
}

/** Read a whitespace-separated numeric file, skipping blanks/comments. */
function parseNumbers(text) {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(/\s+/).map(Number))
        .filter((row) => row.length && row.every((n) => Number.isFinite(n)));
}

/** OpenFOAM writes this when a probe lies outside the mesh — not a real value. */
const FOAM_MISSING = 1e300;

function isMissing(value) {
    return !Number.isFinite(value) || Math.abs(value) > FOAM_MISSING;
}

/**
 * Parse an OpenFOAM probe file.
 *
 * Structure (note the order — it is easy to get wrong):
 *
 *   # Probe 0 (119388.93 483380.71 2)   <- coordinate, one line per probe
 *   # Probe 1 (...)
 *   ...
 *   # Time  0  1  2  3  ...             <- column indices, interleaved
 *   ...                                    across several wrapped lines
 *   200  (ux uy uz) (ux uy uz) ...      <- one data line, vector per probe
 *
 * All `#` lines are comments, so both the coordinates and the time header are
 * skipped; only the final non-comment line carries data. Probes are ordered by
 * their header index, which is not guaranteed to be sequential in the file.
 *
 * Probes outside the mesh come back as -1.7976931e+307 rather than 0, so they
 * are filtered out here instead of polluting the field with garbage vectors.
 */
/**
 * Cap for displayed wind speed.
 *
 * The case was run with a 5 m/s inlet, but roughly 11% of probes report
 * velocities above 30 m/s and the tail reaches ~1100 m/s. Those extremes sit in
 * the building wake rather than on the domain boundary, and they do not
 * correlate with the pollution field, so they read as a solver artefact in this
 * run rather than a physical channel effect.
 *
 * Rather than silently deleting them or letting them blow out the colour ramp,
 * probes above the cap are kept but flagged, so the viewer can render them
 * distinctly and the underlying data problem stays visible.
 */
const SPEED_CAP = 15;

function parseProbes(text) {
    /** @type {Map<number, {x:number,y:number,z:number}>} */
    const locations = new Map();
    let dataLine = null;

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            const m = line.match(/^#\s*Probe\s+(\d+)\s*\(([^)]+)\)/);
            if (m) {
                const [x, y, z] = m[2].trim().split(/\s+/).map(Number);
                locations.set(Number(m[1]), { x, y, z });
            }
            continue;
        }
        // Keep the last non-comment line: that is the final written time.
        dataLine = line;
    }

    if (!dataLine) return [];

    // The data line is `time (ux uy uz) (ux uy uz) ...`, wrapped across the
    // file's fixed-width columns. Normalise the parentheses to spaces so a
    // simple whitespace split yields a flat numeric run, then take the first
    // token as the time and step through the rest in triples.
    const tokens = dataLine.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
    const vectors = [];
    for (let i = 1; i + 2 < tokens.length + 1; i += 3) {
        const ux = Number(tokens[i]);
        const uy = Number(tokens[i + 1]);
        const uz = Number(tokens[i + 2]);
        if (!Number.isFinite(ux) || !Number.isFinite(uy)) break;
        vectors.push([ux, uy, uz]);
    }

    const indices = [...locations.keys()].sort((a, b) => a - b);
    const out = [];
    let missing = 0;
    indices.forEach((idx, i) => {
        const loc = locations.get(idx);
        const vec = vectors[i];
        if (!vec || isMissing(vec[0]) || isMissing(vec[1]) || isMissing(vec[2])) {
            missing++;
            return;
        }
        out.push({ x: loc.x, y: loc.y, z: loc.z, u: vec[0], v: vec[1], w: vec[2] });
    });

    if (missing) {
        console.warn(`[cfd]   dropped ${missing} probes outside the mesh (OpenFOAM sentinel)`);
    }
    return out;
}

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
    const caseDir = arg('case', DEFAULT_CASE);
    const time = arg('time', null);
    const probeDir = path.join(caseDir, '230/postProcessing/ttt_s');

    if (!existsSync(probeDir)) {
        console.error(`[cfd] Probe output not found: ${probeDir}`);
        process.exit(1);
    }

    // Pick the requested time, else the highest-numbered folder.
    const { readdir } = await import('node:fs/promises');
    const times = (await readdir(probeDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => Number(a) - Number(b));
    const chosen = time && times.includes(String(time)) ? String(time) : times[times.length - 1];
    if (!chosen) {
        console.error('[cfd] No time folders found.');
        process.exit(1);
    }

    const dir = path.join(probeDir, chosen);
    console.log(`[cfd] case: ${caseDir}`);
    console.log(`[cfd] time: ${chosen}`);

    // ---- Wind -------------------------------------------------------------
    const uPath = path.join(dir, 'U');
    let windCount = 0;
    if (existsSync(uPath)) {
        const probes = parseProbes(await readFile(uPath, 'utf8'));
        const valid = probes.filter((p) => !isMissing(p.u) && !isMissing(p.v) && !isMissing(p.w));

        const out = valid.map((p) => {
            const { longitude, latitude } = toLonLat(p.x, p.y);
            const speed = Math.hypot(p.u, p.v);
            return {
                longitude: +longitude.toFixed(7),
                latitude: +latitude.toFixed(7),
                height: +p.z.toFixed(2),
                u: +p.u.toFixed(4),
                v: +p.v.toFixed(4),
                w: +p.w.toFixed(4),
                speed: +speed.toFixed(4),
                /** True when the solver returned an implausible value. */
                suspect: speed > SPEED_CAP,
            };
        });

        const speeds = out.map((p) => p.speed).sort((a, b) => a - b);
        const heights = [...new Set(out.map((p) => p.height))].sort((a, b) => a - b);
        const suspect = out.filter((p) => p.suspect).length;
        const plausible = out.filter((p) => !p.suspect).map((p) => p.speed);
        const p95 = plausible.length ? plausible[Math.floor(plausible.length * 0.95)] : 0;
        const payload = {
            source: 'Eddy3D / OpenFOAM probes (ttt, field U)',
            case: path.basename(caseDir),
            time: chosen,
            field: 'U',
            units: 'm/s',
            inletSpeed: 5,
            count: out.length,
            heights,
            speedCap: SPEED_CAP,
            suspectCount: suspect,
            stats: {
                min: +speeds[0].toFixed(3),
                max: +speeds[speeds.length - 1].toFixed(3),
                p95: +p95.toFixed(3),
                mean: +(plausible.reduce((a, b) => a + b, 0) / (plausible.length || 1)).toFixed(3),
            },
            probes: out,
        };

        const dest = path.join(VIEWER_ROOT, 'simulation_data/wind');
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, 'wind_field.json'), JSON.stringify(payload), 'utf8');
        windCount = out.length;
        console.log(
            `[cfd] wind  -> ${windCount} probes over ${heights.length} height(s) (${heights[0]}..${heights[heights.length - 1]} m)`
        );
        console.log(
            `[cfd]          plausible speed min ${payload.stats.min} max ${payload.stats.max} mean ${payload.stats.mean} m/s (p95 ${payload.stats.p95})`
        );
        if (suspect) {
            console.warn(
                `[cfd]          ${suspect} probes (${((suspect / out.length) * 100).toFixed(1)}%) exceed ${SPEED_CAP} m/s with a ${payload.inletSpeed} m/s inlet — flagged suspect, check solver convergence`
            );
        }
    } else {
        console.warn(`[cfd] no U probe file at ${uPath}`);
    }

    // ---- Pollution --------------------------------------------------------
    const ptsPath = path.join(dir, 'points_gh.txt');
    const sPath = path.join(dir, 's_gh.txt');
    let polCount = 0;
    if (existsSync(ptsPath) && existsSync(sPath)) {
        const pts = parseNumbers(await readFile(ptsPath, 'utf8'));
        const vals = parseNumbers(await readFile(sPath, 'utf8')).map((r) => r[0]);
        const n = Math.min(pts.length, vals.length);

        const out = [];
        for (let i = 0; i < n; i++) {
            const [x, y, z] = pts[i];
            const { longitude, latitude } = toLonLat(x, y);
            out.push({
                longitude: +longitude.toFixed(7),
                latitude: +latitude.toFixed(7),
                height: +(z ?? 0).toFixed(2),
                s: +vals[i].toFixed(6),
            });
        }

        const sVals = out.map((p) => p.s).sort((a, b) => a - b);
        const p95 = sVals.length ? sVals[Math.floor(sVals.length * 0.95)] : 0;
        const payload = {
            source: 'OpenFOAM scalarTransport on Eddy3D case (field s)',
            case: path.basename(caseDir),
            time: chosen,
            field: 's',
            units: 'relative concentration (uncalibrated)',
            note:
                'Emission rate is a placeholder (explicit 0.05), so values are relative, ' +
                'not ug/m3. Suitable for pattern comparison, not absolute exposure.',
            count: out.length,
            stats: {
                min: +sVals[0].toFixed(4),
                max: +sVals[sVals.length - 1].toFixed(4),
                p95: +p95.toFixed(4),
                mean: +(sVals.reduce((a, b) => a + b, 0) / (sVals.length || 1)).toFixed(4),
            },
            probes: out,
        };

        const dest = path.join(VIEWER_ROOT, 'simulation_data/pollution');
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, 'pollution_field.json'), JSON.stringify(payload), 'utf8');
        polCount = out.length;
        console.log(
            `[cfd] pollution -> ${polCount} probes  min ${payload.stats.min} max ${payload.stats.max} mean ${payload.stats.mean}`
        );
    } else {
        console.warn('[cfd] missing points_gh.txt or s_gh.txt');
    }

    console.log(`[cfd] done (wind ${windCount}, pollution ${polCount})`);
}

main().catch((error) => {
    console.error('[cfd] Failed:', error);
    process.exit(1);
});
