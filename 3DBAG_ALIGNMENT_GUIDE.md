# 3DBAG Building Alignment Guide

## Problem: Buildings Floating Above Ground

3DBAG buildings use **NAP** (Normaal Amsterdams Peil) vertical datum, while Cesium uses **WGS84 ellipsoid** heights. In the Netherlands, the geoid is approximately **49-50 meters below** the ellipsoid, causing buildings to appear floating.

## Solution: Adjust Height Offset

### Quick Fix

1. Open `src/config.js`
2. Find `THREEDBAG_CONFIG.heightOffset`
3. Adjust the value (more negative = buildings lower):
   ```javascript
   heightOffset: -50  // Try values between -48 and -52
   ```
4. Refresh your browser

### Fine-Tuning in Browser Console

You can adjust the offset in real-time using the browser console:

```javascript
// Import the function
import('./src/threeDBagLoader.js').then(module => {
    // Adjust offset (negative = down, positive = up)
    module.adjust3DBagHeightOffset(-50);  // Try -48, -49, -50, -51, -52
});
```

### Diagnostic Information

Check the current tileset status:

```javascript
import('./src/threeDBagLoader.js').then(module => {
    console.log(module.get3DBagDiagnostics());
});
```

This will show:
- Tileset center coordinates
- Current LoD level
- Bounding sphere information
- Whether modelMatrix is applied

## XY Coordinate Mismatch

### Understanding the Issue

3DBAG 3D Tiles use **WGS84** coordinates (same as Cesium), so XY coordinates should match. If they don't:

1. **Check if it's a visual perception issue**: Buildings might look offset due to:
   - Different building footprints (3DBAG vs OSM)
   - Different levels of detail
   - Terrain differences

2. **Verify actual coordinates**: Use the diagnostic function above to check the tileset center coordinates

3. **Compare with known landmarks**: Check if specific buildings align with known locations

### If XY Coordinates Are Actually Wrong

If XY coordinates are genuinely misaligned (not just visual), it could indicate:

1. **Tileset coordinate system issue**: The 3DBAG tileset might have a coordinate system problem (unlikely for 3D Tiles)
2. **Comparison data offset**: OSM or other reference data might have slight offsets
3. **Projection issue**: Though 3D Tiles should handle this automatically

**Note**: The `modelMatrix` translation we apply should **only affect Z (vertical)**, not X/Y (horizontal). If XY coordinates are wrong, it's likely an issue with the tileset itself or the comparison data.

## Recommended Height Offset Values

Based on location in Netherlands:

| Location | Approximate Offset |
|----------|-------------------|
| Amsterdam (Zuidas) | -49.5 to -50.5 meters |
| Rotterdam | -48 to -49 meters |
| The Hague | -49 to -50 meters |
| Utrecht | -49.5 to -50.5 meters |

**For Zuidas area**: Start with **-50 meters** and adjust ±1 meter as needed.

## Step-by-Step Alignment Process

1. **Initial Load**: Buildings load with default offset (-49.5m)

2. **Check Alignment**: 
   - Look at buildings near ground level
   - Check if building bases align with terrain
   - Note if buildings are too high or too low

3. **Adjust Offset**:
   - If buildings are **too high** (floating): Make offset more negative (e.g., -50, -51)
   - If buildings are **too low** (sinking): Make offset less negative (e.g., -49, -48)

4. **Fine-Tune**:
   - Use browser console to adjust in real-time
   - Test with `adjust3DBagHeightOffset(-50)`, `-51`, `-52`, etc.
   - Find the value that looks best

5. **Save Configuration**:
   - Once you find the right value, update `src/config.js`
   - Set `heightOffset: -50` (or your preferred value)

## Troubleshooting

### Buildings Still Floating

- **Try more negative values**: -51, -52, -53
- **Check terrain provider**: Make sure you're using `CesiumWorldTerrain`
- **Verify geoid model**: The offset varies slightly by location

### Buildings Sinking Into Ground

- **Try less negative values**: -48, -47, -46
- **Check if terrain is correct**: Terrain might be too high

### XY Coordinates Don't Match

1. **Verify it's actually wrong**: Use diagnostic function to check coordinates
2. **Compare with OSM**: OSM buildings might have slight offsets
3. **Check tileset metadata**: 3DBAG 3D Tiles should be in WGS84
4. **Report issue**: If genuinely wrong, it might be a 3DBAG tileset issue

### Performance Issues

- **Reduce LoD**: Use `lod12` instead of `lod22`
- **Increase maximumScreenSpaceError**: Try 32 or 64
- **Check network**: 3D Tiles require good internet connection

## Example: Finding the Right Offset

```javascript
// In browser console, try different values:

// Too high? Try more negative
import('./src/threeDBagLoader.js').then(m => m.adjust3DBagHeightOffset(-51));

// Too low? Try less negative  
import('./src/threeDBagLoader.js').then(m => m.adjust3DBagHeightOffset(-49));

// Just right? Save to config
// Update src/config.js: heightOffset: -50
```

## Current Configuration

Check your current settings in `src/config.js`:

```javascript
export const THREEDBAG_CONFIG = {
    enabled: true,
    lod: 'lod13',  // or 'lod12', 'lod22'
    heightOffset: null,  // null = auto (-49.5m), or specify like -50
    // ...
};
```

## Need Help?

If buildings are still not aligning correctly:

1. Check browser console for error messages
2. Use diagnostic function to see tileset information
3. Try different offset values systematically
4. Verify terrain is loading correctly
5. Check if issue is with specific buildings or all buildings




