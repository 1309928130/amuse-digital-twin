/**
 * Configuration constants for the Zuidas 3D Visualization
 */

// Zuidas boundary coordinates (extracted from ZuidasBoundaryEPSG4326WGS84.geojson)
// These are the actual boundaries of the Zuidas area
export const ZUIDAS_BOUNDS = {
    north: 52.344503,    // Maximum latitude from boundary
    south: 52.332078,    // Minimum latitude from boundary
    east: 4.8924243,     // Maximum longitude from boundary
    west: 4.8571395      // Minimum longitude from boundary
};

// Center coordinates for Zuidas (calculated from boundary bounds)
export const ZUIDAS_CENTER = {
    longitude: (ZUIDAS_BOUNDS.east + ZUIDAS_BOUNDS.west) / 2,  // 4.8747819
    latitude: (ZUIDAS_BOUNDS.north + ZUIDAS_BOUNDS.south) / 2, // 52.3382905
    height: 1000
};

// GTFS-realtime API configuration
export const GTFS_CONFIG = {
    // OVapi GTFS-realtime endpoints (Netherlands public transport)
    baseUrl: 'https://gtfs.ovapi.nl/nl/',
    // Use proxy server to bypass CORS (run: node proxy-server.js)
    vehiclePositionsEndpoint: 'http://localhost:3000/gtfs/vehiclePositions.pb',
    // Direct endpoint (blocked by CORS): 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    tripUpdatesEndpoint: 'https://gtfs.ovapi.nl/nl/tripUpdates.pb',
    trainUpdatesEndpoint: 'https://gtfs.ovapi.nl/nl/trainUpdates.pb',
    // Static/historical data endpoints
    archiveBaseUrl: 'https://gtfs.ovapi.nl/nl/archive/',
    staticDataDir: './data/static-gtfs/', // Local directory for downloaded static data
    staticDataEndpoint: './data/static-gtfs/vehiclePositions.pb', // Local static vehicle positions file
    staticScheduleFile: './data/static-gtfs/gtfs-nl.zip', // Local static GTFS schedule data (routes, stops, schedules)
    useStaticScheduleData: false, // Disabled: schedule-based simulation is too heavy. Use static snapshots instead.
    // Alternative: use a mock data endpoint for development
    mockEndpoint: './data/mock-gtfs.json',
    updateInterval: 45000, // Slightly slower than before to reduce OVapi 429s (proxy also caches ~25s)
    useMockData: false, // Set to false to use real API
    // Filter vehicles to show only in Zuidas area (centered around Zuidas station)
    // Set to false to show all vehicles (may show many vehicles outside the area)
    filterByArea: true,
    // Expand area filter to show more vehicles (multiplier for bounding box)
    // The base bounds are centered around Zuidas station (52.33886029227803, 4.872844838304281)
    areaExpansionFactor: 2.0, // 1.0 = exact bounds, 2.0 = 2x larger area around Zuidas station
    // Vehicle types to show (bus, tram, train, etc.)
    vehicleTypes: ['bus', 'tram', 'train', 'metro'],
    // Historical mode: use static data instead of collected snapshots
    useStaticDataForHistorical: true,
    // Schedule-based simulation: enable to simulate vehicle positions from GTFS schedule data
    // Disable if you have SUMO or other simulation tools (will use snapshot files instead)
    enableScheduleSimulation: false, // Set to false to disable schedule simulation (uses snapshots only)
    // Route trail visualization
    showRouteTrails: true, // Show polylines connecting vehicle positions
    maxTrailPoints: 20, // Maximum number of positions to track per vehicle
    maxTrailAge: 600000, // Maximum age of trail points in milliseconds (10 minutes)
    trailWidth: 2, // Width of trail polylines
    trailOpacity: 0.6 // Opacity of trail polylines (0-1)
};

// Cesium Ion token (optional - for premium features)
export const CESIUM_CONFIG = {
    ionAccessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI3NDc4OWRiOC0xODEyLTRlNWMtOGFjYy1mOGQxMzUxNTBlNGUiLCJpZCI6MzY3MjA4LCJpYXQiOjE3NjUwMzY5MDh9.aL2ynDWMJ0hS7Tl7x3EYo62hXZV5oV-DNgFoljfrKy4', // Add your Cesium Ion access token if needed
    terrainProvider: 'CesiumWorldTerrain' // or 'Ellipsoid' for no terrain
};

