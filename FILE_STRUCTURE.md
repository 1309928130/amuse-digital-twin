# File Structure and Organization

## Current Structure

### `src/gtfsData.js` (761 lines)

**Current organization:**
- **Protobuf handling** (lines 12-263): Protocol buffer schema loading and parsing
- **Data fetching** (lines 264-323): API calls and data retrieval
- **Vehicle visualization** (lines 325-485): Entity creation and Cesium rendering
- **Real-time updates** (lines 500-537): Periodic data fetching
- **Historical data** (lines 556-761): Snapshot storage and retrieval

**Functions:**
- Internal: `getProtobuf()`, `initializeProtobuf()`, `parseGTFSRealtime()`, `fetchGTFSData()`, `getVehicleColor()`, `updateVehicleEntity()`, `processGTFSData()`, `loadStaticGTFSData()`
- Exported: `startGTFSUpdates()`, `stopGTFSUpdates()`, `clearVehicles()`, `getHistoricalData()`, `getHistoricalDataRange()`, `showHistoricalData()`

## Should We Split It?

### Recommendation: **Keep it together for now**

**Reasons:**
1. **761 lines is manageable** - Not excessive for a single module
2. **Tightly coupled** - Functions depend on each other (visualization needs data, data needs parsing)
3. **Well organized** - Clear sections with logical grouping
4. **No circular dependencies** - Current structure is clean
5. **Easier maintenance** - All GTFS-related code in one place

### When to Consider Splitting:

Split if the file grows beyond **~1200-1500 lines** or if you need:
- Separate testing of parsing vs visualization
- Different teams working on different parts
- Reusing parsing logic in other projects

### Potential Split (if needed later):

```
src/gtfs/
  ├── gtfsParser.js      # Protobuf parsing, data fetching
  ├── gtfsVisualization.js # Vehicle entities, Cesium rendering
  └── gtfsData.js        # Main coordinator, exports
```

But this adds complexity without clear benefit at current size.

## Current Module Sizes

- `gtfsData.js`: 761 lines
- `timeController.js`: ~250 lines
- `cesiumViewer.js`: ~215 lines
- `osmLoader.js`: ~246 lines

All are reasonably sized and well-organized.

