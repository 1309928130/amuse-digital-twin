/**
 * GTFS Data Coordinator - Re-exports from static and dynamic digital twins
 * This file maintains backward compatibility while the codebase is split
 * 
 * @deprecated Use gtfsRealtime.js or gtfsStatic.js directly
 */

// Re-export from dynamic digital twin (real-time)
export { 
    startGTFSUpdates, 
    stopGTFSUpdates, 
    getHistoricalData, 
    getHistoricalDataRange 
} from './gtfsRealtime.js';
        
// Re-export from static digital twin
export { 
    showHistoricalData,
    simulateVehiclePositions,
    loadStaticGTFSData
} from './gtfsStatic.js';
