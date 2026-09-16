# PedModel Cesium visualization

Copied from `C:\\Users\\enshanchen\\git\\3dvisualization_zuidas` into PedModel.

- `data/` and `models/` are symlinks to the original repo (large assets).
- Ali's Dash `webapp.py` is archived at `../archive/ali_webapp/`.
- Grasshopper heat export: `simulation_data/simulation_results_heat*.csv`
- PedMac network flow + demand (for Cesium toggles): refresh with
  `python ../tools/export_cesium_pedflow.py`
  → `simulation_data/network_flow_edges.json`, `pedestrian_demand.json`

Run:
```bash
unset LD_LIBRARY_PATH
cd visualization
npm start
# open http://localhost:8080
```

Visualizations panel: **Urban Heat**, **Network Flow** (click a link for hourly ped/h), **Pedestrian Demand**, wind, transit routes.
3D Models panel: **Zuidas Datamodel (GLB)** loads existing files under `models/` (often ~200–250MB). Export a smaller visible-only GLB from Rhino if you want a lighter model.
