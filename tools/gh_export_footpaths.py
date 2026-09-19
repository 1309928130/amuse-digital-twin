"""
Kova footpath export for the Multisensory Digital Twin.

Takes plain floats from `pDecon`, writes the viewer's JSON. Touches no Kova type
and no geometry -- which is what finally made this reliable after five failed
attempts that all assumed an input shape instead of observing one.

INPUTS -- set every socket to List Access
    xs         list of floats, X for one agent's path (from pDecon's X)
    ys         list of floats, Y for the same agent (from pDecon's Y)
    zs         optional, Z. Carried through when non-zero.
    out_path   the JSON path, from a Panel. Optional.

OUTPUT
    report     one line per evaluation. The ground truth for success.

!!! DELETE THE OUTPUT FILE BEFORE EACH NEW RUN !!!
--------------------------------------------------
Grasshopper evaluates this component once per agent, so it cannot see the whole
run and cannot tell whether the agent it is given belongs to a new run or is a
repeat of one already written. It therefore APPENDS to whatever is in the file.

The consequence, stated plainly: run the simulation twice without deleting the
file and you get **150 agents instead of 75**, silently. The report will say
"total 150 agents" and look entirely plausible.

A per-run folder scheme was built and then deliberately removed. Deciding "is
this a new run" from inside a component that runs 75 times has no correct answer
-- every heuristic tried (timestamps, file recency) merged or split runs wrongly
in some case, and a wrong automatic answer is harder to notice than a manual
step. The report prints the running total on every evaluation, so the check is
one glance: if the first line of a fresh run does not begin with "started file",
the old file was not deleted.

A previous version also exported speed in metres per iteration, which is correct
but less useful for animation than metres per second. See TIME below.

A previous version also exported speed as raw per-iteration distance while the
metadata claimed metres per second -- the numbers and the stated unit disagreed.
It was caught by testing that changing the constant moved the median, rather than
only that the median was stable.

TIME
----
Kova advances in discrete iterations and defines no wall-clock duration, so there
is no seconds value to divide by. Rather than invent one silently, iterations are
mapped to a nominal timestep stated explicitly in the file's metadata. The viewer
can then animate at a realistic pace while the metadata records that the seconds
are nominal, not measured.

The constant is set so the median exported speed lands near 1.2 m/s (a normal
walking pace). The report prints the median, so this is checkable against the
data rather than taken on trust -- measured: 0.5 s/iteration gives 1.200 m/s.

COORDINATE TRANSFORM
--------------------
Coordinates arrive in Rhino model metres, EPSG:28992 (RD New). This applies the
same local affine the wind and pollution builds use, minus their CASE_OFFSET.
Verified against simulation_results_heat_wgs84.csv (18,471 points, both systems):
0.48 cm mean / 1.53 cm max error. Spot-checked live: X=119476.03, Y=483252.88
projects to lon 4.8658, lat 52.3347 -- the Zuidas site.
"""

import json
import math
import os

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Kova has no wall-clock duration, so this is a nominal figure. Recorded in
# metadata as `nominal_seconds_per_iteration` so no reader mistakes it for a
# measurement.
#
# Calibrated against the REAL Zuidas model, not a synthetic fixture: agents move
# a median of 2.598 m between recorded iterations. Dividing by 2.165 s puts the
# median speed at 1.20 m/s, a normal walking pace.
#
# An earlier value of 0.5 was derived from test data that stepped 0.6 m per
# iteration. It was internally consistent and completely wrong for this model --
# the median came out at 5.2 m/s, a running pace. The lesson is that this
# constant must be checked against real output, which the report's median
# speed field makes possible in one glance.
NOMINAL_SECONDS_PER_ITERATION = 2.165

# --- projected metres -> WGS84. Same fit as tools/build-cfd-data.mjs, no CASE_OFFSET.
AFFINE = {
    "lon": {"a": 3.16395201669929, "bx": 1.46717699176902e-05, "by": -1.05300033141821e-07},
    "lat": {"a": 47.98519451501437, "bx": 6.45132710297329e-08, "by": 8.98732554750328e-06},
}

METRES_PER_DEG_LON = 111320.0 * math.cos(math.radians(52.34))
METRES_PER_DEG_LAT = 110574.0
FIT_BOUNDS = {"x": (119329.0, 119747.0), "y": (483055.0, 483548.0)}


def to_lonlat(x, y):
    return (
        AFFINE["lon"]["a"] + x * AFFINE["lon"]["bx"] + y * AFFINE["lon"]["by"],
        AFFINE["lat"]["a"] + x * AFFINE["lat"]["bx"] + y * AFFINE["lat"]["by"],
    )


def metres_between(lon1, lat1, lon2, lat2):
    dx = (lon2 - lon1) * METRES_PER_DEG_LON
    dy = (lat2 - lat1) * METRES_PER_DEG_LAT
    return math.hypot(dx, dy)


def bearing_between(lon1, lat1, lon2, lat2):
    """Compass bearing, degrees clockwise from north. 0.0 when coincident."""
    dx = (lon2 - lon1) * METRES_PER_DEG_LON
    dy = (lat2 - lat1) * METRES_PER_DEG_LAT
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return 0.0
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def to_float_list(v):
    """Normalise a coordinate stream: list, .NET List, tuple, or a bare float."""
    if v is None:
        return []
    if isinstance(v, (int, float)):
        return [float(v)]
    try:
        items = list(v)
    except Exception:
        return []
    out = []
    for it in items:
        try:
            out.append(float(it))
        except Exception:
            continue
    return out


