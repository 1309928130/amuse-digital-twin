"""
Kova footpath export for the Multisensory Digital Twin (geometry-based).

Runs inside a Grasshopper `Python 3 Script` component (Rhino 8).

WHY THIS VERSION IS DIFFERENT
-----------------------------
An earlier version tried to read Kova's objects directly -- `Simulation Results`
gave a `Kova_CA_SimulationData`, and the deconstructor gives
`Kova_CA_AgentInstance` / `Kova_CA_AgentHistory`. All of them were introspected
and all of them exposed only the eight inherited `System.Object` members
(`Equals`, `GetType`, `ToString`, ...). No Kova property is visible to dynamic
Python in this build, so no amount of field-name guessing could work.

This version never touches a Kova object. It takes the values Kova already
emits onto the canvas as ordinary Rhino types -- `Point3d`, floats, strings --
which cross the scripting boundary without difficulty.

INPUTS
    footpaths        list of Point3d, one agent's path. Wire the `Footpath`
                     output through `Pt` so the tree is flattened to a single
                     flat list, then into here.
    out_path         JSON output path (usually from a Panel). Optional.

    The agent id and height inputs were dropped deliberately. A flattened
    Footpath branch carries one agent's points, so there is no agent list to
    index into, and an unused socket invites wiring something meaningless into
    it. If you later want per-agent attributes, add them as extra inputs and
    they will be picked up by the same name.

OUTPUT
    report           one line. This is the ground truth for success; do not
                     judge by component colour.

DESIGN NOTES
------------
Splitting a flat list of Point3d back into per-agent paths
----------------------------------------------------------
A flattened Footpath tree loses the branch structure, so this component cannot
tell where one agent's path ends and the next begins from the points alone.
Rather than invent a heuristic that would silently mis-assign agents, the
script accepts EITHER:

    a) a list of lists / list of branches (one inner list per agent), or
    b) a single flat list, treated as ONE agent's path.

Case (b) is the common one when a single branch is fed in. If you need many
agents, feed the un-flattened tree, or wire the agent count in via `agent_ids`
and this will split evenly. Guessing a split from geometry would be worse than
an honest single agent, because a wrong split produces plausible-looking but
incorrect data.

Time and speed
--------------
Kova advances in discrete iterations and defines no wall-clock duration.
`SECONDS_PER_ITERATION` is 0, meaning "uncalibrated": speeds are written in
metres per iteration and labelled as such. Setting a guessed value would put
fabricated units in front of a reviewer, which is worse than an honest unit
that needs one calibration run to pin down.

Coordinate transform
--------------------
Kova points arrive in Rhino model metres, EPSG:28992 (RD New). This applies the
same local affine the wind and pollution builds use, minus their CASE_OFFSET.
Verified against simulation_results_heat_wgs84.csv (18,471 points, both systems):
0.48 cm mean / 1.53 cm max error. Also sanity-checked against a live Footpath
point (X=119476.03) which projects to lon 4.8662, lat 52.3343 -- the Zuidas
site -- confirming the fit covers the Kova footprint.
"""

import json
import math
import os

# 0 means "not calibrated". See the note above before changing this.
SECONDS_PER_ITERATION = 0

# --- projected metres -> WGS84. Same fit as tools/build-cfd-data.mjs, no CASE_OFFSET.
AFFINE = {
    "lon": {"a": 3.16395201669929, "bx": 1.46717699176902e-05, "by": -1.05300033141821e-07},
    "lat": {"a": 47.98519451501437, "bx": 6.45132710297329e-08, "by": 8.98732554750328e-06},
}

METRES_PER_DEG_LON = 111320.0 * math.cos(math.radians(52.34))
METRES_PER_DEG_LAT = 110574.0

# Bounds of the grid the affine was fitted over. Points outside are extrapolated,
# where the fit's error is unmeasured, so they are counted and reported.
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


def as_sequence(v):
    """Normalise whatever Grasshopper handed over into a plain Python list."""
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return list(v)
    # .NET / Grasshopper arrays and List[T]
    try:
        return list(v)
    except Exception:
        return [v]


