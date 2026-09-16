# Historical Data Guide

## Overview

This guide explains how to get multiple snapshots for historical vehicle positions to demonstrate your digital twin over a time period.

## Important Note About Static Data

**Static GTFS data files (`gtfs-nl.zip`) do NOT contain historical vehicle positions.**

- **Static GTFS data** contains: routes, stops, schedules, trips (planned data)
- **Vehicle positions** are real-time data that changes constantly
- Historical vehicle positions are NOT stored in static files

## Options for Historical Snapshots

### Option 1: Collect Snapshots Over Time (Recommended for Demos)

**How it works:**
- Run the download script continuously to collect snapshots at regular intervals
- Each snapshot captures vehicle positions at that moment
- Store snapshots with timestamps

**Steps:**

1. **Start proxy server:**
   ```bash
   npm run proxy
   ```

2. **Download snapshots for a period:**
   ```bash
   # Download every hour from Nov 1 to Dec 1, 2025
   npm run download-historical -- --start 2025-11-01 --end 2025-12-01 --interval 3600
   
   # Download every 30 minutes
   npm run download-historical -- --start 2025-11-01 --end 2025-12-01 --interval 1800
   
   # Download every 15 minutes
   npm run download-historical -- --start 2025-11-01 --end 2025-12-01 --interval 900
   ```

3. **Files will be saved to:** `data/static-gtfs/snapshots/`
   - Format: `vehiclePositions-YYYY-MM-DD-HHMM.pb`
   - Example: `vehiclePositions-2025-11-15-1430.pb` (Nov 15, 2025 at 14:30)

4. **The app will automatically use these snapshots** when you slide the time bar in historical mode

**Limitations:**
- You can only collect snapshots from NOW going forward
- Cannot get historical data from the past (e.g., Nov 1 if today is Dec 8)
- Requires running the script continuously over the period you want to capture

### Option 2: Simulate Vehicle Positions from Schedule Data (Advanced)

**How it works:**
- Parse the static schedule data (`gtfs-nl.zip`)
- Calculate where vehicles should be at any given time based on:
  - Route information
  - Schedule times
  - Stop locations
  - Travel times between stops
- Generate `vehiclePositions.pb` files for different timestamps

**This requires:**
- Parsing GTFS static data (routes, trips, stop_times)
- Interpolating positions between stops
- Generating protobuf format files

**Status:** Not yet implemented, but possible with additional development.

### Option 3: Use OVapi Archive (If Available)

OVapi has an archive URL: `https://gtfs.ovapi.nl/nl/archive/`

**Check if available:**
1. Visit: `https://gtfs.ovapi.nl/nl/archive/`
2. See if historical snapshots are listed
3. If yes, we can create a script to download them

**Status:** Needs verification - archive may not contain historical vehicle positions.

## Recommended Approach for Your Demo

### For a Demo Period (e.g., Nov 1 - Dec 1, 2025):

**If the period is in the future:**
1. Set up the download script to run continuously
2. Let it collect snapshots every 15-30 minutes
3. By the end of the period, you'll have all snapshots

**If the period is in the past:**
1. You cannot get real historical vehicle positions (not stored)
2. Use Option 2: Simulate from schedule data
3. Or use Option 3: Check OVapi archive

### Quick Start for Future Period:

```bash
# 1. Start proxy (in one terminal)
npm run proxy

# 2. Download snapshots every 30 minutes for next month (in another terminal)
# This will download current snapshot, then you'd need to schedule it to run periodically
npm run download-historical -- --start 2025-12-09 --end 2026-01-09 --interval 1800
```

**Note:** This downloads snapshots for the specified period, but you need to run it continuously or schedule it to run at each interval.

## File Structure

```
data/
  static-gtfs/
    vehiclePositions.pb          # Single snapshot (current)
    snapshots/
      vehiclePositions-2025-11-01-0000.pb
      vehiclePositions-2025-11-01-0030.pb
      vehiclePositions-2025-11-01-0100.pb
      ...
```

## How the App Uses Snapshots

1. When you slide the time bar in historical mode
2. App looks for snapshot file matching that timestamp
3. If found, loads and displays vehicles from that snapshot
4. If not found, falls back to single static file or collected snapshots

## Next Steps

1. **For immediate demo:** Use real-time mode to collect snapshots over the next few hours/days
2. **For future demo:** Set up scheduled downloads to collect snapshots continuously
3. **For past demo:** Implement schedule-based simulation (requires development)