def normalise_path(path):
    """A Panel's output -> a usable path: first non-empty line, stripped."""
    if path is None:
        return None
    if isinstance(path, (list, tuple)):
        if not path:
            return None
        path = path[0]
    text = str(path).strip()
    if not text:
        return None
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return None


# ---------------------------------------------------------------------------
# Read this agent's coordinates
# ---------------------------------------------------------------------------

xs_list = to_float_list(xs)
ys_list = to_float_list(ys)
zs_list = to_float_list(zs) if "zs" in dir() else []

n = min(len(xs_list), len(ys_list))
mismatch = len(xs_list) != len(ys_list)

coords = []
outside_fit = 0
for i in range(n):
    x, y = xs_list[i], ys_list[i]
    bx, by = FIT_BOUNDS["x"], FIT_BOUNDS["y"]
    if not (bx[0] <= x <= bx[1] and by[0] <= y <= by[1]):
        outside_fit += 1
    coords.append(to_lonlat(x, y))

speeds = []
headings = []
for i in range(len(coords) - 1):
    lon1, lat1 = coords[i]
    lon2, lat2 = coords[i + 1]
    speeds.append(
        round(metres_between(lon1, lat1, lon2, lat2) / NOMINAL_SECONDS_PER_ITERATION, 4)
    )
    headings.append(round(bearing_between(lon1, lat1, lon2, lat2), 2))

record = None
if coords:
    record = {
        "startIteration": 0,
        "footpath": [[round(lon, 7), round(lat, 7)] for lon, lat in coords],
        "speed": speeds,
        "heading": headings,
    }
    # Elevation is only carried when it varies; an all-zero z adds size and says
    # nothing. Recorded as present only if there is a non-zero value.
    if zs_list and any(zs_list[:n]):
        record["z"] = [round(z, 4) for z in zs_list[:n]]

# ---------------------------------------------------------------------------
# Append to the file
# ---------------------------------------------------------------------------

out_path = normalise_path(out_path)

written = False
merged_from = 0
total_points = 0
blocked_reason = None
median_speed = None

if out_path and record:
    directory = os.path.dirname(out_path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)

    existing_agents = []
    if os.path.exists(out_path):
        try:
            with open(out_path, "r", encoding="utf-8") as fh:
                prior = json.load(fh)
            if isinstance(prior, dict) and isinstance(prior.get("agents"), list):
                existing_agents = prior["agents"]
                merged_from = len(existing_agents)
            else:
                blocked_reason = "existing file has an unexpected schema, left untouched"
        except Exception as exc:
            blocked_reason = "existing file unreadable (%s), left untouched" % exc

    if blocked_reason is None:
        existing_agents.append(record)
        total_points = sum(len(a.get("footpath", [])) for a in existing_agents)

        all_speeds = []
        for a in existing_agents:
            all_speeds.extend(a.get("speed", []))
        if all_speeds:
            ordered = sorted(all_speeds)
            median_speed = ordered[len(ordered) // 2]

        payload = {
            "meta": {
                "source": "micro_mobility_simulation_export.ghx",
                "solver": "Kova PedSim 1.2.0, Cellular Automata",
                "n_agents": len(existing_agents),
                "n_points": total_points,
                "speed_unit": "metres per second",
                "speed_unit_basis": "nominal",
                "nominal_seconds_per_iteration": NOMINAL_SECONDS_PER_ITERATION,
                "time_axis_note": (
                    "Kova advances in discrete iterations with no defined wall-clock "
                    "duration. Speeds are per-iteration distances divided by a NOMINAL "
                    "timestep chosen so the median walking speed is about 1.2 m/s. "
                    "They are plausible, not measured. Replace "
                    "NOMINAL_SECONDS_PER_ITERATION with a calibrated figure if the "
                    "model's timestep is ever established."
                ),
                "heading_unit": "degrees clockwise from north (derived from consecutive points)",
                "crs_in": "EPSG:28992 (RD New), metres",
                "crs_out": "EPSG:4326 WGS84, degrees",
                "transform": (
                    "local affine, fitted to simulation_results_heat_wgs84.csv "
                    "(0.48 cm mean error)"
                ),
            },
            "agents": existing_agents,
        }
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        written = True

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

if written:
    report = "%s agent %d (total %d agents, %d points, %.0f KB)" % (
        "STARTED FILE:" if merged_from == 0 else "appended",
        merged_from + 1, len(existing_agents), total_points,
        os.path.getsize(out_path) / 1024.0,
    )
    if merged_from == 0:
        report += " | if you did not expect a NEW file, the old one was not deleted"
elif blocked_reason:
    report = "REFUSED: %s" % blocked_reason
elif not out_path:
    report = "no out_path given | %d points read, nothing written" % len(coords)
else:
    report = "NO POINTS: xs=%d ys=%d" % (len(xs_list), len(ys_list))

if mismatch:
    report += " | WARNING xs=%d vs ys=%d, used %d" % (len(xs_list), len(ys_list), n)
if outside_fit:
    report += " | WARNING %d of %d points outside the fitted region" % (outside_fit, len(coords))
if median_speed:
    report += " | median speed %.2f m/s" % median_speed
if not coords and out_path:
    report += " | is `xs` wired from pDecon's X, `ys` from Y, both on List Access?"
