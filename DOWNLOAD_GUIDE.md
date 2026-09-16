# Data Download Guide

This guide explains which files to download and how to download them.

## GTFS Static Data (for Historical/Static Mode)

### Which Files to Download

From [https://gtfs.ovapi.nl/nl/](https://gtfs.ovapi.nl/nl/):

**Required:**
- `vehiclePositions.pb` (~350 KB) - Vehicle positions snapshot for historical mode

**Recommended for Static Mode:**
- `gtfs-nl.zip` (~260 MB) - **Static GTFS schedule data** (routes, stops, schedules, trips)
  - Useful for displaying static transit routes and schedules
  - Contains complete schedule information for all public transport
  - Large file but essential for static mode visualization

**Optional (Real-time Data):**
- `tripUpdates.pb` (~4.7 MB) - Trip updates (delays, cancellations)
- `trainUpdates.pb` (~2.6 MB) - Train-specific updates

**Skip:**
- `alerts.pb` (29 MB) - Service alerts, not needed for positions/routes

### Automatic Download

1. Start proxy server: `npm run proxy`
2. Download: `npm run download-static`
3. Files saved to: `data/static-gtfs/`

### Manual Download

If you prefer to download manually:

1. Start proxy server: `npm run proxy`
2. Open browser and go to: `http://localhost:3000/gtfs/vehiclePositions.pb`
3. Save the file to: `data/static-gtfs/vehiclePositions.pb`

## OSM Building Data

### Automatic Download

Download OSM buildings for Zuidas area:

```bash
npm run download-osm
```

This will:
- Download building data from Overpass API
- Save to: `data/osm/zuidas-buildings.json`
- Use default Zuidas bounds (defined in `src/config.js`)

### Custom Area

To download for a different area:

```bash
node download-osm-buildings.js --north 52.35 --south 52.33 --east 4.88 --west 4.85
```

### Manual Download

1. Go to [Overpass Turbo](https://overpass-turbo.eu/)
2. Use this query (adjust bounds as needed):
   ```
   [out:json][timeout:180];
   (
     way["building"](52.330,4.850,52.345,4.875);
     relation["building"](52.330,4.850,52.345,4.875);
   );
   out body;
   >;
   out skel qt;
   ```
3. Export as JSON
4. Save to: `data/osm/zuidas-buildings.json`

### Editing OSM Data

After downloading, you can:
- Edit `data/osm/zuidas-buildings.json` manually
- Add/remove buildings
- Modify building heights or properties
- The app will use your edited version

## File Locations

```
data/
  static-gtfs/
    vehiclePositions.pb    # GTFS vehicle positions (required)
    gtfs-nl.zip           # Static schedule data (recommended for static mode)
    tripUpdates.pb         # (optional) Trip updates
    trainUpdates.pb        # (optional) Train updates
  osm/
    zuidas-buildings.json  # OSM building data
```

## Static Data Usage

- **Real-time mode**: Uses live GTFS-realtime API data
- **Static mode**: 
  - Uses `vehiclePositions.pb` for vehicle positions
  - Uses `gtfs-nl.zip` for routes, stops, and schedules (if downloaded)
  - All data loaded from local files (no API calls)

## Benefits of Local Data

- **Faster loading** - No API calls needed
- **No rate limiting** - Use data as much as you want
- **Offline capable** - Works without internet
- **Editable** - Modify data files as needed
- **Consistent** - Same data every time

## Updating Data

- **GTFS data**: Re-run `npm run download-static` to get latest snapshot
- **OSM data**: Re-run `npm run download-osm` to refresh building data
- Or manually replace the files

