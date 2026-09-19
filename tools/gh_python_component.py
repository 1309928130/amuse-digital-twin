"""
Kova footpath export for the Multisensory Digital Twin.

Runs inside a Grasshopper `Python 3 Script` component (Rhino 8). Inputs, in order:

    results   -- Kova's `Simulation Results`. This is a compiled
                 `Kova_CA_SimulationData`, not a plain list of agents; the
                 unwrapping below finds the agent collection inside it.
    out_path  -- JSON output path, usually from a Panel, e.g.

                   \\wsl$\\Ubuntu\\home\\enshanchen\\projects\\PedModel\\
                   visualization\\simulation_data\\proposal-1\\agent_trajectories.json

                 Optional: with no path the walk still runs and `report` says so.

Output:

    report    -- one line summarising what happened. This is the ground truth for
                 whether the export worked; do not judge by the component colour.

Constants to adjust
-------------------
SECONDS_PER_ITERATION is 0, meaning "unknown". Kova advances in discrete
iterations and defines no wall-clock duration. Speeds are therefore written in
metres per iteration and labelled as such. Fill in a figure only if you have
calibrated one; guessing would put fabricated units in front of a reviewer,
which is worse than an honest unit that needs one calibration run.

Why this exists
---------------
Kova's `Run Simulation` returns an opaque compiled class. Its deconstructors
expose each agent's characteristics and its `Footpath` (one point per iteration),
but nothing in the Kova package writes that to a file, and nothing applies the
projected-metres -> WGS84 transform the viewer needs. This does both.

Field names
-----------
Confirmed against the compiled assembly (KovaPedSim.gha) rather than guessed
from the UI: Kova_CA_SimulationData, Kova_CA_AgentType,
Kova_CA_AgentCharacteristics, Kova_CA_AgentHistory, and the backing fields
_Agents, _Characteristics, _History, _Footpath, _Guid, _StartIteration,
_ActiveTime, _Age, _Mass, _HeightDomain, _Sociability, _Awareness,
_PersonalSpace, _SocialInteractions.

`read_field` tries the public property first and the underscore-prefixed backing
field second, because the `DynamicDeconstructor` exposes whichever it resolves.
If a future Kova renames one, `report` says how many agents came back empty
instead of silently writing a file with missing fields.

Real, derived, absent
---------------------
    real (from Kova)   position per iteration, agent type, id, guid, height,
                       mass, age, sociability, awareness, personal space,
                       start iteration, active time, social interactions
    derived (here)     speed and heading, from consecutive points
    absent             timestamps -- Kova has none

Coordinate transform
--------------------
Footpaths arrive in Rhino model metres, which for this project are EPSG:28992
(RD New). Rather than embed a projection library this uses the same local affine
the wind and pollution builds use, minus their CASE_OFFSET -- that offset
corrects an OpenFOAM case built on its own origin, and applying it here would
move pedestrians ~74 m off the buildings.

Verified against simulation_results_heat_wgs84.csv, which carries both systems
for 18,471 points: the fit reproduces it to 0.48 cm mean / 1.53 cm max error.
The Kova footprint sits inside that fitted region. If the model is ever
re-projected or moved, re-run that check rather than trusting these constants.
"""

import json
import math
import os

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# 0 means "not calibrated". See the note in the docstring before changing this.
SECONDS_PER_ITERATION = 0

# --- projected metres -> WGS84. Same fit as tools/build-cfd-data.mjs, no CASE_OFFSET.
AFFINE = {
    "lon": {"a": 3.16395201669929, "bx": 1.46717699176902e-05, "by": -1.05300033141821e-07},
    "lat": {"a": 47.98519451501437, "bx": 6.45132710297329e-08, "by": 8.98732554750328e-06},
}

# Metres per degree at the Zuidas latitude. Only used for local distance checks.
METRES_PER_DEG_LON = 111320.0 * math.cos(math.radians(52.34))
METRES_PER_DEG_LAT = 110574.0

# Bounds of the heat grid the affine was fitted over. A point outside this is
# being projected by extrapolation, where the fit's error is unmeasured, so it
# is surfaced in `report` rather than silently trusted.
FIT_BOUNDS = {"x": (119329.0, 119747.0), "y": (483055.0, 483548.0)}


