"""Rasterise the favicon geometry from build-favicon.mjs into PNG sizes.

Kept separate from the SVG generator because rasterising needs a drawing
library. Pillow is used rather than a Node image package so this stays inside the
tooling the repo already relies on for the snapshot work, with no new npm
dependency.

Run: python3 tools/build-favicon-png.py
"""

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE.parent

# Pull the geometry and palette from the Node generator so the two never drift.
GEO = json.loads(
    subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import('./tools/build-favicon.mjs').then(m => console.log(JSON.stringify({"
            "design: m.DESIGN, layers: m.LAYERS, tile: m.TILE})))",
        ],
        cwd=OUT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
)

DESIGN = GEO["design"]
LAYERS = GEO["layers"]
TILE = GEO["tile"]

# Supersample, then downscale: gives clean edges on the small tab sizes without
# needing a real vector rasteriser.
SS = 4


def rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def slab(draw, cx, cy, half_w, half_h, depth, top_color, side_color, s):
    """Draw one isometric slab, sides then top face, in supersampled units."""
    tp = [
        (cx, cy - half_h),
        (cx + half_w, cy),
        (cx, cy + half_h),
        (cx - half_w, cy),
    ]
    bt = [(x, y + depth) for (x, y) in tp]

    draw.polygon([bt[0], bt[1], tp[1], tp[0]], fill=rgb(side_color))
    draw.polygon([bt[3], bt[2], tp[2], tp[3]], fill=rgb(side_color))
    draw.polygon(tp, fill=rgb(top_color))


def render(size):
    s = SS
    px = size * s
    # Work in the 512 design space, scaled to the requested pixel size.
    k = px / 512.0
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = 112 * k
    draw.rounded_rectangle([0, 0, px - 1, px - 1], radius=radius, fill=rgb(TILE))

    for i, layer in enumerate(LAYERS):
        slab(
            draw,
            DESIGN["cx"] * k,
            DESIGN["baselines"][i] * k,
            DESIGN["halfW"] * k,
            DESIGN["halfH"] * k,
            DESIGN["depth"] * k,
            layer["top"],
            layer["side"],
            s,
        )

    return img.resize((size, size), Image.LANCZOS)


TARGETS = {
    "favicon-32.png": 32,
    "favicon-192.png": 192,
    "favicon-512.png": 512,
    "apple-touch-icon.png": 180,
}

for name, size in TARGETS.items():
    out = OUT / name
    render(size).save(out, "PNG", optimize=True)
    print(f"wrote {name} ({size}x{size}, {out.stat().st_size} bytes)")

# Preview strip so the mark can be eyeballed at the sizes it is actually seen at.
preview_h = 160
strip = Image.new("RGBA", (16 + sum([64, 32, 180, 192]) + 3 * 24 + 16, preview_h), (245, 246, 248, 255))
x = 16
for size in (64, 32, 180, 192):
    icon = render(size)
    strip.paste(icon, (x, (preview_h - size) // 2), icon)
    x += size + 24
strip.save("/tmp/favicon_preview.png")
print("wrote /tmp/favicon_preview.png")
