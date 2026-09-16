# GTFS-Realtime Integration with OVapi

The application has been updated to use real GTFS-realtime data from [OVapi](https://gtfs.ovapi.nl/nl/), which provides real-time public transport data for the Netherlands.

## What Changed

1. **Configuration Updated** (`src/config.js`):
   - Added OVapi endpoints for vehicle positions, trip updates, and train updates
   - Set `useMockData: false` to use real API data
   - Added filtering options for Zuidas area

2. **GTFS-Realtime Module** (`src/gtfsRealtime.js`):
   - Implemented protobuf parsing using `protobufjs` library
   - Added support for parsing GTFS-realtime FeedMessage format
   - Filters vehicles to show only those in the Zuidas area
   - Color-codes vehicles by type (bus=blue, tram=red, train=yellow, metro=green)
   - Visualizes vehicles as colored points with direction indicators

3. **Dependencies**:
   - Added `protobufjs` package for parsing protobuf data
   - Added `long` package (dependency of protobufjs)

## API Endpoints Used

- **Vehicle Positions**: `https://gtfs.ovapi.nl/nl/vehiclePositions.pb`
- **Trip Updates**: `https://gtfs.ovapi.nl/nl/tripUpdates.pb` (available for future use)
- **Train Updates**: `https://gtfs.ovapi.nl/nl/trainUpdates.pb` (available for future use)

## How It Works

1. The application fetches vehicle position data from OVapi every 30 seconds
2. Protobuf data is parsed using the GTFS-realtime schema
3. Vehicles are filtered to show only those within the Zuidas bounding box
4. Each vehicle is displayed as a colored point with:
   - Color based on vehicle type
   - Label showing vehicle ID/route
   - Direction indicator (polyline)
   - Real-time position updates

## Vehicle Visualization

- **Blue**: Buses
- **Red**: Trams
- **Yellow**: Trains/Sprinters
- **Green**: Metro
- **Cyan**: Other/Unknown

## Configuration Options

In `src/config.js`, you can adjust:

```javascript
GTFS_CONFIG = {
    updateInterval: 30000,        // Update frequency (ms)
    filterByArea: true,            // Filter to Zuidas area only
    useMockData: false            // Set to true to use mock data
}
```

## Troubleshooting

If you see errors loading protobuf data:

1. Check browser console for CORS or network errors
2. Verify the OVapi endpoint is accessible
3. The application will fall back to a minimal proto definition if the full schema can't be loaded
4. Historical data is stored in memory (last 100 snapshots) for time slider functionality

## Next Steps

- The time slider allows you to view historical vehicle positions (data collected since the app started)
- You can extend this to show trip updates and train-specific data
- Consider adding route visualization by connecting vehicle positions over time

