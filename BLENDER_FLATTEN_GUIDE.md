# How to Flatten Model Structure in Blender

## Why Flatten?

Your model has a **deep nested hierarchy** (too many nested groups/components) causing "Maximum call stack size exceeded" errors. Flattening reduces the nesting depth, making it loadable in Cesium.

## Step-by-Step Guide

### Step 1: Import Your Model

1. Open Blender (download from https://www.blender.org/ if needed)
2. **File → Import → glTF 2.0 (.glb/.gltf)**
3. Select your `250808_Datamodel Zuidas_SortByEnshan_noTrees.glb` file
4. Wait for import (may take a few minutes for large models)

### Step 2: Check the Current Structure

1. Look at the **Outliner** panel (top-right corner)
2. You'll see a tree structure with nested objects/groups
3. Count how many levels deep it goes (this is what's causing the problem)

### Step 3: Flatten the Hierarchy

#### Method A: Join All Objects (Simplest - Recommended)

**⚠️ Warning**: This merges all objects into one. Good for fixing stack overflow, but you lose individual object names.

1. **Select All**: Press `A` (selects everything)
2. **Join Objects**: Press `Ctrl + J` (or `Cmd + J` on Mac)
3. All objects are now merged into one object
4. Hierarchy is now flat (just one object)

**Result**: Single object, no nesting = no stack overflow!

#### Method B: Flatten Collections (Preserves Some Organization)

If you want to keep some organization but reduce depth:

1. In the **Outliner**, expand all collections/groups
2. **Select All**: Press `A`
3. **Right-click** → **Unlink Collection** (removes from collections)
4. Create a **new single collection**: Click `+` in Outliner → "Collection"
5. **Select All**: Press `A`
6. **Move to new collection**: Drag selected objects to the new collection
7. Delete empty collections

**Result**: All objects in one flat collection

#### Method C: Manual Flattening (Most Control)

1. In **Outliner**, expand all nested groups
2. **Select All**: Press `A`
3. **Right-click** → **Unparent** (or press `Alt + P` → "Clear and Keep Transformation")
4. This removes parent-child relationships
5. All objects are now at the root level

**Result**: All objects at root level, no parent-child relationships

### Step 4: Simplify Further (Optional but Recommended)

#### Reduce Polygon Count

1. **Select All**: Press `A`
2. Go to **Modifier Properties** (wrench icon in right panel)
3. Click **Add Modifier** → **Decimate**
4. Set **Ratio**: `0.5` (reduces to 50% of polygons)
   - Lower = more reduction (try 0.3 for 30%)
   - Higher = less reduction (0.7 for 70%)
5. Click **Apply** (down arrow next to modifier name)

**Note**: This reduces file size and complexity, which helps with loading.

#### Remove Unnecessary Objects

1. In **Outliner**, look for:
   - Very small objects (won't be visible anyway)
   - Duplicate objects
   - Hidden/invisible objects
2. **Select** them and press `X` → **Delete**

### Step 5: Export as GLB

1. **File → Export → glTF 2.0 (.glb/.gltf)**
2. In export settings:
   - **Format**: GLB (binary)
   - **Include**: 
     - ✅ Selected Objects (if you want only selected)
     - ✅ Visible Objects (if you want only visible)
     - Or leave unchecked to export everything
   - **Transform**: 
     - ✅ +Y Up (if needed)
   - **Geometry**:
     - ✅ Apply Modifiers (applies decimate if you used it)
     - ✅ UVs, Normals, Vertex Colors (keep checked)
   - **Compression**: 
     - Leave unchecked (we'll optimize later if needed)
3. Click **Export glTF 2.0**
4. Save as: `zuidas_flattened.glb`

### Step 6: Test in Cesium

1. Place the new file in your `models/` folder
2. Update your code to load it:
   ```javascript
   await loadLargeModel('./models/zuidas_flattened.glb', position, options);
   ```
3. Refresh browser and test

## Quick Reference: Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|---------------|-----|
| Select All | `A` | `A` |
| Join Objects | `Ctrl + J` | `Cmd + J` |
| Unparent | `Alt + P` | `Option + P` |
| Delete | `X` | `X` |
| Deselect All | `Alt + A` | `Option + A` |

## Troubleshooting

### "Blender crashes when importing"
- Model is too large for Blender's memory
- Try importing in parts, or increase Blender's memory limit
- Or use a different approach (split first, then flatten)

### "Export is very slow"
- Large models take time
- Be patient, or simplify more (decimate with lower ratio)

### "Model looks different after flattening"
- Materials/textures might need reassignment
- Check if textures are embedded in GLB
- Re-export with "Copy" option for textures

### "Still getting stack overflow"
- Model might still be too complex
- Try more aggressive decimation (ratio: 0.2-0.3)
- Or split into multiple parts first, then flatten each part

## Recommended Workflow

**For your 254MB model:**

1. **Import** → `250808_Datamodel Zuidas_SortByEnshan_noTrees.glb`
2. **Select All** (`A`)
3. **Join** (`Ctrl + J`) - This flattens everything
4. **Add Decimate modifier** (Ratio: 0.5)
5. **Apply modifier**
6. **Export** → `zuidas_flattened.glb`
7. **Test** in Cesium

This should reduce both complexity AND file size significantly!

## Alternative: Split Then Flatten

If the model is too large for Blender:

1. **Split first** (see `MODEL_SPLITTING_GUIDE.md`)
2. **Flatten each part** separately
3. **Export each part** as separate GLB files
4. **Load all parts** in Cesium

This approach is safer for very large models.

