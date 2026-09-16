# Extracting GTFS Data for Specific Dates (Offline Mode)

This guide explains how to extract GTFS data for specific dates in the Zuidas area for use in "offline mode" (historical/future date visualization).

## Overview

The `extract_zuidas_date.py` script filters GTFS data to:
1. Find all services active on a specific date
2. Filter trips to only those passing through Zuidas area
3. Extract all related data (routes, stops, stop_times, shapes, etc.)
4. Create a date-specific dataset in `data/static-gtfs/gtfs-zuidas-YYYY-MM-DD/`

## Usage

### Basic Usage

```bash
# Extract data for a specific date (YYYY-MM-DD format)
python extract_zuidas_date.py 2025-12-15

# Or use YYYYMMDD format
python extract_zuidas_date.py 20251217

# Use relative dates
python extract_zuidas_date.py yesterday
python extract_zuidas_date.py today
python extract_zuidas_date.py tomorrow
```

### Examples

```bash
# Extract data for December 15, 2025
python extract_zuidas_date.py 2025-12-15

# Extract data for December 17, 2025
python extract_zuidas_date.py 2025-12-17

# Extract yesterday's data
python extract_zuidas_date.py yesterday
```

## Output

The script creates a directory: `data/static-gtfs/gtfs-zuidas-YYYY-MM-DD/` containing:

- `routes.txt` - Routes that pass through Zuidas on that date
- `trips.txt` - Trips active on that date passing through Zuidas
- `stop_times.txt` - Stop times for those trips
- `stops.txt` - All stops used by those trips
- `calendar_dates.txt` - Calendar exceptions for active services
- `shapes.txt` - Shape data for route visualization (if available)
- Other files: `agency.txt`, `feed_info.txt`, `transfers.txt` (copied from source)

## How It Works

1. **Date Parsing**: Converts input date to GTFS format (YYYYMMDD)
2. **Service Filtering**: Finds all `service_id`s active on the target date using `calendar_dates.txt`
3. **Trip Filtering**: Filters trips to only those with active services
4. **Zuidas Filtering**: Further filters to trips that pass through Zuidas stops
5. **Data Extraction**: Extracts all related GTFS data for those trips

## Using in the Application

The route visualization automatically detects date-specific datasets. When you call:

```javascript
loadRouteVisualization('2025-12-15')
```

It will look for `data/static-gtfs/gtfs-zuidas-2025-12-15/` first, then fall back to general filtered data.

## Notes

- If no services are found for a date (e.g., holidays), empty files are created
- The script preserves complete route paths (all stops, not just Zuidas stops)
- Date-specific datasets are much smaller than the full GTFS dataset
- You can extract multiple dates and switch between them

## Troubleshooting

**Error: "Input directory not found"**
- Make sure `data/static-gtfs/gtfs-nl/` exists with GTFS files

**Warning: "No services found for date"**
- The date might be a holiday or have no scheduled service
- Check `calendar_dates.txt` to see available dates

**No trips found**
- The date might not have any trips passing through Zuidas
- Try a different date or check the calendar_dates.txt file

