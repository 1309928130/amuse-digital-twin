# SketchUp Model Import Guide

## Overview

This guide explains how to import 3D models from SketchUp into your Cesium-based Zuidas visualization.

## Supported Formats

Cesium supports **glTF** and **GLB** formats, which SketchUp can export. These are the recommended formats for web-based 3D visualization.

## Exporting from SketchUp

### Step 1: Prepare Your Model in SketchUp

1. Open your model in SketchUp
2. Ensure your model is properly scaled and oriented
3. If needed, group components for better organization

### Step 2: Export to glTF/GLB

**Option A: Using SketchUp's Built-in Export (SketchUp 2021+)**

1. Go to **File > Export > 3D Model**
2. In the export dialog:
   - **File type**: Select "glTF" or "GLB"
   - **File name**: Choose a name (e.g., `my-building.glb`)
   - **Location**: Save to your project's `models/` directory
3. Click **Export**

**Option B: Using Extensions**

If you don't have glTF export in your SketchUp version, you can:

1. Export to **Collada (.dae)** or **OBJ** first
2. Use a converter tool like:
   - [glTF Converter](https://products.aspose.app/3d/conversion) (online)
   - [Blender](https://www.blender.org/) (free, can import OBJ/DAE and export glTF)

### Step 3: Place Model File

Place your exported `.gltf` or `.glb` file in the `models/` directory:

```
your-project/
  models/
    my-building.glb
    another-model.gltf
```

## Loading Models in Code

### Basic Usage

```javascript
import { loadSketchupModel } from './src/sketchupModelLoader.js';

// Load a single model
const model = await loadSketchupModel('./models/my-building.glb', {
    longitude: 4.8625,  // Zuidas center longitude
    latitude: 52.3375, // Zuidas center latitude
    height: 0          // Height above ground in meters
});
```

### With Options

```javascript
const model = await loadSketchupModel('./models/my-building.glb', {
    longitude: 4.8625,
    latitude: 52.3375,
    height: 0
}, {
    name: 'My Custom Building',
    scale: 1.0,  // Scale factor (1.0 = original size)
    orientation: {
        heading: 45,  // Rotate 45 degrees (0 = North)
        pitch: 0,     // Tilt up/down
        roll: 0       // Roll left/right
    },
    color: Cesium.Color.WHITE,  // Color tint (optional)
    minimumPixelSize: 128  // Don't render if smaller than 128 pixels
});
```

### Loading Multiple Models

```javascript
import { loadSketchupModels } from './src/sketchupModelLoader.js';

const models = await loadSketchupModels([
    {
        url: './models/building1.glb',
        position: { longitude: 4.8625, latitude: 52.3375, height: 0 },
        options: { name: 'Building 1', scale: 1.0 }
    },
    {
        url: './models/building2.glb',
        position: { longitude: 4.8700, latitude: 52.3400, height: 0 },
        options: { name: 'Building 2', scale: 1.0 }
    }
]);
```

## Model Management

### Update Position

```javascript
import { updateSketchupModelPosition } from './src/sketchupModelLoader.js';

updateSketchupModelPosition(model, {
    longitude: 4.8650,
    latitude: 52.3380,
    height: 10
});
```

### Update Orientation

```javascript
import { updateSketchupModelOrientation } from './src/sketchupModelLoader.js';

updateSketchupModelOrientation(model, {
    heading: 90,  // Rotate to face East
    pitch: 0,
    roll: 0
});
```

### Update Scale

```javascript
import { updateSketchupModelScale } from './src/sketchupModelLoader.js';

updateSketchupModelScale(model, 2.0);  // Make it 2x larger
```

### Remove Model

```javascript
import { removeSketchupModel } from './src/sketchupModelLoader.js';

removeSketchupModel(model);  // Remove specific model
// or
removeSketchupModel(model.id);  // Remove by ID
```

### Remove All Models

```javascript
import { removeAllSketchupModels } from './src/sketchupModelLoader.js';

removeAllSketchupModels();
```

## Coordinate System

**Important**: SketchUp models are typically created in a local coordinate system. When importing to Cesium:

1. **Position**: Specify the geographic location (longitude, latitude) where the model should appear
2. **Scale**: You may need to adjust scale if SketchUp units don't match meters
3. **Orientation**: Use heading to rotate the model to match geographic North

### Finding Coordinates

- Use Google Maps: Right-click on location → Copy coordinates
- Use Cesium Inspector: Click on the map to see coordinates
- Use the Zuidas bounds from `src/config.js`:
  ```javascript
  export const ZUIDAS_BOUNDS = {
      north: 52.345,
      south: 52.330,
      east: 4.875,
      west: 4.850
  };
  ```

## Scale Considerations

SketchUp models may need scaling:

- **If model is in meters**: Usually `scale: 1.0` works
- **If model is in feet**: Use `scale: 0.3048` (feet to meters)
- **If model is in inches**: Use `scale: 0.0254` (inches to meters)
- **If model is too small/large**: Adjust scale accordingly

## Tips for Best Results

1. **Optimize Your Model**:
   - Reduce polygon count for better performance
   - Use textures instead of complex geometry
   - Remove hidden/unnecessary faces

2. **Export Settings**:
   - Use GLB format (binary) for smaller file sizes
   - Include textures in the export
   - Check "Export materials" option

3. **Performance**:
   - Use `minimumPixelSize` to cull models when far away
   - Use `maximumScale` to limit maximum size
   - Consider using lower detail versions for distant views

4. **Positioning**:
   - Start with `height: 0` and adjust if needed
   - Use `CLAMP_TO_GROUND` if your model should sit on terrain
   - Check alignment with existing buildings

## Example: Complete Integration

```javascript
// In main.js or a custom module
import { loadSketchupModel } from './src/sketchupModelLoader.js';
import { ZUIDAS_CENTER } from './src/config.js';

async function loadCustomBuildings() {
    try {
        // Load a custom building model
        const building = await loadSketchupModel(
            './models/custom-building.glb',
            {
                longitude: ZUIDAS_CENTER.longitude,
                latitude: ZUIDAS_CENTER.latitude,
                height: 0
            },
            {
                name: 'Custom Building',
                scale: 1.0,
                orientation: { heading: 0, pitch: 0, roll: 0 }
            }
        );
        
        console.log('Custom building loaded:', building);
        
        // Optionally fly to the model
        const viewer = getViewer();
        viewer.flyTo(building);
        
    } catch (error) {
        console.error('Error loading custom building:', error);
    }
}

// Call after viewer is initialized
loadCustomBuildings();
```

## Troubleshooting

### Model Not Appearing

1. **Check file path**: Ensure the file exists in `models/` directory
2. **Check console**: Look for error messages
3. **Check coordinates**: Model might be outside visible area
4. **Check scale**: Model might be too small to see

### Model Appears Wrong Size

- Adjust the `scale` parameter
- Check SketchUp's unit settings (Window > Model Info > Units)

### Model Appears in Wrong Location

- Verify longitude/latitude coordinates
- Check if height is correct
- Ensure model origin in SketchUp is at the base

### Performance Issues

- Reduce polygon count in SketchUp
- Use lower detail models
- Set `minimumPixelSize` to cull distant models
- Use GLB format (smaller than glTF)

## Resources

- **SketchUp**: https://www.sketchup.com/
- **glTF Format**: https://www.khronos.org/gltf/
- **Cesium Model Documentation**: https://cesium.com/learn/cesiumjs/ref-doc/Model.html
- **glTF Validator**: https://github.khronos.org/glTF-Validator/

## Notes

- SketchUp models are loaded as **entities** in Cesium, not as tilesets
- Models support shadows and lighting
- Models can be selected and inspected in Cesium
- Multiple models can be loaded simultaneously
- Models are independent of 3DBAG tiles (can be used together)


