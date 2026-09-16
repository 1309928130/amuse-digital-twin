# Quick Fix: SketchUp Model Rotation

## The Problem
Your SketchUp model (`building_block1.glb`) is rotated incorrectly in Cesium.

## Quick Solution

### Option 1: Adjust in Config File (Easiest)

1. Open `src/config.js`
2. Find `SKETCHUP_CONFIG.defaultOrientation`
3. Adjust the values:

```javascript
defaultOrientation: { 
    heading: 0,   // Try: 0, 90, -90, 180
    pitch: 0,     // Try: 0, 90, -90, 180
    roll: -90     // Try: -90, 0, 90, 180 (most common: -90 for SketchUp)
}
```

4. Refresh browser

### Option 2: Test in Browser Console

Open browser console (F12) and run:

```javascript
// Get the building model
const viewer = Cesium.viewer;
const building = viewer.entities.values.find(e => e.name === 'Building Block 1');

// Try different rotations (adjust values)
building.orientation = Cesium.Transforms.headingPitchRollQuaternion(
    building.position.getValue(),
    new Cesium.HeadingPitchRoll(
        Cesium.Math.toRadians(0),    // heading - try 0, 90, -90, 180
        Cesium.Math.toRadians(0),    // pitch - try 0, 90, -90, 180
        Cesium.Math.toRadians(-90)   // roll - try -90, 0, 90, 180
    )
);
```

### Common Values to Try

**If model is on its side:**
- `roll: -90` or `roll: 90`

**If model is upside down:**
- `pitch: 180`

**If model faces wrong direction:**
- `heading: 90` (rotate 90° clockwise)
- `heading: -90` (rotate 90° counter-clockwise)
- `heading: 180` (rotate 180°)

**Most common for SketchUp:**
- `roll: -90` (converts Y-up to Z-up)

## Once You Find the Right Values

Update `src/config.js`:
```javascript
SKETCHUP_CONFIG.defaultOrientation = {
    heading: [your value],
    pitch: [your value],
    roll: [your value]
}
```

Then refresh the browser.