// Time configuration for historical data
export const TIME_CONFIG = {
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
    endDate: new Date(), // Current date (will be updated to always include now)
    defaultDate: new Date() // Default time to show
};

// OSM configuration
export const OSM_CONFIG = {
    overpassEndpoint: 'https://overpass-api.de/api/interpreter',
    buildingQuery: `
        [out:json][timeout:25];
        (
          way["building"]({{bbox}});
          relation["building"]({{bbox}});
        );
        out body;
        >;
        out skel qt;
    `,
    minBuildingHeight: 3, // Minimum building height in meters
    defaultBuildingHeight: 10 // Default height if not specified in OSM
};

// Unreal Engine model configuration
export const UNREAL_CONFIG = {
    modelPath: './models/zuidasModelFromCADDMapper.glb', // Directory for glTF/GLB models
    supportedFormats: ['.gltf', '.glb'],
    defaultScale: 1.0,
    defaultOrientation: { heading: 0, pitch: 0, roll: 0 }
};

// SketchUp model configuration
export const SKETCHUP_CONFIG = {
    modelPath: './models/', // Directory for SketchUp exported glTF/GLB models
    supportedFormats: ['.gltf', '.glb'], // SketchUp can export to glTF/GLB
    defaultScale: 1.0,
    // Default orientation - adjust these values to fix rotation issues
    // Common fixes for SketchUp models:
    // - roll: -90 (Y-up to Z-up conversion, most common)
    // - heading: 90 or -90 (rotate compass direction)
    // - pitch: 180 (flip upside down)
    defaultOrientation: { 
        heading: 90,   // Rotation around Z-axis (0-360°) - compass direction
        pitch: 0,     // Rotation around Y-axis - nose up/down
        roll: 0     // Rotation around X-axis - tilt left/right (try -90 for SketchUp)
    },
    // Color configuration for SketchUp models
    // Options:
    // - null or undefined = use original model colors/textures
    // - Cesium.Color object = uniform color (e.g., Cesium.Color.WHITE)
    // - CSS color string = uniform color (e.g., '#FF5733', 'rgb(255, 87, 51)', 'blue')
    color: '#FF5733', // null = original colors, or CSS color string like '#FF5733' or '#ffffff' for white
    // Color blend amount (0.0 = full color override, 1.0 = original colors)
    // Use 0.3-0.5 to allow lighting to show through for different face brightness
    colorBlendAmount: 0.3, // 0.0 = replace color completely, 0.3-0.5 = allow lighting, 1.0 = original
    // Color blend mode
    // - HIGHLIGHT: blends with original color and preserves lighting (better for showing different faces)
    // - REPLACE: completely replaces original color (flat appearance, no lighting variation)
    colorBlendMode: 'HIGHLIGHT', // 'HIGHLIGHT' or 'REPLACE' - use HIGHLIGHT to show different face brightness
    // Opacity (0.0 = fully transparent, 1.0 = fully opaque)
    // Set to 1.0 to make all parts of the model fully opaque (no transparency)
    opacity: 1.0, // 1.0 = fully opaque, 0.5 = 50% transparent, etc.
    // Silhouette/outline settings for better geometry visibility
    // These are enhanced automatically in analysis mode (no shadows)
    silhouetteColor: Cesium.Color.BLUE, // Default silhouette color
    silhouetteSize: 2.0, // Default silhouette size (will be increased to 3.0 in analysis mode)
    // Analysis mode silhouette settings (applied automatically when switching to analysis mode)
    analysisSilhouetteColor: Cesium.Color.BLACK.withAlpha(0.8), // Darker, more visible in analysis mode
    analysisSilhouetteSize: 3.0 // Larger silhouette for better edge visibility without shadows
};

// Shadow configuration
export const SHADOW_CONFIG = {
    enabled: true,
    softShadows: true,
    shadowMapSize: 2048,
    maximumDistance: 10000
};

