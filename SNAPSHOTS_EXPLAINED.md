# Understanding Snapshots and Dynamic Vehicle Movement

## What are Snapshots?

**Snapshots** are stored vehicle positions at specific points in time. Think of them like photos taken every 30 seconds showing where all vehicles are at that moment.

### How Snapshots Work

1. **In Real-time Mode**: 
   - The app fetches vehicle positions every 30 seconds
   - Each fetch creates a "snapshot" - a record of all vehicle positions at that time
   - These snapshots are stored in memory (up to 500 snapshots = ~4 hours of data)

2. **In Historical Mode**:
   - When you slide the time bar, the app looks for the closest snapshot to that time
   - It displays the vehicles from that snapshot
   - As you move the slider, vehicles "move" because you're seeing different snapshots

## Why Vehicles Don't Move in Static Mode

**Static mode** loads a **single snapshot** from a downloaded file (`vehiclePositions.pb`). This file contains vehicle positions from **one point in time** only. 

When you slide the time bar:
- It still shows the same snapshot
- Vehicles stay in the same positions
- They don't move because there's only one snapshot

## How to Make Vehicles Move Dynamically

### Option 1: Collect Snapshots First (Recommended)

1. **Switch to Real-time Mode**
   - Click the mode toggle to "Real-time Mode"
   - Let it run for 5-10 minutes
   - The app will collect snapshots every 30 seconds

2. **Switch to Historical Mode**
   - Click the mode toggle to "Historical Mode"
   - Now slide the time bar
   - Vehicles will move! 🎉

**Why this works**: You now have multiple snapshots (one every 30 seconds), so the app can show different positions as you change the time.

### Option 2: Use Schedule Data (Advanced)

For true dynamic movement based on routes and schedules, you would need to:
- Parse the static schedule data (`gtfs-nl.zip`)
- Calculate where vehicles should be at any given time based on:
  - Route information
  - Schedule times
  - Stop locations
- Interpolate positions between stops

This requires additional implementation.

## Current Snapshot System

- **Storage**: Up to 500 snapshots in memory
- **Interval**: One snapshot every 30 seconds (configurable in `config.js`)
- **Duration**: ~4 hours of data (500 × 30 seconds)
- **Auto-cleanup**: Oldest snapshots are removed when limit is reached

## Tips

- **More snapshots = smoother movement**: Let real-time mode run longer
- **Snapshots are lost on page refresh**: They're stored in memory only
- **For persistent data**: Would need to save snapshots to a file/database

## Configuration

In `src/config.js`:
```javascript
updateInterval: 30000, // Time between snapshots (milliseconds)
```

To collect more snapshots faster, reduce this value (e.g., `10000` = every 10 seconds).

