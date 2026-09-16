# 3DBAG Integration Guide

## What is 3DBAG?

3DBAG (3D Building dataset for the Netherlands) is a high-quality 3D building dataset covering the entire Netherlands. It provides more detailed and accurate building models than OpenStreetMap (OSM).

**Website**: https://3dbag.nl/

## Two Ways to Use 3DBAG

### Option 1: Streaming 3D Tiles (Recommended) ⭐

**Best for**: Most use cases - no download needed, better performance

3DBAG provides Cesium 3D Tiles that stream directly to your application. This is the easiest and most efficient way to use 3DBAG.

**Advantages**:
- ✅ No download needed
- ✅ Automatic updates when 3DBAG releases new versions
- ✅ Better performance (only loads visible tiles)
- ✅ Works immediately

**How to enable**:

1. Open `src/config.js`
2. Set `THREEDBAG_CONFIG.enabled = true`
3. Choose your LoD level:
   - `lod12`: Simple extruded buildings (fastest)
   - `lod13`: Buildings with roof shapes (recommended, good balance)
   - `lod22`: Detailed buildings with textures (most detailed, slower)

Example:
```javascript
export const THREEDBAG_CONFIG = {
    enabled: true,  // Enable 3DBAG
    lod: 'lod13',   // Use LoD1.3 (recommended)
    replaceOSM: true, // Remove OSM buildings when loading 3DBAG
    maximumScreenSpaceError: 16
};
```

4. Refresh your application - 3DBAG buildings will load automatically!

### Option 2: Download Tiles for Offline Use

**Best for**: Offline applications, custom processing, or when you need specific formats

If you need to download tiles for offline use or want to process them locally:

1. **Manual Download** (Easiest):
   - Visit: https://3dbag.nl/nl/download
   - Click "Kies een tegel" (Choose a tile)
   - Select tiles covering Zuidas area
   - Download in your preferred format (CityJSON, OBJ, or GPKG)

2. **Using the Download Script**:
   ```bash
   npm run download-3dbag cityjson lod12
   ```
   
   Note: The script currently requires manual tile identification. For accurate tile selection, you need to:
   - Download the tile index (`tile_index.fgb`)
   - Parse it with a FlatGeoBuf library
   - Find tiles that intersect Zuidas bounds

## LoD Levels Explained

3DBAG offers three levels of detail:

| LoD | Name | Description | Performance | Use Case |
|-----|------|-------------|-------------|----------|
| `lod12` | LoD1.2 | Simple extruded buildings | ⚡ Fastest | Large areas, overview |
| `lod13` | LoD1.3 | Buildings with roof shapes | ⚡⚡ Balanced | **Recommended** for most cases |
| `lod22` | LoD2.2 | Detailed with textures | ⚡⚡⚡ Slower | Close-up views, detailed analysis |

## Zuidas Area

The Zuidas area is defined in `src/config.js`:

```javascript
export const ZUIDAS_BOUNDS = {
    north: 52.345,
    south: 52.330,
    east: 4.875,
    west: 4.850
};
```

## Switching Between OSM and 3DBAG

You can easily switch between OSM and 3DBAG by changing `THREEDBAG_CONFIG.enabled`:

- `enabled: false` → Uses OSM buildings (current default)
- `enabled: true` → Uses 3DBAG buildings

## Performance Tips

1. **Start with LoD1.3**: Good balance of detail and performance
2. **Adjust `maximumScreenSpaceError`**: 
   - Lower values (8-12) = more detail, slower
   - Higher values (16-32) = less detail, faster
3. **Use LoD1.2 for large areas**: If viewing the entire Netherlands
4. **Use LoD2.2 for close-ups**: Only when zoomed in on specific buildings

## API Reference

### Load 3DBAG Tiles

```javascript
import { load3DBagTiles } from './src/threeDBagLoader.js';

// Load LoD1.3 (recommended)
await load3DBagTiles('lod13', {
    replaceOSM: true,  // Remove OSM buildings
    maximumScreenSpaceError: 16,
    flyTo: true  // Fly camera to tileset
});
```

### Switch LoD Level

```javascript
import { switch3DBagLod } from './src/threeDBagLoader.js';

// Switch to LoD2.2 for more detail
await switch3DBagLod('lod22');
```

### Remove 3DBAG Tiles

```javascript
import { remove3DBagTiles } from './src/threeDBagLoader.js';

remove3DBagTiles();
```

## Troubleshooting

### 3DBAG tiles not loading

1. **Check internet connection**: 3D Tiles are streamed from the internet
2. **Check console for errors**: Look for CORS or network errors
3. **Verify URL**: Check that `THREEDBAG_CONFIG.baseUrl` is correct
4. **Try a different LoD**: Some LoD levels may have issues

### Performance issues

1. **Reduce LoD level**: Try `lod12` instead of `lod22`
2. **Increase `maximumScreenSpaceError`**: Try 32 or higher
3. **Check network speed**: 3D Tiles require good internet connection

### Buildings not showing

1. **Check if tileset loaded**: Look for `[3DBAG] ✓ Successfully loaded` in console
2. **Verify camera position**: Fly to Zuidas area
3. **Check bounding sphere**: Ensure tileset covers Zuidas area

## Comparison: OSM vs 3DBAG

| Feature | OSM Buildings | 3DBAG Buildings |
|---------|---------------|-----------------|
| **Detail Level** | Basic | High |
| **Roof Shapes** | No | Yes (LoD1.3+) |
| **Textures** | No | Yes (LoD2.2) |
| **Coverage** | Worldwide | Netherlands only |
| **Update Frequency** | Continuous | Periodic releases |
| **Data Source** | Community | Official (BAG) |
| **Performance** | Good | Better (streaming) |
| **Offline Support** | Yes (downloadable) | Yes (downloadable) |

## License

3DBAG is licensed under **CC BY 4.0** (Creative Commons Attribution 4.0).

You must attribute: "3DBAG by the 3D geoinformation research group and 3DGI"

## Resources

- **3DBAG Website**: https://3dbag.nl/
- **Download Page**: https://3dbag.nl/nl/download
- **Documentation**: https://3dbag.nl/nl/documentatie
- **3D Viewer**: https://3dbag.nl/nl/viewer

## Support

If you encounter issues:
1. Check the browser console for errors
2. Verify your internet connection
3. Try a different LoD level
4. Check the 3DBAG website for service status




