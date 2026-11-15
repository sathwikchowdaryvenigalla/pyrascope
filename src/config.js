// Single place for frontend configuration.
// VITE_API_BASE_URL is the ONLY backend address used by the app (see .env.example).
const raw = import.meta.env?.VITE_API_BASE_URL;
export const API_BASE_URL = (raw === undefined ? 'http://localhost:8000' : String(raw)).replace(/\/+$/, '');

// Client-side mirrors of the backend's DEFAULT limits (backend/config.py). They only give early feedback;
// the backend stays authoritative and its error message is always shown if it rejects a query.
export const LIMITS = {
  maxDays: 31,
  maxBboxDegrees: 10,
  maxDetails: 2000,          // max observations / pairs the compare endpoint will list per request
  requestTimeoutMs: 240000,  // Earth Engine retrievals can take a while
  clientCacheTtlMs: 10 * 60 * 1000, // same as the backend harmonization cache TTL
};

// Matching thresholds sent to the backend (its defaults). Candidate pairs are POTENTIAL relationships only.
export const MATCH_PARAMS = { spatial_threshold_km: 1, temporal_threshold_minutes: 30, date_tolerance_days: 0 };

// Nominal pixel sizes of the datasets (documented dataset resolution, used only to size globe markers).
export const NOMINAL_PIXEL_KM = { MODIS: 1, VIIRS: 0.375 };

// Region presets are just bounding boxes (no data). Every side must be <= LIMITS.maxBboxDegrees.
export const REGIONS = [
  { id: 'central-india', name: 'Central India', bbox: [76, 21, 80, 25] },
  { id: 'andhra-coast', name: 'Andhra Pradesh coast, India', bbox: [81, 16, 85, 20] },
  { id: 'punjab', name: 'Punjab / Haryana, India', bbox: [74, 29, 78, 32] },
  { id: 'n-thailand', name: 'Northern Thailand', bbox: [98, 17, 102, 21] },
  { id: 'mato-grosso', name: 'Mato Grosso, Brazil', bbox: [-58, -15, -54, -11] },
  { id: 'california', name: 'Central California, USA', bbox: [-122, 34, -118, 38] },
  { id: 'custom', name: 'Custom bounding box', bbox: null },
];

// --- Geographic exploration -------------------------------------------------------------------------------------
// Place search (autocomplete) uses the Photon geocoder (OpenStreetMap data, built for type-ahead): no API key.
// Public instance is fair-use only; set VITE_GEOCODER_URL to your own Photon (or compatible) endpoint for production.
export const GEOCODER_URL = (import.meta.env?.VITE_GEOCODER_URL || 'https://photon.komoot.io/api').replace(/\/+$/, '');
// A globe click selects a square window of this many degrees around the point (must be <= LIMITS.maxBboxDegrees).
export const POINT_BOX_DEG = 4;
// A city / point-type search result with no extent gets a window this many degrees wide.
export const PLACE_BOX_DEG = 1;

// Close-up imagery used ONLY beyond NASA GIBS' native resolution (Blue Marble stops at ~600 m/pixel, zoom level 8).
// Sources are tried in order; if one cannot be loaded (blocked, offline, no CORS) the next is used.
//   1. Esri World Imagery  - no key; free for development / non-commercial use with attribution (check terms for production)
//   2. EOX Sentinel-2 cloudless - no key; CC BY-NC-SA 4.0 (non-commercial), attribution required
// Override with VITE_DETAIL_TILES_URL (single {z}/{y}/{x} template, e.g. a MapTiler / Mapbox URL with your key),
// or set it to "off" to disable close-up imagery.
const detailRaw = import.meta.env?.VITE_DETAIL_TILES_URL;
const custom = detailRaw === undefined ? null : String(detailRaw).trim();
export const DETAIL_SOURCES = custom === null
  ? [
      { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Esri, Maxar, Earthstar Geographics' },
      { url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg', attribution: 'Sentinel-2 cloudless by EOX (contains modified Copernicus Sentinel data 2021)' },
    ]
  : (['', 'off', 'none'].includes(custom.toLowerCase()) ? [] : [{ url: custom, attribution: import.meta.env?.VITE_DETAIL_ATTRIBUTION || 'Custom imagery provider' }]);
export const DETAIL_TILES = DETAIL_SOURCES.length > 0;