def to_lonlat(x, y):
    return (
        AFFINE["lon"]["a"] + x * AFFINE["lon"]["bx"] + y * AFFINE["lon"]["by"],
        AFFINE["lat"]["a"] + x * AFFINE["lat"]["bx"] + y * AFFINE["lat"]["by"],
    )


def metres_between(lon1, lat1, lon2, lat2):
    """Local planar distance. Fine over the ~20 m hops between iterations."""
    dx = (lon2 - lon1) * METRES_PER_DEG_LON
    dy = (lat2 - lat1) * METRES_PER_DEG_LAT
    return math.hypot(dx, dy)


def bearing_between(lon1, lat1, lon2, lat2):
    """Compass bearing in degrees, 0 = north, clockwise. 0.0 if coincident."""
    dx = (lon2 - lon1) * METRES_PER_DEG_LON
    dy = (lat2 - lat1) * METRES_PER_DEG_LAT
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return 0.0
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def as_list(v):
    """Kova hands back .NET lists; a single item can arrive unwrapped."""
    if v is None:
        return []
    try:
        return list(v)
    except TypeError:
        return [v]


def is_unset_point(p):
    """
    Detect the placeholders Kova pads footpaths with.

    The documentation says iterations before an agent entered "contain unset
    points so the list remains aligned with the global simulation timeline".
    Those are not positions, and plotting them would draw every agent from the
    start of the run, stacked at some default coordinate. They are identified by
    being non-finite or far outside the fitted region rather than by a sentinel
    value, because the sentinel is not documented.
    """
    if p is None:
        return True
    try:
        x, y = float(p.X), float(p.Y)
    except Exception:
        try:
            x, y = float(p[0]), float(p[1])
        except Exception:
            return True
    if not (math.isfinite(x) and math.isfinite(y)):
        return True
    bx, by = FIT_BOUNDS["x"], FIT_BOUNDS["y"]
    return not (bx[0] <= x <= bx[1] and by[0] <= y <= by[1])


def read_field(obj, name, default=None):
    """
    Read a property or dict key from a Kova object, public name first.

    Kova's objects carry both a public property and an underscore-prefixed
    backing field (e.g. `Footpath` and `_Footpath`), and the generic
    `DynamicDeconstructor` surfaces whichever it resolves. Trying both means a
    rename on one side does not silently produce a field-less export.
    """
    if obj is None:
        return default
    candidates = [name]
    if not name.startswith("_"):
        candidates.append("_" + name.replace(" ", ""))
    for candidate in candidates:
        for accessor in (lambda c=candidate: getattr(obj, c), lambda c=candidate: obj[c]):
            try:
                return accessor()
            except Exception:
                continue
    return default


def read_number(obj, name, default=0.0):
    """Read a numeric field, tolerating None and non-numeric values."""
    try:
        value = read_field(obj, name, None)
        return float(value) if value is not None else default
    except Exception:
        return default


def unwrap_results(obj):
    """
    Drill down from `results` to the list of agents.

    The port carries a compiled `Kova_CA_SimulationData`, not a list of agents.
    Its agent collection is what the deconstructors expose, and how Kova wrapped
    it varies. Rather than guess, candidates are tried in order and the first
    that yields something list-like with entries wins. If none do, the object
    itself is returned so the caller's loop reports zero agents instead of
    raising -- an empty export with a readable reason beats a traceback in a
    component the user cannot easily debug.
    """
    for accessor in (
        lambda: read_field(obj, "Agents"),
        lambda: read_field(obj, "ActiveAgentInstances"),
        lambda: read_field(obj, "AgentInstances"),
        lambda: read_field(obj, "_Agents"),
        lambda: read_field(obj, "SimulationAgents"),
    ):
        try:
            candidate = accessor()
        except Exception:
            continue
        if candidate is None:
            continue
        listed = as_list(candidate)
        if listed:
            return listed
    return as_list(obj)


def normalise_path(path):
    """
    Turn whatever a Grasshopper Panel hands over into a usable path.

    A Panel's output can arrive as a list, as a string with a trailing newline,
    or as a .NET string. All are normalised to a stripped single line: a Panel
    with two lines would otherwise produce a filename containing a newline,
    which Windows rejects with a confusing error.
    """
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
# Walk the agents
# ---------------------------------------------------------------------------

