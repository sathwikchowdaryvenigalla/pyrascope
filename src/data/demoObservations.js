// DEMO DATA ONLY: simulated records, NOT actual NASA detections.
// Record shape is intended to map onto future MODIS/VIIRS active-fire products.
export const DEMO_RANGE = { start: '2025-01-01', end: '2026-12-31' };
export const OVERVIEW_RANGE = { start: '2026-11-12', end: '2026-11-14' };

// base = typical daily activity, peak = illustrative peak month (1-12)
export const DEMO_LOCATIONS = [
  { id: 'visakhapatnam', name: 'Visakhapatnam, India', aliases: ['visakhapatnam', 'vizag'], lat: 17.69, lon: 83.22, base: 4, peak: 3 },
  { id: 'bhopal', name: 'Bhopal, India', aliases: ['bhopal'], lat: 23.26, lon: 77.41, base: 3, peak: 4 },
  { id: 'ludhiana', name: 'Ludhiana, India', aliases: ['ludhiana', 'punjab'], lat: 30.9, lon: 75.85, base: 4, peak: 11 },
  { id: 'chiangmai', name: 'Chiang Mai, Thailand', aliases: ['chiang mai', 'thailand'], lat: 18.79, lon: 98.98, base: 4, peak: 3 },
  { id: 'kalimantan', name: 'Kalimantan, Indonesia', aliases: ['kalimantan', 'borneo', 'indonesia'], lat: -1.7, lon: 113.9, base: 5, peak: 9 },
  { id: 'darwin', name: 'Darwin, Australia', aliases: ['darwin', 'northern territory'], lat: -12.46, lon: 130.84, base: 5, peak: 9 },
  { id: 'rondonia', name: 'Rondônia, Brazil', aliases: ['rondonia', 'rondônia', 'porto velho'], lat: -10.9, lon: -62.8, base: 6, peak: 9 },
  { id: 'matogrosso', name: 'Mato Grosso, Brazil', aliases: ['mato grosso', 'cuiaba', 'brazil'], lat: -13.0, lon: -56.0, base: 6, peak: 8 },
  { id: 'kinshasa', name: 'Kinshasa, DR Congo', aliases: ['kinshasa', 'congo'], lat: -4.3, lon: 15.3, base: 5, peak: 7 },
  { id: 'kruger', name: 'Kruger, South Africa', aliases: ['kruger', 'south africa'], lat: -23.9, lon: 31.6, base: 3, peak: 8 },
  { id: 'athens', name: 'Athens, Greece', aliases: ['athens', 'greece'], lat: 38.0, lon: 23.7, base: 2, peak: 7 },
  { id: 'madrid', name: 'Madrid, Spain', aliases: ['madrid', 'spain'], lat: 40.4, lon: -3.7, base: 2, peak: 8 },
  { id: 'krasnoyarsk', name: 'Krasnoyarsk, Russia', aliases: ['krasnoyarsk', 'siberia', 'russia'], lat: 56.0, lon: 92.9, base: 3, peak: 7 },
  { id: 'edmonton', name: 'Edmonton, Canada', aliases: ['edmonton', 'alberta', 'canada'], lat: 53.55, lon: -113.5, base: 3, peak: 6 },
  { id: 'california', name: 'Los Angeles, USA', aliases: ['los angeles', 'california'], lat: 34.05, lon: -118.24, base: 3, peak: 9 },
];

const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// [platform, local overpass minutes (day), local overpass minutes (night)] - illustrative only
const PLATFORMS = {
  MODIS: [['Terra', 630, 1350], ['Aqua', 810, 90]],
  VIIRS: [['Suomi-NPP', 810, 90], ['NOAA-20', 790, 70], ['NOAA-21', 790, 70]],
};

function generate() {
  const out = [];
  const DAY = 86400000;
  const t0 = Date.UTC(2025, 0, 1), t1 = Date.UTC(2026, 11, 31);
  DEMO_LOCATIONS.forEach((loc, li) => {
    const rand = rng(1000 + li * 77);
    for (let t = t0; t <= t1; t += DAY) {
      const dt = new Date(t);
      const date = dt.toISOString().slice(0, 10);
      const diff = Math.abs(dt.getUTCMonth() + 1 - loc.peak);
      const dist = Math.min(diff, 12 - diff);
      const season = 0.3 + 1.7 * Math.exp(-(dist * dist) / 8);
      const n = rand() < 0.2 ? 0 : 1 + Math.floor(rand() * loc.base * season * 1.6);
      for (let k = 0; k < n; k++) {
        const satellite = rand() < 0.5 ? 'MODIS' : 'VIIRS';
        const mod = satellite === 'MODIS';
        const latitude = +(loc.lat + (rand() - 0.5) * 1.6).toFixed(4);
        const longitude = +(loc.lon + (rand() - 0.5) * 1.6).toFixed(4);
        const pl = PLATFORMS[satellite][Math.floor(rand() * PLATFORMS[satellite].length)];
        const day = rand() < 0.6;
        const mins = Math.round(((((day ? pl[1] : pl[2]) + (rand() - 0.5) * 90 - longitude * 4) % 1440) + 1440) % 1440);
        const time = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
        const e = rand(), c = rand();
        out.push({
          id: `${loc.id}-${date}-${k}`,
          locationId: loc.id,
          locationName: loc.name,
          latitude,
          longitude,
          date,                                   // acquisition date (UTC)
          time,                                   // acquisition time (UTC, HH:MM)
          platform: pl[0],                        // Terra, Aqua, Suomi-NPP, NOAA-20, NOAA-21
          satellite,                              // instrument key used for filtering: MODIS | VIIRS
          instrument: satellite,
          brightness: +(mod ? 305 + rand() * rand() * 95 : 300 + rand() * rand() * 67).toFixed(1), // Kelvin
          confidence: mod ? `${Math.floor(30 + c * 70)}%` : c < 0.15 ? 'low' : c < 0.75 ? 'nominal' : 'high',
          frp: +(2 + rand() * rand() * 60).toFixed(1), // MW
          scan: +(mod ? 1 + e * e * 3.2 : 0.375 + e * e * 0.45).toFixed(2),  // km
          track: +(mod ? 1 + e * e * 1.6 : 0.375 + e * e * 0.3).toFixed(2),  // km
          daynight: day ? 'Day' : 'Night',
          version: mod ? '6.1NRT' : '2.0NRT',
          demo: true,
          source: 'DEMO DATA',
        });
      }
    }
  });
  return out;
}
export const DEMO_OBSERVATIONS = generate();

export function findLocation(text) {
  const q = text.trim().toLowerCase();
  if (q.length < 3) return null;
  return DEMO_LOCATIONS.find((l) => l.aliases.some((a) => q.includes(a) || (q.length >= 4 && a.startsWith(q)))) || null;
}
