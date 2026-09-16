#!/usr/bin/env python3
"""
Extract GTFS data for a specific date in the Zuidas area.
This creates a filtered dataset for "offline mode" (historical/future dates).

Usage:
    python extract_zuidas_date.py 2025-12-15
    python extract_zuidas_date.py 2025-12-17
    python extract_zuidas_date.py yesterday
    python extract_zuidas_date.py tomorrow

Output:
    Creates data/static-gtfs/gtfs-zuidas-YYYY-MM-DD/ with filtered GTFS files
"""

import csv
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Zuidas boundary coordinates (from config.js)
ZUIDAS_BOUNDS = {
    'north': 52.344503,
    'south': 52.332078,
    'east': 4.8924243,
    'west': 4.8571395
}

def is_within_zuidas_bounds(lat, lon):
    """Check if a point is within Zuidas bounds"""
    try:
        lat = float(lat)
        lon = float(lon)
        return (lat >= ZUIDAS_BOUNDS['south'] and 
                lat <= ZUIDAS_BOUNDS['north'] and
                lon >= ZUIDAS_BOUNDS['west'] and 
                lon <= ZUIDAS_BOUNDS['east'])
    except (ValueError, TypeError):
        return False

def parse_date(date_str):
    """Parse date string to datetime object"""
    date_str_lower = date_str.lower().strip()
    
    if date_str_lower == 'yesterday':
        return datetime.now() - timedelta(days=1)
    elif date_str_lower == 'today':
        return datetime.now()
    elif date_str_lower == 'tomorrow':
        return datetime.now() + timedelta(days=1)
    else:
        # Try parsing as YYYY-MM-DD or YYYYMMDD
        try:
            if '-' in date_str:
                return datetime.strptime(date_str, '%Y-%m-%d')
            else:
                return datetime.strptime(date_str, '%Y%m%d')
        except ValueError:
            raise ValueError(f"Invalid date format: {date_str}. Use YYYY-MM-DD, YYYYMMDD, 'yesterday', 'today', or 'tomorrow'")

def date_to_gtfs_format(date_obj):
    """Convert datetime to GTFS date format (YYYYMMDD)"""
    return date_obj.strftime('%Y%m%d')

def load_csv(filepath):
    """Load a CSV file and return list of dictionaries"""
    if not os.path.exists(filepath):
        print(f"Warning: {filepath} not found")
        return []
    
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return list(reader)

def save_csv(data, filepath, fieldnames):
    """Save data to CSV file"""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    
    with open(filepath, 'w', encoding='utf-8', newline='') as f:
        if not data:
            # Create empty file with header
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
        else:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(data)

def get_active_services_for_date(calendar_dates, calendar, target_date_str, target_date_obj):
    """
    Get all service_ids that are active on the target date.
    Uses calendar.txt for regular service and calendar_dates.txt for exceptions.
    """
    active_services = set()
    
    # First, check calendar.txt for regular service patterns
    if calendar:
        day_of_week = target_date_obj.weekday()  # 0=Monday, 6=Sunday
        day_names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        day_name = day_names[day_of_week]
        
        for cal in calendar:
            start_date = cal.get('start_date', '')
            end_date = cal.get('end_date', '')
            service_id = cal.get('service_id', '')
            
            # Check if date is within service period
            if start_date <= target_date_str <= end_date:
                # Check if service runs on this day of week
                if cal.get(day_name) == '1':
                    active_services.add(service_id)
    
    # Then, apply calendar_dates.txt exceptions
    for cd in calendar_dates:
        if cd['date'] == target_date_str:
            exception_type = cd.get('exception_type', '')
            service_id = cd.get('service_id', '')
            if exception_type == '1':  # Added service (override)
                active_services.add(service_id)
            elif exception_type == '2':  # Removed service (override)
                active_services.discard(service_id)
    
    return active_services

