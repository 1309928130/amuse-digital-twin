# How to Use 3DBAG Webservices

3DBAG provides several webservices that allow you to access 3D building data without downloading files. Here's how to use each one:

## 1. 3D Tiles (For Cesium) ⭐ **RECOMMENDED FOR YOUR APP**

**What it is**: Streaming 3D building tiles optimized for Cesium.js

**URLs**:
- **LoD1.2** (Simple): `https://data.3dbag.nl/v20250903/cesium3dtiles/lod12/tileset.json`
- **LoD1.3** (Roof shapes): `https://data.3dbag.nl/v20250903/cesium3dtiles/lod13/tileset.json`
- **LoD2.2** (Detailed): `https://data.3dbag.nl/v20250903/cesium3dtiles/lod22/tileset.json`

**How to use in your app**:

✅ **Already configured!** Since you enabled `THREEDBAG_CONFIG.enabled = true`, your app will automatically use these 3D Tiles.

The code in `src/threeDBagLoader.js` loads these tiles automatically. Just refresh your browser and you'll see 3DBAG buildings!

**To change LoD level**:
1. Open `src/config.js`
2. Change `lod: 'lod13'` to `lod: 'lod12'` or `lod: 'lod22'`
3. Refresh your app

**Example code** (already in your app):
```javascript
import { load3DBagTiles } from './src/threeDBagLoader.js';

// Load LoD1.3 (recommended)
await load3DBagTiles('lod13');
```

---

## 2. WMS (Web Map Service)

**What it is**: 2D map service for viewing buildings in GIS software like QGIS

**URL**: `https://data.3dbag.nl/api/BAG3D/wms?request=getcapabilities`

**How to use**:

### In QGIS:
1. Open QGIS
2. Go to **Layer** → **Add Layer** → **Add WMS/WMTS Layer**
3. Click **New** to create a new connection
4. Enter:
   - **Name**: `3DBAG`
   - **URL**: `https://data.3dbag.nl/api/BAG3D/wms?request=getcapabilities`
5. Click **OK**, then **Connect**
6. Select a layer and click **Add**

### In your browser:
Open the capabilities URL to see available layers:
```
https://data.3dbag.nl/api/BAG3D/wms?request=getcapabilities
```

**Note**: WMS only shows 2D projections, not 3D models.

---

## 3. WFS (Web Feature Service)

**What it is**: Service for downloading building geometries as vector data

**URL**: `https://data.3dbag.nl/api/BAG3D/wfs?request=getcapabilities`

**How to use**:

### In QGIS:
1. Go to **Layer** → **Add Layer** → **Add WFS Layer**
2. Click **New** to create a new connection
3. Enter:
   - **Name**: `3DBAG WFS`
   - **URL**: `https://data.3dbag.nl/api/BAG3D/wfs?request=getcapabilities`
4. Click **OK**, then **Connect**
5. Select a layer and click **Add**

### Using HTTP requests:
You can query specific areas using WFS requests:

```javascript
// Get buildings in a bounding box (Zuidas area)
const bbox = '4.850,52.330,4.875,52.345'; // west,south,east,north
const url = `https://data.3dbag.nl/api/BAG3D/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=bag3d:lod12&bbox=${bbox}&outputFormat=application/json`;
```

**Note**: WFS also only provides 2D projections.

---

## 4. 3D API (Experimental)

**What it is**: REST API for querying 3D building data programmatically

**Base URL**: `https://api.3dbag.nl/`

**How to use**:

### Example: Get building by ID
```javascript
// Get a specific building
const buildingId = '0363010000000001'; // Example BAG ID
const url = `https://api.3dbag.nl/buildings/${buildingId}`;

fetch(url)
    .then(response => response.json())
    .then(data => console.log(data));
```

### Example: Search buildings in area
```javascript
// Search buildings in bounding box
const bbox = {
    minX: 4.850,  // west
    minY: 52.330, // south
    maxX: 4.875,  // east
    maxY: 52.345  // north
};

const url = `https://api.3dbag.nl/buildings?bbox=${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`;

fetch(url)
    .then(response => response.json())
    .then(data => console.log(data));
```

**Note**: This API is experimental and may change.

---

## Quick Reference

| Service | Use Case | Format | 3D Support |
|---------|----------|--------|------------|
| **3D Tiles** | Cesium.js visualization | Streaming tiles | ✅ Yes |
| **WMS** | GIS mapping (QGIS) | Raster images | ❌ No (2D only) |
| **WFS** | Download geometries | Vector data | ❌ No (2D only) |
| **3D API** | Programmatic access | JSON | ✅ Yes |

---

## For Your Cesium App

Since you're using Cesium.js, **3D Tiles is the best option**. It's already configured in your app!

**Current setup**:
- ✅ Enabled in `src/config.js`: `THREEDBAG_CONFIG.enabled = true`
- ✅ Using LoD1.3 (good balance)
- ✅ Automatically loads when app starts

**To test different LoD levels**:

1. **LoD1.2** (fastest, simple buildings):
   ```javascript
   // In src/config.js
   lod: 'lod12'
   ```

2. **LoD1.3** (recommended, roof shapes):
   ```javascript
   // In src/config.js
   lod: 'lod13'  // Current setting
   ```

3. **LoD2.2** (most detailed, with textures):
   ```javascript
   // In src/config.js
   lod: 'lod22'
   ```

**Or switch dynamically in browser console**:
```javascript
// Switch to LoD2.2 for more detail
import('./src/threeDBagLoader.js').then(module => {
    module.switch3DBagLod('lod22');
});
```

---

## Troubleshooting

### 3D Tiles not loading?

1. **Check browser console** for errors
2. **Verify URL** is correct: `https://data.3dbag.nl/v20250903/cesium3dtiles/lod13/tileset.json`
3. **Check internet connection** (tiles are streamed)
4. **Try different LoD**: Some levels may have issues

### Buildings not visible?

1. **Fly to Zuidas area**: The tileset covers all of Netherlands, make sure you're viewing the right area
2. **Check camera position**: Use `viewer.flyTo(tileset)` to navigate
3. **Verify tileset loaded**: Check console for `[3DBAG] ✓ Successfully loaded`

### Performance issues?

1. **Use LoD1.2** instead of LoD2.2
2. **Increase `maximumScreenSpaceError`** in config (try 32)
3. **Check network speed**: 3D Tiles require good internet

---

## Summary

For your Cesium visualization app:
- ✅ **Use 3D Tiles** (already configured!)
- ✅ **LoD1.3 is recommended** (good balance)
- ✅ **No additional setup needed** - just refresh your app

The other services (WMS, WFS, 3D API) are useful for:
- GIS analysis in QGIS
- Downloading data for offline processing
- Custom integrations

But for Cesium, stick with 3D Tiles - it's the best option! 🎉




