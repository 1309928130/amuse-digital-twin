# AMUSE Digital Twin — Zuidas visualization

**Live viewer: [digital-twin-zuidas.web.app](https://digital-twin-zuidas.web.app/)**

A federated 3D digital twin of the Zuidas area in Amsterdam, built on Cesium. It
brings several environmental simulations into one viewer so they can be read
together rather than in isolation: macroscopic and microscopic pedestrian flow,
sunlight, wind, urban heat, pollution, and visibility.

This is the viewer component of the **AMUSE** framework. See the
**[framework documentation](framework/README.md)**, which is also readable inside
the app on the *The framework* page.

## Pages

The app is organised as a set of assessment pages, switched from the top
navigation bar. Each page owns a camera preset, a set of visible layers, and its
own right-hand parameter panel.

| Page | What it shows |
| --- | --- |
| Pedestrian flow | Macroscopic network flow and pedestrian demand over the wider Zuidas area |
| Micro-mobility | Microscopic (SUMO) simulation around the station square |
| Sunlight | Baked Ladybug false-colour sunlight hours on the site block |
| Wind | CFD wind field from Eddy3D/OpenFOAM probes |
| Noise | Traffic noise (placeholder) |
| Pollution | Passive-scalar pollutant concentration, carried by the wind field |
| Urban heat | Surface temperature field |
| Visibility | Visual quality and designer judgment (placeholder) |
| Multi-layer overlap | Two or more fields read together |
| Case studies | Proposal comparisons (placeholder) |
| The framework | The written framework, rendered from Markdown in place of the globe |

Cameras interpolate between pages, so moving from an area-wide assessment to a
site-block one reads as a zoom and a move rather than a cut.

## Setup

Requires Node.js and a WebGL-capable browser.

```bash
npm install
npm start          # serves on http://localhost:8080
```

On WSL, clear the injected library path first, or the bundled Cesium build fails
to load:

```bash
unset LD_LIBRARY_PATH
npm start
```

### Data and models

The repository ships the code plus the simulation outputs needed to render the
default view. Two categories of large asset are **not** included and are
regenerated locally:

```bash
npm run download-static      # GTFS feeds  -> data/static-gtfs/   (~3.3 GB)
npm run download-osm         # OSM buildings -> data/osm/
```

The 237–268 MB legacy Zuidas GLBs are also excluded, because they exceed
GitHub's 100 MB per-file limit. The app does not load them: `LARGE_MODEL_CONFIG`
in `src/config.js` pins `modelPaths` to the small
`models/export_for_visualization.glb`. Drop the heavy files into `models/`
yourself if you need them.

## Documentation sync

The *The framework* page renders `framework/README.md`. That file is a **copy**
of the source document, kept in step by a script:

```bash
npm run sync-docs     # copy README + referenced figures into framework/
npm run check-docs    # exit 1 if the copy has drifted
```

`check-docs` runs automatically before a Firebase deploy, so a stale copy fails
the deploy instead of silently shipping outdated content. Only assets the
Markdown actually references are copied; files removed from the document are
pruned from `framework/figures/`.

## Project structure

```
index.html                  Markup, styles, and the top navigation shell
main.js                     Entry point; wires modules together
src/
  config.js                 Endpoints, area bounds, model paths
  pageConfig.js             Page registry: labels, cameras, layers, panel sections
  pageController.js         Camera transitions, layer toggling, panel orchestration
  cesiumViewer.js           Viewer setup and base camera
  docView.js                Markdown document view (marked.js)
  pedFlowVisualization.js   Pedestrian flow and demand
  cfdVisualization.js       Wind arrows and pollutant points
  sunlightVisualization.js  Baked sunlight mesh
  heatmapVisualization.js   Urban heat field
  largeModelLoader.js       Zuidas datamodel loading
  vendor/marked.esm.js      Vendored Markdown parser
tools/
  build-cfd-data.mjs        Eddy3D/OpenFOAM probes -> viewer JSON
  sync-framework-doc.mjs    Keeps framework/ in step with the source doc
simulation_data/            Simulation outputs consumed at runtime
framework/                  Generated copy of the framework documentation
models/                     Small GLBs loaded by the viewer
```

### Simulation data pipeline

CFD outputs arrive as Eddy3D/OpenFOAM probe dumps in projected metres and are
converted to the viewer's WGS84 JSON by `tools/build-cfd-data.mjs`. Wind speeds
above 15 m/s are treated as solver divergence rather than real wind: they are
flagged `suspect`, excluded from the default view, and the legend states the
data is provisional.

## Deployment

```bash
npx firebase deploy --only hosting
```

Firebase serves `visualization/firebase-deploy`, which is a build output and is
git-ignored. Regenerate it from the app before deploying.

## License

MIT
