# Architecture: Static vs Dynamic Digital Twins

## File Structure

The GTFS data handling has been split into clear modules:

### `src/gtfsCommon.js` - Shared Utilities
**Purpose:** Common functions used by both static and dynamic digital twins

**Exports:**
- `initializeProtobuf()` - Initialize protobuf schema
- `parseGTFSRealtime()` - Parse protobuf data
- `getVehicleColor()` - Get color based on vehicle type
- `updateVehicleEntity()` - Create/update Cesium entities
- `clearVehicles()` - Remove all vehicle entities

**Shared State:**
- `vehicleEntities` - Map of vehicle_id -> Cesium.Entity
- `FeedMessage` - Protobuf message type

---

### `src/gtfsRealtime.js` - Dynamic Digital Twin
**Purpose:** Handles real-time vehicle positions and collects snapshots

**Exports:**
- `startGTFSUpdates()` - Start fetching real-time data
- `stopGTFSUpdates()` - Stop real-time updates
- `getHistoricalData(timestamp)` - Get collected snapshot for timestamp
- `getHistoricalDataRange()` - Get time range of collected snapshots

**Features:**
- Fetches live data from GTFS-realtime API
- Updates every 30 seconds (configurable)
- Collects snapshots for historical playback
- Stores up to 500 snapshots (~4 hours of data)

**Use Case:** Real-time mode - shows live, moving vehicles

---

### `src/gtfsStatic.js` - Static Digital Twin
**Purpose:** Handles static vehicle positions from files and schedule-based simulation

**Exports:**
- `showHistoricalData(timestamp)` - Display static data for timestamp
- `simulateVehiclePositions(timestamp)` - Simulate from schedule data
- `loadStaticGTFSDataForTimestamp(timestamp)` - Load static data

**Features:**
- Loads snapshot files (downloaded historical snapshots)
- Loads single static file (current snapshot)
- **Simulates vehicle positions from schedule data** (for past periods)
- Uses GTFS static schedule data (`gtfs-nl.zip`)

**Use Case:** Historical/static mode - shows vehicles from snapshots or simulation

---

### `src/gtfsData.js` - Compatibility Layer
**Purpose:** Re-exports for backward compatibility

**Note:** This file maintains compatibility while transitioning. New code should import directly from `gtfsRealtime.js` or `gtfsStatic.js`.

---

## Data Flow

### Dynamic Digital Twin (Real-time Mode)
```
GTFS API → gtfsRealtime.js → parseGTFSRealtime() → updateVehicleEntity()
                                    ↓
                            Store snapshot in memory
                                    ↓
                    Historical playback when switching modes
```

### Static Digital Twin (Historical Mode)
```
User selects time → gtfsStatic.js → Try:
    1. Snapshot files (downloaded)
    2. Static file (single snapshot)
    3. Simulation from schedule data
                                    ↓
                            updateVehicleEntity()
```

---

## Schedule-Based Simulation (Option 2)

**Status:** Framework implemented, full simulation TODO

**How it works:**
1. Load GTFS static schedule data (`gtfs-nl.zip`)
2. Parse routes, trips, stop_times, stops
3. For a given timestamp:
   - Find active trips (based on schedule)
   - Calculate vehicle positions between stops
   - Interpolate positions based on travel times
4. Generate vehicle positions matching GTFS-realtime format

**Files needed:**
- `routes.txt` - Route information
- `trips.txt` - Trip information
- `stop_times.txt` - Schedule times for each stop
- `stops.txt` - Stop locations
- `calendar.txt` or `calendar_dates.txt` - Service availability

**Next steps:**
1. Extract GTFS zip file server-side
2. Serve individual CSV files
3. Implement trip matching logic
4. Implement position interpolation
5. Generate protobuf format output

---

## Clear Separation

✅ **Dynamic Digital Twin** (`gtfsRealtime.js`):
- Real-time data
- Live updates
- Snapshot collection
- Moving vehicles in real-time

✅ **Static Digital Twin** (`gtfsStatic.js`):
- Static snapshots
- Schedule simulation
- Historical data
- Vehicles from files/simulation

✅ **Shared Utilities** (`gtfsCommon.js`):
- Parsing
- Visualization
- Common functions

