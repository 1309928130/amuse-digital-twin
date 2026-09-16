# Loading QGIS Boundary in Cesium

## Quick Method: Export from QGIS as GeoJSON

### Step 1: Open QGIS Project
1. Open QGIS (download from https://qgis.org/ if needed)
2. **File → Open Project**
3. Select `Zuidas.qgz`
4. Wait for project to load

### Step 2: Find the Boundary Layer
1. Look in the **Layers Panel** (usually on the left)
2. Find the layer that represents the Zuidas boundary
   - It might be named "Zuidas", "Boundary", "Area", etc.
   - It should be a polygon/vector layer

### Step 3: Export as GeoJSON
1. **Right-click** on the boundary layer
2. Select **Export → Save Features As...**
3. In the dialog:
   - **Format**: GeoJSON
   - **File name**: `zuidas-boundary.geojson`
   - **Save to**: Your project's `models/` folder
4. Click **OK**

### Step 4: Load in Cesium
The code will automatically load `models/zuidas-boundary.geojson` if it exists.

## Alternative: Export as KML
1. Same steps as above, but choose **Format: KML** instead
2. Save as `zuidas-boundary.kml`
3. The code will load it automatically

## Using the Boundary Loader

### Method 1: Automatic Loading (Recommended)
Place your exported GeoJSON/KML file in the `models/` folder with one of these names:
- `zuidas-boundary.geojson`
- `zuidas-boundary.kml`

The code will automatically load it on startup.

### Method 2: Manual Loading
```javascript
import { loadBoundaryFromGeoJSON } from './src/boundaryLoader.js';

// Load from file
await loadBoundaryFromGeoJSON('./models/zuidas-boundary.geojson', {
    strokeColor: Cesium.Color.YELLOW,
    strokeWidth: 3,
    fillColor: Cesium.Color.YELLOW.withAlpha(0.2),
    name: 'Zuidas Boundary'
});

// Or load from coordinates
import { loadBoundaryFromCoordinates } from './src/boundaryLoader.js';

const coordinates = [
    [4.85, 52.33],  // [longitude, latitude]
    [4.87, 52.33],
    [4.87, 52.34],
    [4.85, 52.34],
    [4.85, 52.33]   // Close the polygon
];

loadBoundaryFromCoordinates(coordinates, {
    strokeColor: Cesium.Color.CYAN,
    fillColor: Cesium.Color.CYAN.withAlpha(0.1)
});
```

## Customization Options

```javascript
await loadBoundaryFromGeoJSON('./models/zuidas-boundary.geojson', {
    strokeColor: Cesium.Color.YELLOW,      // Border color
    strokeWidth: 3,                         // Border width (pixels)
    fillColor: Cesium.Color.YELLOW.withAlpha(0.2),  // Fill color (with transparency)
    height: 0,                              // Base height
    extrudedHeight: 100,                    // Extrude height (for 3D effect)
    clampToGround: true,                    // Clamp to terrain
    name: 'Zuidas Area'                     // Display name
});
```

## Troubleshooting

### "File not found"
- Make sure the GeoJSON/KML file is in the `models/` folder
- Check the filename matches exactly (case-sensitive)

### "Boundary not visible"
- Check browser console for errors
- Try adjusting colors (might be same color as background)
- Try increasing `strokeWidth`
- Check if coordinates are in correct range (longitude: -180 to 180, latitude: -90 to 90)

### "Wrong location"
- QGIS might use a different coordinate system
- Make sure you export in WGS84 (EPSG:4326) - this is the default for GeoJSON
- In QGIS export dialog, check "CRS" is set to "EPSG:4326 - WGS 84"

## Coordinate System Note

Cesium uses **WGS84 (EPSG:4326)** coordinates:
- Longitude: -180 to 180 (X-axis)
- Latitude: -90 to 90 (Y-axis)

Make sure your QGIS export uses this coordinate system!