def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_zuidas_date.py <date>")
        print("  Date formats: YYYY-MM-DD, YYYYMMDD, 'yesterday', 'today', 'tomorrow'")
        print("  Examples:")
        print("    python extract_zuidas_date.py 2025-12-15")
        print("    python extract_zuidas_date.py 20251217")
        print("    python extract_zuidas_date.py yesterday")
        print("    python extract_zuidas_date.py tomorrow")
        sys.exit(1)
    
    # Parse target date
    try:
        target_date = parse_date(sys.argv[1])
        target_date_str = date_to_gtfs_format(target_date)
        target_date_display = target_date.strftime('%Y-%m-%d')
    except ValueError as e:
        print(f"Error: {e}")
        sys.exit(1)
    
    print("=" * 70)
    print(f"Extracting GTFS data for Zuidas area - Date: {target_date_display}")
    print("=" * 70)
    
    # Input directory
    input_dir = 'data/static-gtfs/gtfs-nl'
    if not os.path.exists(input_dir):
        print(f"Error: Input directory not found: {input_dir}")
        sys.exit(1)
    
    print(f"\nInput directory: {input_dir}")
    
    # Output directory (date-specific)
    output_dir = f'data/static-gtfs/gtfs-zuidas-{target_date_display}'
    os.makedirs(output_dir, exist_ok=True)
    print(f"Output directory: {output_dir}\n")
    
    # Load GTFS files
    print("Loading GTFS files...")
    stops = load_csv(os.path.join(input_dir, 'stops.txt'))
    routes = load_csv(os.path.join(input_dir, 'routes.txt'))
    trips = load_csv(os.path.join(input_dir, 'trips.txt'))
    stop_times = load_csv(os.path.join(input_dir, 'stop_times.txt'))
    calendar_dates = load_csv(os.path.join(input_dir, 'calendar_dates.txt'))
    calendar = load_csv(os.path.join(input_dir, 'calendar.txt'))  # May not exist
    
    if not stops or not routes or not trips or not stop_times:
        print("Error: Could not load required GTFS files")
        sys.exit(1)
    
    print(f"  Loaded {len(stops)} stops")
    print(f"  Loaded {len(routes)} routes")
    print(f"  Loaded {len(trips)} trips")
    print(f"  Loaded {len(stop_times)} stop times")
    print(f"  Loaded {len(calendar_dates)} calendar date entries")
    if calendar:
        print(f"  Loaded {len(calendar)} calendar entries")
    print()
    
    # Step 1: Find services active on target date
    print(f"Finding services active on {target_date_display} ({target_date_str})...")
    active_services = get_active_services_for_date(calendar_dates, calendar, target_date_str, target_date)
    print(f"  Found {len(active_services)} active service IDs\n")
    
    if not active_services:
        print(f"Warning: No services found for date {target_date_display}")
        print("This might be a date with no scheduled service (e.g., holiday)")
        print("Creating empty output files...")
        # Create empty files with headers
        if trips:
            save_csv([], os.path.join(output_dir, 'trips.txt'), trips[0].keys())
        if routes:
            save_csv([], os.path.join(output_dir, 'routes.txt'), routes[0].keys())
        if stop_times:
            save_csv([], os.path.join(output_dir, 'stop_times.txt'), stop_times[0].keys())
        if stops:
            save_csv([], os.path.join(output_dir, 'stops.txt'), stops[0].keys())
        print(f"\nEmpty files created in: {output_dir}")
        return
    
    # Step 2: Filter trips by active services
    print("Filtering trips by active services...")
    active_trips = [t for t in trips if t.get('service_id') in active_services]
    print(f"  Found {len(active_trips)} trips active on {target_date_display}\n")
    
    if not active_trips:
        print(f"Warning: No trips found for date {target_date_display}")
        return
    
    # Step 3: Find stops within Zuidas area
    print("Finding stops within Zuidas area...")
    zuidas_stop_ids = set()
    for stop in stops:
        if is_within_zuidas_bounds(stop.get('stop_lat'), stop.get('stop_lon')):
            zuidas_stop_ids.add(stop['stop_id'])
    
    print(f"  Found {len(zuidas_stop_ids)} stops within Zuidas area\n")
    
    # Step 4: Find trips that pass through Zuidas stops
    print("Finding trips that pass through Zuidas stops...")
    active_trip_ids = {t['trip_id'] for t in active_trips}
    zuidas_trip_ids = set()
    
    for st in stop_times:
        if st.get('trip_id') in active_trip_ids and st.get('stop_id') in zuidas_stop_ids:
            zuidas_trip_ids.add(st['trip_id'])
    
    print(f"  Found {len(zuidas_trip_ids)} trips passing through Zuidas area on {target_date_display}\n")
    
    if not zuidas_trip_ids:
        print(f"Warning: No trips found passing through Zuidas on {target_date_display}")
        return
    
    # Step 5: Filter all data
    print("Filtering GTFS data...")
    
    # Filter trips (only active trips passing through Zuidas)
    filtered_trips = [t for t in active_trips if t['trip_id'] in zuidas_trip_ids]
    print(f"  Filtered trips: {len(filtered_trips)}/{len(trips)}")
    
    # Get route IDs from filtered trips
    zuidas_route_ids = {t['route_id'] for t in filtered_trips}
    
    # Filter routes
    filtered_routes = [r for r in routes if r['route_id'] in zuidas_route_ids]
    print(f"  Filtered routes: {len(filtered_routes)}/{len(routes)}")
    
    # Filter stop_times (only for zuidas trips)
    filtered_stop_times = [st for st in stop_times if st['trip_id'] in zuidas_trip_ids]
    print(f"  Filtered stop times: {len(filtered_stop_times)}/{len(stop_times)}")
    
    # Get all stop IDs used by filtered trips
    filtered_stop_ids = set()
    for st in filtered_stop_times:
        filtered_stop_ids.add(st['stop_id'])
    
    # Filter stops (all stops used by filtered trips, not just Zuidas stops)
    # This ensures we have complete route paths
    filtered_stops = [s for s in stops if s['stop_id'] in filtered_stop_ids]
    print(f"  Filtered stops: {len(filtered_stops)}/{len(stops)}")
    
    # Filter calendar_dates (only for active services)
    filtered_calendar_dates = [cd for cd in calendar_dates if cd['service_id'] in active_services]
    print(f"  Filtered calendar dates: {len(filtered_calendar_dates)}/{len(calendar_dates)}")
    
    # Step 6: Save filtered files
    print("\nSaving filtered GTFS files...")
    
    if filtered_routes:
        save_csv(filtered_routes, os.path.join(output_dir, 'routes.txt'), 
                fieldnames=filtered_routes[0].keys())
        print(f"  ✓ Saved routes.txt ({len(filtered_routes)} routes)")
    
    if filtered_trips:
        save_csv(filtered_trips, os.path.join(output_dir, 'trips.txt'),
                fieldnames=filtered_trips[0].keys())
        print(f"  ✓ Saved trips.txt ({len(filtered_trips)} trips)")
    
    if filtered_stop_times:
        save_csv(filtered_stop_times, os.path.join(output_dir, 'stop_times.txt'),
                fieldnames=filtered_stop_times[0].keys())
        print(f"  ✓ Saved stop_times.txt ({len(filtered_stop_times)} stop times)")
    
    if filtered_stops:
        save_csv(filtered_stops, os.path.join(output_dir, 'stops.txt'),
                fieldnames=filtered_stops[0].keys())
        print(f"  ✓ Saved stops.txt ({len(filtered_stops)} stops)")
    
    if filtered_calendar_dates:
        save_csv(filtered_calendar_dates, os.path.join(output_dir, 'calendar_dates.txt'),
                fieldnames=filtered_calendar_dates[0].keys())
        print(f"  ✓ Saved calendar_dates.txt ({len(filtered_calendar_dates)} entries)")
    
    # Copy other files if they exist
    other_files = ['agency.txt', 'feed_info.txt', 'transfers.txt']
    for filename in other_files:
        src = os.path.join(input_dir, filename)
        dst = os.path.join(output_dir, filename)
        if os.path.exists(src):
            import shutil
            shutil.copy2(src, dst)
            print(f"  ✓ Copied {filename}")
    
    # Copy calendar.txt if it exists
    if calendar:
        save_csv(calendar, os.path.join(output_dir, 'calendar.txt'),
                fieldnames=calendar[0].keys())
        print(f"  ✓ Saved calendar.txt ({len(calendar)} entries)")
    
    # Handle shapes.txt if it exists (filter by shape_id from trips)
    if os.path.exists(os.path.join(input_dir, 'shapes.txt')):
        shapes = load_csv(os.path.join(input_dir, 'shapes.txt'))
        if shapes:
            zuidas_shape_ids = {t.get('shape_id') for t in filtered_trips if t.get('shape_id')}
            filtered_shapes = [s for s in shapes if s.get('shape_id') in zuidas_shape_ids]
            if filtered_shapes:
                save_csv(filtered_shapes, os.path.join(output_dir, 'shapes.txt'),
                        fieldnames=filtered_shapes[0].keys())
                print(f"  ✓ Saved shapes.txt ({len(filtered_shapes)} shape points)")
    
    # Create summary
    print("\n" + "=" * 70)
    print("Summary:")
    print("=" * 70)
    print(f"Target date: {target_date_display} ({target_date_str})")
    print(f"Active services: {len(active_services)}")
    print(f"Active trips on date: {len(active_trips)}")
    print(f"Trips passing through Zuidas: {len(zuidas_trip_ids)}")
    print(f"\nOriginal data: {len(routes)} routes, {len(trips)} trips, {len(stops)} stops")
    print(f"Filtered data: {len(filtered_routes)} routes, {len(filtered_trips)} trips, {len(filtered_stops)} stops")
    print(f"\nFiltered files saved to: {output_dir}")
    print("\nYou can now use this filtered dataset for offline mode!")
    print("=" * 70)

if __name__ == '__main__':
    main()

