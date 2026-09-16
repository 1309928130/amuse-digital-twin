# Large Model Loading Guide

## Your Model: 254MB GLB File

Your model `250808_Datamodel Zuidas_SortByEnshan.glb` is **254MB**, which is quite large for web use. Here's how to load it efficiently.

## ⚠️ Performance Considerations

**Is 254MB too large?**
- **For web use**: Yes, it's on the large side
- **Can it work?**: Yes, but expect:
  - Long initial load time (30-60+ seconds depending on connection)
  - High memory usage (500MB-1GB+ in browser)
  - Potential browser crashes on low-end devices
  - Slower frame rates

## Quick Start: Load Your Model

### Option 1: Simple Load (Try This First)

```javascript
import { loadLargeModel } from './src/largeModelLoader.js';
import { ZUIDAS_CENTER } from './src/config.js';

// Load your model
const model = await loadLargeModel(
    './models/250808_Datamodel Zuidas_SortByEnshan.glb',
    {
        longitude: ZUIDAS_CENTER.longitude,
        latitude: ZUIDAS_CENTER.latitude,
        height: 0
    },
    {
        name: 'Zuidas Datamodel',
        scale: 1.0
    }
);
```

### Option 2: With Performance Optimizations

```javascript
const model = await loadLargeModel(
    './models/250808_Datamodel Zuidas_SortByEnshan.glb',
    {
        longitude: ZUIDAS_CENTER.longitude,
        latitude: ZUIDAS_CENTER.latitude,
        height: 0
    },
    {
        name: 'Zuidas Datamodel',
        scale: 1.0,
        minimumPixelSize: 512,        // Higher = cull when smaller (better performance)
        enableShadows: false,          // Disable shadows for better performance
        allowPicking: false,           // Disable picking for better performance
        showLoadingIndicator: true     // Show loading progress
    }
);
```

## 🚀 Optimization Strategies

### 1. **Optimize the GLB File** (Recommended)

Before loading, optimize your model:

**Using glTF-Pipeline (Command Line)**
```bash
npm install -g gltf-pipeline

# Optimize the model
gltf-pipeline -i "models/250808_Datamodel Zuidas_SortByEnshan.glb" \
              -o "models/zuidas-optimized.glb" \
              --draco.compressionLevel 7 \
              --draco.quantizePositionBits 14 \
              --draco.quantizeNormalBits 10 \
              --draco.quantizeTexcoordBits 12 \
              --draco.quantizeColorBits 8 \
              --textureCompression webp
```

**Using Online Tools**
- [glTF-Transform](https://gltf-transform.donmccurdy.com/) - Online optimizer
- [glTF Pipeline Online](https://glb-packer.glitch.me/) - Drag and drop

**Expected Results:**
- 254MB → 50-100MB (with Draco compression)
- Much faster loading
- Better performance

### 2. **Split Into Multiple Models**

If your model contains multiple buildings/objects:

1. Split it into separate GLB files
2. Load only visible parts
3. Use level-of-detail (LOD) - load low detail when far, high detail when close

### 3. **Convert to 3D Tiles** (Best for Large Models)

For very large models, convert to Cesium 3D Tiles:

**Using Cesium Ion**
1. Upload to [Cesium Ion](https://ion.cesium.com/)
2. Convert to 3D Tiles
3. Use the tileset URL

**Using 3D Tiles Tools**
- [obj23dtiles](https://github.com/CesiumGS/obj2gltf) - Convert OBJ to 3D Tiles
- [gltf-to-3dtiles](https://github.com/geo-data/gltf-to-3dtiles) - Convert glTF to 3D Tiles

**Benefits:**
- Streaming (loads on demand)
- Automatic LOD
- Better performance
- Can handle models of any size

### 4. **Reduce Model Complexity**

In your modeling software:
- Reduce polygon count
- Simplify geometry
- Compress textures
- Remove unnecessary details
- Use instancing for repeated elements

## 📊 Performance Settings

### Conservative (Best Performance)

```javascript
{
    minimumPixelSize: 1024,      // Only show when > 1024 pixels
    enableShadows: false,        // No shadows
    allowPicking: false,         // No picking
    maximumScale: 10000          // Limit max size
}
```

### Balanced (Recommended)

```javascript
{
    minimumPixelSize: 512,       // Show when > 512 pixels
    enableShadows: false,        // No shadows
    allowPicking: true,          // Allow picking
    maximumScale: 20000          // Standard max size
}
```

### Maximum Quality (Slower)

```javascript
{
    minimumPixelSize: 128,       // Show even when small
    enableShadows: true,         // Enable shadows
    allowPicking: true,          // Allow picking
    maximumScale: 50000          // Very large max size
}
```

## 🔧 Loading in Your App

### Add to main.js

```javascript
import { loadLargeModel } from './src/largeModelLoader.js';
import { ZUIDAS_CENTER } from './src/config.js';

async function loadZuidasModel() {
    try {
        console.log('Loading Zuidas datamodel...');
        
        const model = await loadLargeModel(
            './models/250808_Datamodel Zuidas_SortByEnshan.glb',
            {
                longitude: ZUIDAS_CENTER.longitude,
                latitude: ZUIDAS_CENTER.latitude,
                height: 0
            },
            {
                name: 'Zuidas Datamodel',
                scale: 1.0,
                minimumPixelSize: 512,
                enableShadows: false,
                showLoadingIndicator: true
            }
        );
        
        console.log('Zuidas model loaded successfully!');
        
        // Optionally fly to the model
        const viewer = getViewer();
        viewer.flyTo(model);
        
    } catch (error) {
        console.error('Error loading Zuidas model:', error);
    }
}

// Call after viewer initialization
// In your initialize() function, after buildings are loaded:
loadZuidasModel();
```

## 🎯 Recommended Approach

1. **First**: Try loading as-is with optimizations
2. **If too slow**: Optimize the GLB file using gltf-pipeline
3. **If still too slow**: Consider splitting into multiple models
4. **For production**: Convert to 3D Tiles for best performance

## 📝 File Size Guidelines

| Size | Status | Recommendation |
|------|--------|----------------|
| < 10MB | ✅ Good | Load directly |
| 10-50MB | ⚠️ Acceptable | Load with optimizations |
| 50-100MB | ⚠️ Large | Optimize first |
| 100-200MB | ⚠️ Very Large | Optimize or split |
| **200MB+** | ❌ **Too Large** | **Optimize or convert to 3D Tiles** |

Your 254MB model falls in the "Too Large" category, so optimization is highly recommended.

## 🛠️ Troubleshooting

### Model Not Loading
- Check browser console for errors
- Verify file path is correct
- Check CORS settings if loading from different domain
- Ensure sufficient memory available

### Browser Crashes
- Reduce `minimumPixelSize` to cull model when far
- Disable shadows
- Close other browser tabs
- Use a more powerful device

### Slow Performance
- Optimize the GLB file
- Increase `minimumPixelSize`
- Disable shadows
- Reduce other visualizations (heatmap, wind, etc.)

## 📚 Resources

- [glTF-Pipeline](https://github.com/CesiumGS/gltf-pipeline) - Optimization tool
- [Cesium 3D Tiles](https://github.com/CesiumGS/3d-tiles) - Tileset format
- [glTF Best Practices](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/README.md#best-practices)

