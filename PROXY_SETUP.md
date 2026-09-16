# GTFS-Realtime Proxy Setup

The OVapi GTFS-realtime API doesn't allow direct browser access due to CORS restrictions. To use real-time data, you need to set up a proxy server.

## Option 1: Use the Included Proxy Server

1. **Start the proxy server** (in a separate terminal):
   ```bash
   node proxy-server.js
   ```

2. **Update `src/config.js`** to use the proxy:
   ```javascript
   export const GTFS_CONFIG = {
       vehiclePositionsEndpoint: 'http://localhost:3000/gtfs/vehiclePositions.pb',
       // ... other config
       useMockData: false
   };
   ```

3. **Restart your web server** and refresh the browser.

## Option 2: Use Mock Data (For Development)

If you don't want to set up a proxy, you can use mock data:

1. **Update `src/config.js`**:
   ```javascript
   export const GTFS_CONFIG = {
       // ... other config
       useMockData: true  // Use mock data instead
   };
   ```

## Option 3: Use a Public CORS Proxy (Not Recommended for Production)

You can use a public CORS proxy service, but this is not recommended for production:

```javascript
vehiclePositionsEndpoint: 'https://cors-anywhere.herokuapp.com/https://gtfs.ovapi.nl/nl/vehiclePositions.pb'
```

**Note**: Public CORS proxies are unreliable and may have rate limits.

## Option 4: Deploy Your Own Backend

For production, deploy the proxy server to a cloud service (Heroku, AWS, etc.) and update the endpoint URL accordingly.

## Current Status

The application is working! You have:
- ✅ Cesium 3D viewer loaded
- ✅ 2067 OSM buildings displayed
- ✅ Time controller initialized
- ⚠️ GTFS-realtime blocked by CORS (use one of the solutions above)

The visualization will work without GTFS data - you just won't see real-time vehicles until the proxy is set up.

