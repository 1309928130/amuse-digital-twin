# Downloading Static GTFS Data

To avoid rate limiting in historical mode, you can download static GTFS data files locally.

## Quick Start

1. **Start the proxy server** (in a separate terminal):
   ```bash
   npm run proxy
   ```

2. **Download static data** (in another terminal):
   ```bash
   npm run download-static
   ```

3. **Files will be saved to**: `data/static-gtfs/`

## What Gets Downloaded

- `vehiclePositions.pb` - Current vehicle positions snapshot (~250-350 KB)
- `tripUpdates.pb` (optional) - Trip updates snapshot

## How It Works

- **Real-time mode**: Fetches live data from GTFS-realtime API
- **Historical mode**: 
  - First tries to load from local `data/static-gtfs/vehiclePositions.pb`
  - Falls back to API if local file doesn't exist (may hit rate limits)
  - Uses the same static snapshot for all historical times (since we only have one snapshot)

## Future Enhancement

For true historical data with different snapshots for different dates, you would need to:
1. Download multiple snapshots over time
2. Store them with timestamps (e.g., `vehiclePositions-2025-12-08.pb`)
3. Load the appropriate file based on the selected date in the timeline

## Files Location

Downloaded files are stored in:
```
data/
  static-gtfs/
    vehiclePositions.pb
    tripUpdates.pb (optional)
```

These files are served by your local web server, so they're accessible via:
- `http://localhost:8080/data/static-gtfs/vehiclePositions.pb`

## Notes

- The download script skips files that already exist
- Files are typically 250-350 KB each
- You only need to download once (unless you want to update the snapshot)
- Make sure the proxy server is running before downloading

