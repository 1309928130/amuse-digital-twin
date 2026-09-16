# How to Add Bikes and Pedestrians to SUMO Simulation

## Current Status
✅ **Network supports bikes/pedestrians**: The network file (`osm.net.xml`) already has lanes that allow `bicycle` and `pedestrian` traffic.

❌ **No bike/pedestrian trips**: The current simulation only includes:
- Public transport (buses, trams, trains)
- Private passenger cars

## How to Generate Bike and Pedestrian Trips

### Option 1: Using `randomTrips.py` (Recommended)

Generate random bike trips:
```bash
# For Windows Git Bash - use single line (recommended)
cd SUMOdataZuidasPartial2025-12-01-15-37-36
py "C:/Program Files (x86)/Eclipse/Sumo/tools/randomTrips.py" -n osm.net.xml -o osm.bike.trips.xml --prefix bike --begin 0 --end 3600 --period 30 --vehicle-class bicycle --vtype bike --allow-fringe --min-distance 500 --max-distance 5000
```

Or if you prefer multi-line (each option on separate line):
```bash
cd SUMOdataZuidasPartial2025-12-01-15-37-36
py "C:/Program Files (x86)/Eclipse/Sumo/tools/randomTrips.py" \
  -n osm.net.xml \
  -o osm.bike.trips.xml \
  --prefix bike \
  --begin 0 \
  --end 3600 \
  --period 30 \
  --vehicle-class bicycle \
  --vtype bike \
  --allow-fringe \
  --min-distance 500 \
  --max-distance 5000
```

Generate random pedestrian trips:
```bash
# Single line version (recommended for Git Bash)
cd SUMOdataZuidasPartial2025-12-01-15-37-36
python "C:/Program Files (x86)/Eclipse/Sumo/tools/randomTrips.py" -n osm.net.xml -o osm.pedestrian.trips.xml --prefix ped --begin 0 --end 3600 --period 60 --vehicle-class pedestrian --vtype pedestrian --allow-fringe --min-distance 200 --max-distance 2000
```

Or multi-line version:
```bash
cd SUMOdataZuidasPartial2025-12-01-15-37-36
python "C:/Program Files (x86)/Eclipse/Sumo/tools/randomTrips.py" \
  -n osm.net.xml \
  -o osm.pedestrian.trips.xml \
  --prefix ped \
  --begin 0 \
  --end 3600 \
  --period 60 \
  --vehicle-class pedestrian \
  --vtype pedestrian \
  --allow-fringe \
  --min-distance 200 \
  --max-distance 2000
```

### Option 2: Using `od2trips.py` (If you have origin-destination data)

If you have OD (Origin-Destination) matrices:
```bash
python <SUMO_HOME>/tools/od2trips.py -n osm.net.xml -d od_matrix.xml -o osm.bike.trips.xml \
    --vtype bike --vehicle-class bicycle
```

### Option 3: Manual Trip Definition

Create a file `osm.bike.trips.xml`:
```xml
<routes>
    <vType id="bike" vClass="bicycle" speedFactor="1.0" maxSpeed="20.0"/>
    <trip id="bike0" depart="0.00" from="EDGE_ID_1" to="EDGE_ID_2" type="bike"/>
    <trip id="bike1" depart="10.00" from="EDGE_ID_3" to="EDGE_ID_4" type="bike"/>
    <!-- Add more trips... -->
</routes>
```

Create a file `osm.pedestrian.trips.xml`:
```xml
<routes>
    <vType id="pedestrian" vClass="pedestrian" speedFactor="1.0" maxSpeed="5.0"/>
    <trip id="ped0" depart="0.00" from="EDGE_ID_1" to="EDGE_ID_2" type="pedestrian"/>
    <trip id="ped1" depart="15.00" from="EDGE_ID_3" to="EDGE_ID_4" type="pedestrian"/>
    <!-- Add more trips... -->
</routes>
```

## Update SUMO Configuration

Add the bike and pedestrian trip files to `osm.sumocfg`:

```xml
<input>
    <net-file value="osm.net.xml.gz"/>
    <route-files value="osm_pt.rou.xml,osm.passenger.trips.xml,osm.bike.trips.xml,osm.pedestrian.trips.xml"/>
    <additional-files value="osm.poly.xml.gz,osm_stops.add.xml,output.add.xml"/>
</input>
```

## Run SUMO with FCD Output

Make sure FCD output includes bikes and pedestrians:
```xml
<output>
    <fcd-output value="fcd-output.xml"/>
    <fcd-output.geo value="true"/>
    <!-- Note: fcd-output.filter is optional. 
         - If you want ONLY bikes and pedestrians, use: <fcd-output.filter value="bicycle pedestrian"/>
         - If you want ALL vehicles (cars, buses, trams, trains, bikes, pedestrians), 
           DO NOT include fcd-output.filter (or leave it empty) -->
</output>
```

**Important**: Your current `osm.sumocfg` does NOT have `fcd-output.filter`, which means ALL vehicles (including bikes and pedestrians) will be included in the FCD output. This is the correct setting for visualizing everything.

Or run SUMO with:
```bash
sumo -c osm.sumocfg --fcd-output fcd-output.xml --fcd-output.geo true
```

## Visualization Support

✅ **Code already updated**: The visualization code now supports:
- **Bikes**: Lime green color (#00FF00), speed: 20 km/h
- **Pedestrians**: Magenta color (#FF00FF), speed: 5 km/h

The code will automatically:
- Detect bikes/pedestrians by vehicle type (bike, bicycle, cyclist, pedestrian, ped, walk)
- Color them appropriately
- Use correct speeds for interpolation
- Show their tracks in the same colors (darker)

## Notes

1. **Network Requirements**: Make sure your network has:
   - Bicycle lanes (for bikes)
   - Sidewalks/pedestrian paths (for pedestrians)
   - These should already exist if imported from OSM with proper options

2. **Performance**: Bikes and pedestrians move slower, so they may be more visible in the visualization. Consider limiting their numbers if performance is an issue.

3. **FCD Data**: For accurate visualization, generate FCD output that includes bikes and pedestrians. Without FCD, the code will use simplified route interpolation.

4. **Vehicle Types**: The code recognizes these vehicle type patterns:
   - Bikes: `bike`, `bicycle`, `cyclist`
   - Pedestrians: `pedestrian`, `ped`, `walk`