def is_pointish(item):
    """True if item looks like a single point rather than a collection."""
    return xy_of(item) is not None


def to_plain(v):
    """
    Convert a nested container to a plain Python list, if it is one.

    Grasshopper hands tree branches over as .NET `List[Point3d]`, which is NOT a
    Python `list` or `tuple`. An earlier version tested `isinstance(x, (list,
    tuple))` and therefore failed to recognise a nested tree, fell through to the
    flat path, and then skipped every branch as a "non-point item" -- which is
    exactly the failure the report showed (`1 non-point items skipped`,
    `0 agents`).

    Detecting by *reachability* rather than by exact type means this works for
    Python lists, tuples, .NET Lists, and arrays alike.
    """
    if v is None:
        return None
    if isinstance(v, (list, tuple)):
        return list(v)
    try:
        return list(v)
    except Exception:
        return None


def classify(raw):
    """
    Work out whether `raw` is a flat list of points or a list of per-agent paths.

    Returns (groups, grouping_label). Content is the test, not the type: if the
    first element can be read as a point, then `raw` is flat. If instead the
    first element is itself a container whose first element reads as a point,
    then `raw` is nested, one inner container per agent.
    """
    if not raw:
        return [], "empty input"

    first = raw[0]

    # Flat: the first element is itself a point.
    if is_pointish(first):
        return [raw], "single agent (flat footpath branch)"

    # Nested: the first element is a container of points.
    inner = to_plain(first)
    if inner is not None:
        if not inner:
            # An empty first branch is still a valid (empty) agent path.
            groups = []
            for item in raw:
                branch = to_plain(item)
                groups.append(branch if branch is not None else [])
            return groups, "nested input (%d branches, one per agent)" % len(groups)
        if is_pointish(inner[0]):
            groups = []
            for item in raw:
                branch = to_plain(item)
                groups.append(branch if branch is not None else [])
            return groups, "nested input (%d branches, one per agent)" % len(groups)

    # Not recognisable either way; hand it back so the caller can report the skip.
    return [raw], "unrecognised input shape"


def xy_of(item):
    """
    Pull (x, y) out of a Point3d, a 2-item list, or a dict.

    Rhino's Point3d exposes .X/.Y/.Z, and Grasshopper Python usually gives the
    real type, but a point can also arrive as a tuple after some components.
    Returns None if this item is not a point at all, so the caller can report
    rather than crash.
    """
    if item is None:
        return None
    for ax, ay in (("X", "Y"), ("x", "y")):
        try:
            x, y = getattr(item, ax), getattr(item, ay)
            if x is not None and y is not None:
                return float(x), float(y)
        except Exception:
            pass
    if isinstance(item, dict):
        for kx, ky in (("X", "Y"), ("x", "y"), ("0", "1")):
            if kx in item and ky in item:
                try:
                    return float(item[kx]), float(item[ky])
                except Exception:
                    pass
    try:
        if len(item) >= 2:
            return float(item[0]), float(item[1])
    except Exception:
        pass
    return None


def normalise_path(path):
    """Turn a Panel's output into a usable path: first non-empty line, stripped."""
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
# Read the inputs
# ---------------------------------------------------------------------------

raw_points = as_sequence(footpaths)
point_groups, grouping = classify(raw_points)

agent_records = []
skipped_bad = 0
outside_fit = 0
empty_paths = 0

