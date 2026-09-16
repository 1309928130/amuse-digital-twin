#!/usr/bin/env python3
"""
Analyze glTF/GLB model structure to identify complexity issues
Helps diagnose why a model causes stack overflow errors
"""

import json
import sys
import struct
from pathlib import Path

def read_glb(filepath):
    """Read a GLB file and extract the JSON chunk"""
    with open(filepath, 'rb') as f:
        # GLB header: magic (4 bytes) + version (4 bytes) + length (4 bytes)
        magic = f.read(4)
        if magic != b'glTF':
            raise ValueError("Not a valid GLB file")
        
        version = struct.unpack('<I', f.read(4))[0]
        length = struct.unpack('<I', f.read(4))[0]
        
        # JSON chunk header
        json_length = struct.unpack('<I', f.read(4))[0]
        json_type = f.read(4)  # Should be b'JSON'
        
        # Read JSON chunk
        json_data = f.read(json_length).decode('utf-8')
        gltf = json.loads(json_data)
        
        return gltf, version, length

def analyze_structure(gltf):
    """Analyze the glTF structure for complexity"""
    stats = {
        'nodes': len(gltf.get('nodes', [])),
        'meshes': len(gltf.get('meshes', [])),
        'materials': len(gltf.get('materials', [])),
        'textures': len(gltf.get('textures', [])),
        'images': len(gltf.get('images', [])),
        'accessors': len(gltf.get('accessors', [])),
        'bufferViews': len(gltf.get('bufferViews', [])),
        'max_depth': 0,
        'deep_nodes': []
    }
    
    # Analyze node hierarchy depth
    nodes = gltf.get('nodes', [])
    scenes = gltf.get('scenes', [])
    
    def get_node_depth(node_index, visited=None, depth=0):
        """Recursively calculate node depth"""
        if visited is None:
            visited = set()
        
        if node_index in visited:
            return depth  # Circular reference
        
        if node_index >= len(nodes):
            return depth
        
        visited.add(node_index)
        node = nodes[node_index]
        children = node.get('children', [])
        
        if not children:
            return depth
        
        max_child_depth = depth
        for child_index in children:
            child_depth = get_node_depth(child_index, visited.copy(), depth + 1)
            max_child_depth = max(max_child_depth, child_depth)
        
        return max_child_depth
    
    # Find maximum depth
    for scene in scenes:
        for root_node_index in scene.get('nodes', []):
            depth = get_node_depth(root_node_index)
            stats['max_depth'] = max(stats['max_depth'], depth)
            if depth > 20:  # Flag deep nodes
                stats['deep_nodes'].append({
                    'index': root_node_index,
                    'depth': depth
                })
    
    # Count mesh primitives
    total_primitives = 0
    for mesh in gltf.get('meshes', []):
        total_primitives += len(mesh.get('primitives', []))
    stats['total_primitives'] = total_primitives
    
    return stats

def print_report(filepath, stats, file_size_mb):
    """Print analysis report"""
    print("=" * 60)
    print(f"glTF Structure Analysis: {Path(filepath).name}")
    print("=" * 60)
    print(f"File size: {file_size_mb:.2f} MB")
    print()
    print("Structure Statistics:")
    print(f"  Nodes: {stats['nodes']:,}")
    print(f"  Meshes: {stats['meshes']:,}")
    print(f"  Mesh Primitives: {stats['total_primitives']:,}")
    print(f"  Materials: {stats['materials']:,}")
    print(f"  Textures: {stats['textures']:,}")
    print(f"  Images: {stats['images']:,}")
    print(f"  Accessors: {stats['accessors']:,}")
    print(f"  Buffer Views: {stats['bufferViews']:,}")
    print()
    print(f"Node Hierarchy:")
    print(f"  Maximum Depth: {stats['max_depth']}")
    
    # Warnings
    warnings = []
    if stats['max_depth'] > 30:
        warnings.append(f"⚠️  VERY DEEP hierarchy ({stats['max_depth']} levels) - likely to cause stack overflow!")
    elif stats['max_depth'] > 20:
        warnings.append(f"⚠️  Deep hierarchy ({stats['max_depth']} levels) - may cause issues")
    
    if stats['nodes'] > 10000:
        warnings.append(f"⚠️  Very many nodes ({stats['nodes']:,}) - may cause performance issues")
    
    if stats['total_primitives'] > 5000:
        warnings.append(f"⚠️  Many mesh primitives ({stats['total_primitives']:,}) - may cause performance issues")
    
    if file_size_mb > 200:
        warnings.append(f"⚠️  Large file size ({file_size_mb:.2f} MB) - may cause memory issues")
    
    if warnings:
        print()
        print("Warnings:")
        for warning in warnings:
            print(f"  {warning}")
    else:
        print()
        print("✓ Structure looks reasonable")
    
    if stats['deep_nodes']:
        print()
        print(f"Deep Nodes (depth > 20): {len(stats['deep_nodes'])}")
        for node_info in stats['deep_nodes'][:10]:  # Show first 10
            print(f"  Node {node_info['index']}: depth {node_info['depth']}")
    
    print()
    print("Recommendations:")
    if stats['max_depth'] > 20:
        print("  1. Flatten the node hierarchy in Blender/SketchUp")
        print("  2. Split the model into multiple parts")
        print("  3. Reduce nested groups/components")
    if stats['nodes'] > 5000:
        print("  4. Consider splitting into multiple models")
    if file_size_mb > 100:
        print("  5. Optimize textures and geometry")
        print("  6. Consider using 3D Tiles format for very large models")
    
    print("=" * 60)

def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze_gltf_structure.py <path-to-glb-file>")
        sys.exit(1)
    
    filepath = sys.argv[1]
    
    if not Path(filepath).exists():
        print(f"Error: File not found: {filepath}")
        sys.exit(1)
    
    file_size_mb = Path(filepath).stat().st_size / (1024 * 1024)
    
    try:
        print(f"Reading GLB file: {filepath}")
        gltf, version, length = read_glb(filepath)
        print(f"glTF version: {version}")
        print()
        
        stats = analyze_structure(gltf)
        print_report(filepath, stats, file_size_mb)
        
    except Exception as e:
        print(f"Error analyzing file: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()

