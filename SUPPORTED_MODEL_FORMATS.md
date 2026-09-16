# Supported Model Formats

## Native Support (Direct Loading)

### ✅ glTF / GLB (Recommended)
- **Extensions**: `.gltf`, `.glb`
- **Status**: ✅ Fully supported - native Cesium format
- **Best for**: All 3D models
- **Usage**: Direct loading via `loadLargeModel()`, `loadSketchupModel()`, or `loadUnrealModel()`

**Why glTF/GLB?**
- Cesium's native and optimized format
- Best performance and compatibility
- Supports animations, materials, textures
- Industry standard for web 3D

**Example:**
```javascript
await loadLargeModel('./models/my-model.glb', {
    longitude: 4.8625,
    latitude: 52.3375,
    height: 0
});
```

### ✅ 3D Tiles
- **Extensions**: `.json` (tileset), `.b3dm`, `.i3dm`, `.pnts`, `.cmpt`
- **Status**: ✅ Fully supported - Cesium's streaming format
- **Best for**: Very large models, city-scale datasets, LOD (Level of Detail)
- **Usage**: Load via `Cesium.Cesium3DTileset`

**Example:**
```javascript
const tileset = viewer.scene.primitives.add(
    new Cesium.Cesium3DTileset({
        url: './models/my-tileset/tileset.json'
    })
);
```

**Note**: Your project already uses 3D Tiles for 3DBAG buildings!

### ✅ I3S (Indexed 3D Scene Layers)
- **Status**: ✅ Supported by Cesium
- **Best for**: ArcGIS/Esri integration
- **Usage**: Via `Cesium.I3SDataProvider`

## Conversion Required (Not Directly Supported)

These formats need to be converted to glTF/GLB before loading:

### 🔄 OBJ (.obj)
- **Status**: ❌ Not directly supported
- **Conversion**: Use Blender, glTF-Pipeline, or online converters
- **Best for**: Simple geometry, older models

**Conversion Options:**
1. **Blender** (Free):
   - Import OBJ → Export glTF/GLB
2. **Online**: [glTF Converter](https://products.aspose.app/3d/conversion)
3. **Command line**: `obj2gltf` (npm package)

### 🔄 FBX (.fbx)
- **Status**: ❌ Not directly supported
- **Conversion**: Use Blender, Autodesk FBX Converter, or online tools
- **Best for**: 3ds Max, Maya, Cinema 4D exports

**Conversion Options:**
1. **Blender**: Import FBX → Export glTF/GLB
2. **Autodesk FBX Converter**: Convert to OBJ, then to glTF
3. **Online**: Various FBX to glTF converters

### 🔄 COLLADA (.dae)
- **Status**: ❌ Not directly supported
- **Conversion**: Use Blender or online converters
- **Best for**: SketchUp exports (older versions), Google Earth models

**Conversion Options:**
1. **Blender**: Import DAE → Export glTF/GLB
2. **Online**: [glTF Converter](https://products.aspose.app/3d/conversion)

### 🔄 3DS (.3ds)
- **Status**: ❌ Not directly supported
- **Conversion**: Use Blender
- **Best for**: 3ds Max exports

### 🔄 STL (.stl)
- **Status**: ❌ Not directly supported
- **Conversion**: Use Blender
- **Best for**: 3D printing, simple geometry

### 🔄 PLY (.ply)
- **Status**: ❌ Not directly supported
- **Conversion**: Use Blender
- **Best for**: Point clouds, 3D scanning

### 🔄 X3D (.x3d)
- **Status**: ❌ Not directly supported
- **Conversion**: Use Blender or X3D to glTF converters
- **Best for**: Web3D standard models

## Current Project Support

Based on your codebase:

### ✅ Currently Implemented
- **glTF/GLB**: Via `loadLargeModel()`, `loadSketchupModel()`, `loadUnrealModel()`
- **3D Tiles**: Via `load3DBagTiles()` for 3DBAG buildings

### 📝 Configuration
See `src/config.js`:
```javascript
UNREAL_CONFIG = {
    supportedFormats: ['.gltf', '.glb']
}

SKETCHUP_CONFIG = {
    supportedFormats: ['.gltf', '.glb']
}
```

## Recommended Workflow

### For New Models:
1. **Export from your 3D software** → glTF/GLB (preferred)
2. **If not available**: Export to OBJ/FBX/DAE → Convert to glTF/GLB
3. **Place in `models/` folder**
4. **Load using appropriate loader function**

### For Very Large Models:
1. **Consider 3D Tiles** for better streaming and LOD
2. **Split into multiple glTF/GLB files** if too complex
3. **Use optimization tools** (`gltf-pipeline`) before loading

## Conversion Tools

### Desktop (Free)
- **Blender**: https://www.blender.org/
  - Supports: OBJ, FBX, DAE, 3DS, STL, PLY → glTF/GLB
  - Best for: Complex conversions, batch processing

### Online
- **glTF Converter**: https://products.aspose.app/3d/conversion
- **FBX to glTF**: Various online tools available

### Command Line
- **gltf-pipeline**: `npm install -g gltf-pipeline`
  - Optimizes and converts glTF files
- **obj2gltf**: `npm install -g obj2gltf`
  - Converts OBJ to glTF

## Summary Table

| Format | Extension | Direct Support | Conversion Needed | Best For |
|--------|-----------|----------------|-------------------|----------|
| **glTF** | `.gltf` | ✅ Yes | No | All models |
| **GLB** | `.glb` | ✅ Yes | No | All models (binary) |
| **3D Tiles** | `.json` | ✅ Yes | No | Large datasets |
| **I3S** | Various | ✅ Yes | No | ArcGIS integration |
| **OBJ** | `.obj` | ❌ No | ✅ Yes | Simple geometry |
| **FBX** | `.fbx` | ❌ No | ✅ Yes | 3ds Max, Maya |
| **COLLADA** | `.dae` | ❌ No | ✅ Yes | SketchUp, Google Earth |
| **3DS** | `.3ds` | ❌ No | ✅ Yes | 3ds Max |
| **STL** | `.stl` | ❌ No | ✅ Yes | 3D printing |
| **PLY** | `.ply` | ❌ No | ✅ Yes | Point clouds |

## Quick Reference

**To load a model in your project:**
```javascript
// glTF/GLB models
import { loadLargeModel } from './src/largeModelLoader.js';
await loadLargeModel('./models/my-model.glb', position, options);

// SketchUp models (also glTF/GLB)
import { loadSketchupModel } from './src/sketchupModelLoader.js';
await loadSketchupModel('./models/sketchup-model.glb', position, options);

// 3D Tiles
const tileset = viewer.scene.primitives.add(
    new Cesium.Cesium3DTileset({
        url: './models/tileset/tileset.json'
    })
);
```

**To convert other formats:**
1. Use Blender (recommended) or online converters
2. Export as glTF/GLB
3. Place in `models/` folder
4. Load using the functions above