// 3DBAG configuration has been moved to src/threeDBagLoader.js
// Import THREEDBAG_CONFIG from './src/threeDBagLoader.js' instead
// This export is kept for backward compatibility but will be removed in the future
export { THREEDBAG_CONFIG } from './threeDBagLoader.js';

// Heatmap visualization configuration
export const HEATMAP_CONFIG = {
    enabled: false, // Set to true to show heatmap by default
    gridSize: 20, // Grid resolution (higher = more detail, lower = better performance)
    pointSize: 25, // Size of heatmap points in pixels (reduced slightly to avoid blocking)
    opacity: 0.6, // Opacity of heatmap (0-1, reduced to avoid blocking other elements)
    animate: false // Whether to animate the heatmap
};

// Wind visualization configuration
export const WIND_CONFIG = {
    enabled: false, // Set to true to show wind vectors by default
    gridSize: 10, // Grid resolution (higher = more vectors, lower = better performance)
    height: 10, // Height above ground in meters (reduced from 50 for better visibility)
    vectorLength: 3.0, // Length multiplier for vectors (increased for better visibility)
    vectorWidth: 4, // Width of vectors in pixels (increased for better visibility)
    showArrows: true, // Whether to show arrowheads
    animate: true // Whether to animate wind vectors
};

// Large model (Zuidas datamodel) configuration
export const LARGE_MODEL_CONFIG = {
    enabled: false, // Use "Zuidas Datamodel (GLB)" checkbox; set true to auto-load
    // Only the small Rhino export by default (do not fall back to 200MB+ legacy GLBs)
    modelPaths: [
        './models/export_for_visualization.glb',
    ],
    // Optional: add legacy paths here only if you explicitly want them
    legacyModelPaths: [
        './models/250808_Datamodel Zuidas_SortByEnshan_noTrees.glb',
        './models/250808_Datamodel Zuidas_SortByEnshan.glb',
        './models/250808_Datamodel Zuidas_SortByEnshan_final.glb',
    ],
    placementJson: './models/export_for_visualization_placement.json',
    // Rhino glTF export shrank RD meters by ~1000× (mm→m). Site ~350 m / GLB AABB ~0.3 m.
    scale: 1000.0,
    // 0 = follow map zoom in meters (do not keep a fixed on-screen size)
    minimumPixelSize: 0,
    maximumScale: 1e9,
    enableShadows: false,
    showLoadingIndicator: true,
    allowPicking: false,
    heightReference: 'NONE',
    // Cesium heading: +90° = 90° clockwise from above (fixes a 90° CCW Rhino/glTF mismatch)
    orientation: { heading: 90, pitch: 0, roll: 0 },
    color: null
};

// SUMO simulation data visualization configuration
export const SUMO_CONFIG = {
    // Base path to SUMO data directory
    dataPath: './SUMOdataZuidasPartial2025-12-01-15-37-36',
    // FCD (Floating Car Data) support:
    // If fcd-output.xml exists in the dataPath directory, it will be automatically loaded
    // FCD provides exact vehicle positions at each simulation timestep (more accurate than route interpolation)
    // To generate FCD output from SUMO, add to your sumo config:
    //   <output>
    //       <fcd-output value="fcd-output.xml"/>
    //       <fcd-output.geo value="true"/>  <!-- Use geo coordinates -->
    //   </output>
    // Or run: sumo -c config.sumocfg --fcd-output fcd-output.xml
    // Visualization options
    showRoadNetwork: true, // Show road network edges as polylines
    showStops: true, // Show public transport stops
    showRoutes: false, // Show vehicle routes as polylines (optional)
    showVehicleLabels: false, // Show vehicle ID labels
    showStopLabels: true, // Show stop name labels
    // Performance limits
    maxRoadNetworkEdges: 10000, // Maximum number of road edges to visualize
    maxVehicles: 200, // Maximum number of vehicles to display simultaneously
    maxRoutes: 100, // Maximum number of routes to visualize (if enabled)
    // Visual styling
    roadWidth: 2, // Width of road polylines
    vehicleSize: 10, // Size of vehicle points
    stopSize: 5 // Size of stop points (smaller, gray color)
};

