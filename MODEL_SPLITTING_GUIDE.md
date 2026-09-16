# Model Splitting Guide - Fixing Stack Overflow

## Problem
Your model (`250808_Datamodel Zuidas_SortByEnshan.glb`, 254MB) causes a **"Maximum call stack size exceeded"** error because the node hierarchy is too deep/complex for Cesium to parse.

## Solution: Split the Model

The model needs to be split into smaller parts. Here are several approaches:

## Option 1: Split Using Blender (Recommended)

### Step 1: Install Blender
- Download from: https://www.blender.org/download/
- Free and open-source

### Step 2: Import Your Model
1. Open Blender
2. File → Import → glTF 2.0 (.glb/.gltf)
3. Select your `250808_Datamodel Zuidas_SortByEnshan.glb` file
4. Wait for import (may take a few minutes for 254MB)

### Step 3: Analyze the Structure
1. In the Outliner (top-right), check the hierarchy
2. Look for deeply nested groups or objects
3. Note how many objects/nodes there are

### Step 4: Split by Region/Building
**Method A: Manual Selection**
1. Select objects in one region (e.g., buildings in the north)
2. File → Export → glTF 2.0
3. Check "Selected Objects Only"
4. Export as `zuidas_part1.glb`
5. Repeat for other regions

**Method B: Use Collections**
1. Create new Collections (right-click in Outliner → New Collection)
2. Name them: `Part1`, `Part2`, `Part3`, etc.
3. Move objects into collections by region
4. Export each collection separately

### Step 5: Simplify While Splitting
- **Decimate Modifier**: Add to reduce polygon count
  - Select object → Modifier Properties → Add Modifier → Decimate
  - Ratio: 0.5 (reduces to 50% of polygons)
- **Remove Unnecessary Details**: Delete small objects that won't be visible
- **Merge Nearby Objects**: Combine small objects to reduce node count

## Option 2: Split Using Python Script

I'll create a Python script to help analyze and potentially split the model programmatically.

## Option 3: Simplify in Source Software (SketchUp)

If the model came from SketchUp:

1. **Open in SketchUp**
2. **Simplify Groups/Components**:
   - Right-click groups → Explode (if safe)
   - Reduce nested groups
   - Flatten hierarchy where possible
3. **Reduce Detail**:
   - Use "Simplify Contours" for curves
   - Remove hidden geometry
   - Delete unnecessary layers
4. **Export in Parts**:
   - Hide parts you don't need
   - Export visible parts separately
   - Repeat for different regions

## Option 4: Convert to 3D Tiles (Advanced)

For very large models, 3D Tiles is the best solution:

1. **Install 3D Tiles Tools**:
   ```bash
   npm install -g 3d-tiles-tools
   ```

2. **Convert glTF to 3D Tiles**:
   ```bash
   gltf-to-3dtiles -i "models/250808_Datamodel Zuidas_SortByEnshan.glb" -o "models/zuidas-tiles"
   ```

3. **Load in Cesium**:
   ```javascript
   const tileset = viewer.scene.primitives.add(
       new Cesium.Cesium3DTileset({
           url: './models/zuidas-tiles/tileset.json'
       })
   );
   ```

## Recommended Approach

**For your 254MB model, I recommend:**

1. **Start with Blender** (Option 1)
   - Split into 4-8 parts by geographic region
   - Each part should be < 50MB
   - Simplify each part (decimate to 50-70% polygons)

2. **Load Multiple Models**:
   ```javascript
   // Load all parts
   await loadLargeModel('./models/zuidas_part1.glb', position1, options);
   await loadLargeModel('./models/zuidas_part2.glb', position2, options);
   // etc.
   ```

3. **If still too complex**: Convert to 3D Tiles (Option 4)

## Quick Test: Try Original Model in Blender

Before splitting, try:
1. Import original model in Blender
2. Select All (A)
3. Apply "Decimate" modifier with Ratio: 0.3
4. Export as new GLB
5. Test if this simplified version loads

This might be enough to fix the stack overflow!

