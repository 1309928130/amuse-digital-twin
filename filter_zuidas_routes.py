#!/usr/bin/env python3
"""
Filter GTFS routes to only include those that overlap with Zuidas area.
This reduces the data size and prevents browser crashes.

Usage:
    py filter_zuidas_routes.py

This will create filtered GTFS files in data/static-gtfs/gtfs-zuidas/
"""

import csv
import os
import shutil
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

def main():
    print("=" * 60)
    print("Filtering GTFS routes for Zuidas area")
    print("=" * 60)
    
    # Input directories (try both)
    input_dirs = [
        'data/static-gtfs/gtfs-nl',
        'data/static-gtfs/gtfs-extracted'
    ]
    
    input_dir = None
    for dir_path in input_dirs:
        if os.path.exists(dir_path) and os.path.exists(os.path.join(dir_path, 'stops.txt')):
            input_dir = dir_path
            break
    
    if not input_dir:
        print("Error: Could not find GTFS data directory")
        print("Please make sure one of these exists:")
        for dir_path in input_dirs:
            print(f"  - {dir_path}")
        return
    
    print(f"\nUsing input directory: {input_dir}")
    
    # Output directory
    output_dir = 'data/static-gtfs/gtfs-zuidas'
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"Output directory: {output_dir}\n")
    
    # Load GTFS files
    print("Loading GTFS files...")
    stops = load_csv(os.path.join(input_dir, 'stops.txt'))
    routes = load_csv(os.path.join(input_dir, 'routes.txt'))
    trips = load_csv(os.path.join(input_dir, 'trips.txt'))
    stop_times = load_csv(os.path.join(input_dir, 'stop_times.txt'))
    
    if not stops or not routes or not trips or not stop_times:
        print("Error: Could not load required GTFS files")
        return
    
    print(f"  Loaded {len(stops)} stops")
    print(f"  Loaded {len(routes)} routes")
    print(f"  Loaded {len(trips)} trips")
    print(f"  Loaded {len(stop_times)} stop times\n")
    
    # Find stops within Zuidas area
    print("Finding stops within Zuidas area...")
    zuidas_stop_ids = set()
    for stop in stops:
        if is_within_zuidas_bounds(stop.get('stop_lat'), stop.get('stop_lon')):
            zuidas_stop_ids.add(stop['stop_id'])
    
    print(f"  Found {len(zuidas_stop_ids)} stops within Zuidas area\n")
    
    # Find trips that pass through Zuidas stops
    print("Finding trips that pass through Zuidas stops...")
    zuidas_trip_ids = set()
    for st in stop_times:
        if st.get('stop_id') in zuidas_stop_ids:
            zuidas_trip_ids.add(st['trip_id'])
    
    print(f"  Found {len(zuidas_trip_ids)} trips passing through Zuidas area\n")
    
    # Find routes that have trips in Zuidas
    print("Finding routes that overlap with Zuidas area...")
    zuidas_route_ids = set()
    for trip in trips:
        if trip['trip_id'] in zuidas_trip_ids:
            zuidas_route_ids.add(trip['route_id'])
    
    print(f"  Found {len(zuidas_route_ids)} routes overlapping with Zuidas area\n")
    
    # Filter data
    print("Filtering GTFS data...")
    
    # Filter routes
    filtered_routes = [r for r in routes if r['route_id'] in zuidas_route_ids]
    print(f"  Filtered routes: {len(filtered_routes)}/{len(routes)}")
    
    # Filter trips (only trips that pass through Zuidas)
    filtered_trips = [t for t in trips if t['trip_id'] in zuidas_trip_ids]
    print(f"  Filtered trips: {len(filtered_trips)}/{len(trips)}")
    
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
    
    # Save filtered files
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
    
    # Copy other files if they exist (agency, calendar, etc.)
    other_files = ['agency.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt']
    for filename in other_files:
        src = os.path.join(input_dir, filename)
        dst = os.path.join(output_dir, filename)
        if os.path.exists(src):
            shutil.copy2(src, dst)
            print(f"  ✓ Copied {filename}")
    
    # Create summary
    print("\n" + "=" * 60)
    print("Summary:")
    print("=" * 60)
    print(f"Original data: {len(routes)} routes, {len(trips)} trips, {len(stops)} stops")
    print(f"Filtered data: {len(filtered_routes)} routes, {len(filtered_trips)} trips, {len(filtered_stops)} stops")
    print(f"Reduction: {100 * (1 - len(filtered_routes) / len(routes)):.1f}% fewer routes")
    print(f"\nFiltered files saved to: {output_dir}")
    print("\nYou can now use the filtered GTFS files in the route visualization!")
    print("=" * 60)

if __name__ == '__main__':
    main()