for group_index, group in enumerate(point_groups):
    coords = []
    for item in group:
        xy = xy_of(item)
        if xy is None:
            skipped_bad += 1
            continue
        x, y = xy
        bx, by = FIT_BOUNDS["x"], FIT_BOUNDS["y"]
        if not (bx[0] <= x <= bx[1] and by[0] <= y <= by[1]):
            outside_fit += 1
        coords.append(to_lonlat(x, y))

    # An empty branch is a real agent with no recorded positions (it may never
    # have entered the simulation). Dropping it would understate the agent count
    # in the viewer, so it is kept as an empty path and counted in the report.
    if not coords:
        empty_paths += 1
        agent_records.append(
            {
                "id": group_index,
                "height": None,
                "startIteration": 0,
                "footpath": [],
                "speed": [],
                "heading": [],
            }
        )
        continue

    speeds = []
    headings = []
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        speeds.append(round(metres_between(lon1, lat1, lon2, lat2), 4))
        headings.append(round(bearing_between(lon1, lat1, lon2, lat2), 2))

    # Height and agent id are not available here: a flattened Footpath branch
    # carries positions only, and the deconstructor's Height/ID outputs are
    # separate ports. Left null rather than filled with a placeholder, so the
    # viewer can distinguish "unknown" from a real measurement.
    agent_records.append(
        {
            "id": group_index,
            "height": None,
            "startIteration": 0,
            "footpath": [[round(lon, 7), round(lat, 7)] for lon, lat in coords],
            "speed": speeds,
            "heading": headings,
        }
    )

# ---------------------------------------------------------------------------
# Write the payload
# ---------------------------------------------------------------------------

seconds_per_iteration = SECONDS_PER_ITERATION if SECONDS_PER_ITERATION > 0 else None
calibrated = seconds_per_iteration is not None

if calibrated:
    for record in agent_records:
        record["speedMetresPerSecond"] = [
            round(s / seconds_per_iteration, 4) for s in record["speed"]
        ]

payload = {
    "meta": {
        "source": "micro_mobility_simulation_export.ghx",
        "solver": "Kova PedSim 1.2.0, Cellular Automata",
        "n_agents": len(agent_records),
        "speed_unit": "metres per iteration",
        "speed_unit_calibrated": "metres per second" if calibrated else None,
        "seconds_per_iteration": seconds_per_iteration if calibrated else None,
        "time_axis": "iteration index",
        "time_axis_note": (
            "Kova advances in discrete iterations and defines no wall-clock duration. "
            "Iteration index is the only real time axis; speeds are per iteration "
            "unless a calibrated seconds value is supplied."
        ),
        "heading_unit": "degrees clockwise from north (derived from consecutive points)",
        "crs_in": "EPSG:28992 (RD New), metres",
        "crs_out": "EPSG:4326 WGS84, degrees",
        "transform": (
            "local affine, fitted to simulation_results_heat_wgs84.csv (0.48 cm mean error)"
        ),
        "grouping": grouping,
    },
    "agents": agent_records,
}

out_path = normalise_path(out_path)

# Never write an empty export. Writing {"agents":[]} is worse than writing
# nothing at all: the viewer reads an empty agent list as "no data", so the file
# looks like a run that produced nobody, when in fact the export failed. An
# absent or untouched file is an honest signal; an empty one is a false one.
# (The earlier version only refused when a file already existed, which still let
# a first-run failure create a misleading empty file.)
write_blocked = bool(not agent_records and out_path)

if out_path and not write_blocked:
    directory = os.path.dirname(out_path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    wrote = "wrote %s (%.0f KB)" % (out_path, os.path.getsize(out_path) / 1024.0)
elif write_blocked:
    existing = "existing file left alone" if os.path.exists(out_path) else "nothing written"
    wrote = "refused to write %s (nothing to export, %s)" % (out_path, existing)
else:
    wrote = "no out_path given, nothing written"

total_points = sum(len(r["footpath"]) for r in agent_records)
report = "%s | %d agents, %d points | %s" % (
    wrote,
    len(agent_records),
    total_points,
    grouping,
)
if skipped_bad:
    report += " | %d non-point items skipped" % skipped_bad
if empty_paths:
    report += " | %d agents had no recorded positions" % empty_paths
if outside_fit:
    report += " | WARNING %d points outside the fitted region" % outside_fit
if not calibrated:
    report += " | speeds are per iteration (no seconds_per_iteration)"

if not raw_points:
    report += (
        " | NOTHING EXPORTED - is `footpaths` wired from the Footpath output, "
        "through Pt, with the tree flattened?"
    )
elif not agent_records:
    report += " | points arrived but none could be read as X/Y coordinates"