agents = unwrap_results(results)

agent_records = []
skipped_unset = 0
outside_fit = 0
missing_history = 0

rows = as_list(agents)
for index, agent in enumerate(rows):
    # `Simulation Agents` is normally already the per-agent element. If a list
    # of lists arrives instead, flatten exactly one level.
    if isinstance(agent, (list, tuple)) and len(agent) == 1:
        agent = agent[0]

    characteristics = read_field(agent, "Characteristics")
    history = read_field(agent, "History")

    footpath_raw = as_list(read_field(history, "Footpath"))
    # Keep the original index so `startIteration` stays aligned with Kova's
    # global timeline after the unset points are dropped.
    indexed = [(i, p) for i, p in enumerate(footpath_raw) if not is_unset_point(p)]
    skipped_unset += len(footpath_raw) - len(indexed)

    if not indexed:
        missing_history += 1
        continue

    coords = []
    for _, p in indexed:
        try:
            x, y = float(p.X), float(p.Y)
        except Exception:
            x, y = float(p[0]), float(p[1])
        bx, by = FIT_BOUNDS["x"], FIT_BOUNDS["y"]
        if not (bx[0] <= x <= bx[1] and by[0] <= y <= by[1]):
            outside_fit += 1
        coords.append(to_lonlat(x, y))

    speeds = []
    headings = []
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        speeds.append(round(metres_between(lon1, lat1, lon2, lat2), 4))
        headings.append(round(bearing_between(lon1, lat1, lon2, lat2), 2))

    agent_height = read_number(characteristics, "Height", 0.0)
    agent_mass = read_number(characteristics, "Mass", 0.0)
    agent_age = read_number(characteristics, "Age", 0.0)

    # `Agent Type` is a nested Kova object rather than a string, so its `Name`
    # is what a reader wants and its repr is the fallback.
    agent_type = read_field(characteristics, "Agent Type", None)
    if agent_type is not None:
        type_name = read_field(agent_type, "Name", None)
        agent_type_label = str(type_name) if type_name else str(agent_type)
    else:
        type_name = read_field(agent, "AgentType", None)
        agent_type_label = str(type_name) if type_name else None

    guid = read_field(characteristics, "Guid", None)

    agent_records.append(
        {
            "id": index,
            "agentType": agent_type_label,
            "guid": str(guid) if guid is not None else None,
            "height": agent_height,
            "mass": agent_mass,
            "age": agent_age,
            "startIteration": indexed[0][0],
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
        "solver": "Kova PedSim, Cellular Automata",
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
    },
    "agents": agent_records,
}

out_path = normalise_path(out_path)

# An empty export must not overwrite an existing file. Writing one would replace
# a good dataset with {"agents":[]}, and because the viewer treats an empty agent
# list as "no data", the loss would look like a missing run rather than a
# clobbered file. Refusing to write is recoverable; overwriting is not.
write_blocked = bool(not agent_records and out_path and os.path.exists(out_path))

if out_path and not write_blocked:
    directory = os.path.dirname(out_path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    wrote = "wrote %s (%.0f KB)" % (out_path, os.path.getsize(out_path) / 1024.0)
elif write_blocked:
    wrote = "refused to write %s (nothing to export, existing file left alone)" % out_path
else:
    wrote = "no out_path given, nothing written"

total_points = sum(len(r["footpath"]) for r in agent_records)
report = "%s | %d of %d agents, %d points, %d unset dropped" % (
    wrote,
    len(agent_records),
    len(rows),
    total_points,
    skipped_unset,
)
if missing_history:
    report += " | %d agents had no usable footpath" % missing_history
if outside_fit:
    report += " | WARNING %d points outside the fitted region" % outside_fit
if not calibrated:
    report += " | speeds are per iteration (no seconds_per_iteration)"

# An empty export is almost always one of two things: the simulation did not
# run, or the component was wired to something other than Simulation Results.
# Saying which, in the component's own output, is the difference between the
# user fixing it in a minute and mailing a file that cannot be diagnosed.
if not rows:
    report += (
        " | NOTHING EXPORTED - is `results` wired from Run Simulation's "
        "`Simulation Results` output, and has the simulation actually run?"
    )
elif not agent_records:
    report += " | agents arrived but none carried a Footpath"
