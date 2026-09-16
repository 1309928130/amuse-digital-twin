# SketchUp Model Alignment Guide

## Coordinate System Differences

### SketchUp Coordinate System
- **X-axis**: Red (East/West)
- **Y-axis**: Green (Up/Down - vertical)
- **Z-axis**: Blue (North/South)
- **Origin**: Usually at model origin (0,0,0)

### Cesium Coordinate System
- **X-axis**: East
- **Y-axis**: North  
- **Z-axis**: Up (vertical)
- **Origin**: Geographic coordinates (longitude, latitude, height)

## Common Rotation Issues

### Issue 1: Y-up vs Z-up
SketchUp uses **Y-up** (vertical), while Cesium uses **Z-up**. This often requires a **90-degree rotation around X-axis**.

### Issue 2: North Direction
SketchUp's default "north" might not match geographic north. You may need to rotate around the Z-axis.

### Issue 3: Model Facing Wrong Direction
The model might be facing the wrong way, requiring heading rotation.

## Strategies to Fix Alignment

### Strategy 1: Fix in SketchUp Before Export (Recommended)

**Before exporting:**
1. **Set Geographic Location**:
   - Window → Model Info → Geo-location
   - Set location to Amsterdam, Netherlands
   - This ensures coordinates match

2. **Orient Model Correctly**:
   - Use "North" tool to align model with geographic north
   - Ensure model is at ground level (Z=0 or appropriate height)

3. **Export Settings**:
   - File → Export → 3D Model → glTF
   - Check export options:
     - ✅ Y-up (if available)
     - ✅ Include materials
     - ✅ Include textures

### Strategy 2: Adjust Rotation in Code

Use the `orientation` option when loading:

```javascript
await loadLargeModel(
    './models/building_block1.glb',
    position,
    {
        orientation: {
            heading: 0,    // Rotation around Z-axis (0-360°)
            pitch: 0,     // Rotation around Y-axis (nose up/down)
            roll: 0       // Rotation around X-axis (tilt left/right)
        }
    }
);
```

**Common fixes:**
- **Model on its side**: `roll: 90` or `roll: -90`
- **Model upside down**: `pitch: 180`
- **Model facing wrong direction**: `heading: 90` (rotate 90° clockwise), `heading: -90` (rotate 90° counter-clockwise)
- **Y-up to Z-up conversion**: `roll: -90` (rotate -90° around X-axis)

### Strategy 3: Fix in Blender (Intermediate Step)

1. Import GLB into Blender
2. Rotate model to correct orientation
3. Export as GLB again
4. Load in Cesium

**Blender rotation:**
- Select model → Press `R` (rotate)
- `R X 90` = rotate 90° around X-axis
- `R Y 90` = rotate 90° around Y-axis
- `R Z 90` = rotate 90° around Z-axis

### Strategy 4: Determine Correct Rotation

**Method A: Trial and Error**
1. Start with `heading: 0, pitch: 0, roll: 0`
2. Try common rotations:
   - `roll: -90` (Y-up to Z-up)
   - `heading: 90` (rotate 90°)
   - `pitch: 90` (stand model upright)
3. Adjust incrementally until correct

**Method B: Use Known Reference Points**
1. Identify a corner or feature in your model
2. Note its position in SketchUp
3. Check where it appears in Cesium
4. Calculate rotation needed

**Method C: Use Console Commands**
```javascript
// In browser console, get the model entity
const viewer = Cesium.viewer;
const entities = viewer.entities.values;
const building = entities.find(e => e.name === 'Building Block 1');

// Try different rotations
building.orientation = Cesium.Transforms.headingPitchRollQuaternion(
    building.position.getValue(),
    new Cesium.HeadingPitchRoll(
        Cesium.Math.toRadians(0),   // heading
        Cesium.Math.toRadians(0),   // pitch
        Cesium.Math.toRadians(-90)  // roll - try different values
    )
);
```

## Position Alignment

### Get Model Coordinates from SketchUp

1. **In SketchUp**:
   - Select a reference point (e.g., corner of building)
   - Note its X, Y, Z coordinates
   - Or use "Get Info" on a component

2. **Convert to Geographic**:
   - If you set geographic location in SketchUp, coordinates should match
   - Otherwise, you'll need to manually calculate offset

### Set Position in Code

```javascript
await loadLargeModel(
    './models/building_block1.glb',
    {
        longitude: 4.8625,  // Adjust based on SketchUp coordinates
        latitude: 52.3375, // Adjust based on SketchUp coordinates
        height: 0           // Adjust based on SketchUp Z coordinate
    },
    options
);
```

## Quick Reference: Common Rotations

| Problem | Solution |
|---------|----------|
| Model on its side | `roll: 90` or `roll: -90` |
| Model upside down | `pitch: 180` |
| Model facing wrong way | `heading: 90` or `heading: -90` or `heading: 180` |
| Y-up to Z-up | `roll: -90` |
| Z-up to Y-up | `roll: 90` |
| 90° clockwise | `heading: -90` |
| 90° counter-clockwise | `heading: 90` |

## Testing Rotation

1. Load model with default orientation
2. Note which direction it's facing
3. Adjust one axis at a time:
   - Start with `roll` (X-axis) - fixes up/down orientation
   - Then `heading` (Z-axis) - fixes compass direction
   - Finally `pitch` (Y-axis) - fixes forward/backward tilt
4. Test incrementally (try 90°, -90°, 180°)

## Best Practice Workflow

1. **In SketchUp**:
   - Set geographic location
   - Orient model with north pointing up
   - Place model at origin or known coordinates
   - Export as GLB

2. **In Code**:
   - Start with `orientation: { heading: 0, pitch: 0, roll: 0 }`
   - If rotated, try `roll: -90` first (Y-up to Z-up conversion)
   - Adjust `heading` for compass direction
   - Fine-tune as needed

3. **Verify**:
   - Check model appears at correct location
   - Check model is upright
   - Check model faces correct direction
   - Compare with satellite imagery or known landmarks

