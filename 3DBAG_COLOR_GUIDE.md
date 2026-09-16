# How to Change 3DBAG Building Colors

## Quick Start

### Method 1: Configuration File (Recommended)

Edit `src/config.js` and set the `buildingColor`:

```javascript
export const THREEDBAG_CONFIG = {
    // ... other settings ...
    buildingColor: '#CCCCCC',  // Light gray
    // or
    buildingColor: 'rgb(200, 200, 200)',  // RGB format
    // or
    buildingColor: 'lightblue',  // CSS color name
};
```

Then refresh your browser.

### Method 2: Browser Console (Real-time)

Open browser console and run:

```javascript
// Import the function
import('./src/threeDBagLoader.js').then(module => {
    // Set color (CSS color string or Cesium.Color)
    module.set3DBagColor('#FF5733');  // Orange
    // or
    module.set3DBagColor('blue');
    // or
    module.set3DBagColor(Cesium.Color.CYAN);
});
```

## Color Format Options

### 1. CSS Color Strings

```javascript
buildingColor: '#FF5733'           // Hex color
buildingColor: 'rgb(255, 87, 51)'  // RGB
buildingColor: 'rgba(255, 87, 51, 0.8)'  // RGBA with transparency
buildingColor: 'lightblue'         // CSS color name
buildingColor: 'hsl(9, 100%, 60%)' // HSL
```

### 2. Cesium.Color Objects

```javascript
buildingColor: Cesium.Color.WHITE
buildingColor: Cesium.Color.LIGHTGRAY
buildingColor: Cesium.Color.fromCssColorString('#FF5733')
buildingColor: new Cesium.Color(0.9, 0.9, 0.9, 1.0)  // RGBA (0-1 range)
```

### 3. Color Object

```javascript
buildingColor: { r: 0.9, g: 0.9, b: 0.9, a: 1.0 }  // RGBA (0-1 range)
```

## Color Blending

You can blend the new color with the original building colors:

```javascript
export const THREEDBAG_CONFIG = {
    buildingColor: '#CCCCCC',
    colorBlendAmount: 0.5  // 0.0 = full color, 0.5 = 50% blend, 1.0 = original
};
```

- `0.0` = Completely replace with new color
- `0.5` = 50% new color, 50% original
- `1.0` = Keep original colors

## Common Color Examples

### Neutral Colors

```javascript
buildingColor: '#CCCCCC'  // Light gray
buildingColor: '#E0E0E0'  // Very light gray
buildingColor: '#999999'  // Medium gray
buildingColor: '#666666'  // Dark gray
buildingColor: '#FFFFFF'  // White
```

### Warm Colors

```javascript
buildingColor: '#FFE5CC'  // Light beige
buildingColor: '#FFCC99'  // Peach
buildingColor: '#FFB366'  // Light orange
buildingColor: '#FF8C42'  // Orange
```

### Cool Colors

```javascript
buildingColor: '#CCE5FF'  // Light blue
buildingColor: '#99CCFF'  // Sky blue
buildingColor: '#66B3FF'  // Blue
buildingColor: '#E0F0FF'  // Very light blue
```

### Earth Tones

```javascript
buildingColor: '#D4C4A8'  // Sand
buildingColor: '#C9A961'  // Tan
buildingColor: '#8B7355'  // Brown
buildingColor: '#A0826D'  // Taupe
```

## Reset to Original Colors

To restore original building colors:

### In Browser Console:

```javascript
import('./src/threeDBagLoader.js').then(module => {
    module.reset3DBagColor();
});
```

### In Config:

```javascript
buildingColor: null  // null = use original colors
```

## Advanced: Custom Styles

For more advanced styling, you can use Cesium 3D Tile Style expressions:

```javascript
// In browser console
import('./src/threeDBagLoader.js').then(module => {
    const tileset = module.is3DBagLoaded();
    if (tileset) {
        // Get the tileset (you'll need to access it differently)
        // Or use the load3DBagTiles function with colorStyle option
    }
});
```

Or when loading:

```javascript
await load3DBagTiles('lod13', {
    colorStyle: {
        color: 'vec4(0.9, 0.9, 0.9, 1.0)'  // Custom style expression
    }
});
```

## Examples

### Example 1: Light Gray Buildings

```javascript
// In src/config.js
export const THREEDBAG_CONFIG = {
    enabled: true,
    lod: 'lod13',
    buildingColor: '#CCCCCC',  // Light gray
    colorBlendAmount: 0.0
};
```

### Example 2: White Buildings with 20% Original Color

```javascript
export const THREEDBAG_CONFIG = {
    enabled: true,
    lod: 'lod13',
    buildingColor: '#FFFFFF',  // White
    colorBlendAmount: 0.2  // Keep 20% of original color
};
```

### Example 3: Blue Buildings (Browser Console)

```javascript
import('./src/threeDBagLoader.js').then(module => {
    module.set3DBagColor('lightblue');
});
```

### Example 4: Reset to Original

```javascript
import('./src/threeDBagLoader.js').then(module => {
    module.reset3DBagColor();
});
```

## Tips

1. **Start with light colors**: Dark colors can make buildings hard to see
2. **Use blending**: `colorBlendAmount: 0.3` keeps some original texture detail
3. **Test in browser console**: Use `set3DBagColor()` to test colors in real-time
4. **Consider shadows**: Light colors show shadows better
5. **Match your theme**: Choose colors that match your visualization style

## Current Configuration

Check your current color settings in `src/config.js`:

```javascript
export const THREEDBAG_CONFIG = {
    buildingColor: null,  // null = original colors
    colorBlendAmount: 0.0
};
```

## Troubleshooting

### Colors not changing?

1. **Check if tileset is loaded**: Use `get3DBagDiagnostics()` in console
2. **Verify color format**: Use valid CSS color strings or Cesium.Color
3. **Check console for errors**: Look for color parsing errors
4. **Refresh browser**: After changing config, refresh the page

### Colors look wrong?

1. **Try different color formats**: Some formats parse differently
2. **Adjust blend amount**: Use `colorBlendAmount: 0.3` to keep some original
3. **Check LoD level**: LoD2.2 has textures that might affect color appearance

### Want original colors back?

```javascript
// In config
buildingColor: null

// Or in console
import('./src/threeDBagLoader.js').then(m => m.reset3DBagColor());
```




