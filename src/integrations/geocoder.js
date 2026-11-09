// Geocoding integration: turns an address into latitude/longitude (and back).
//
// Providers:
//   nominatim - OpenStreetMap's free geocoder (default, no API key needed)
//   google    - Google Maps Geocoding API (needs GOOGLE_MAPS_API_KEY)
//   mock      - fixed lookup table, for offline development and tests
import { HttpError } from '../lib/errors.js';

const MOCK_PLACES = {
  'mg road, bengaluru': { lat: 12.9758, lng: 77.6045, displayName: 'MG Road, Bengaluru, Karnataka, India' },
  'brigade road, bengaluru': { lat: 12.9716, lng: 77.6070, displayName: 'Brigade Road, Bengaluru, Karnataka, India' },
  'cubbon park, bengaluru': { lat: 12.9763, lng: 77.5929, displayName: 'Cubbon Park, Bengaluru, Karnataka, India' },
  'whitefield, bengaluru': { lat: 12.9698, lng: 77.7500, displayName: 'Whitefield, Bengaluru, Karnataka, India' },
  'connaught place, new delhi': { lat: 28.6315, lng: 77.2167, displayName: 'Connaught Place, New Delhi, Delhi, India' },
  'bandra, mumbai': { lat: 19.0596, lng: 72.8295, displayName: 'Bandra West, Mumbai, Maharashtra, India' },
};

const addressNotFound = (address) =>
  new HttpError(422, 'ADDRESS_NOT_FOUND', `Could not find a location for address "${address}"`);
const providerUnavailable = (provider, reason) =>
  new HttpError(502, 'GEOCODER_UNAVAILABLE', `Geocoding provider "${provider}" is unavailable: ${reason}`);

// "12.97,77.59" is accepted as coordinates directly, skipping the external call.
const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export function createGeocoder(geoConfig, { minIntervalMs } = {}) {
  const provider = geoConfig.provider;
  const cache = new Map();
  // Nominatim's usage policy allows at most 1 request per second, so calls are queued.
  const interval = minIntervalMs ?? (provider === 'nominatim' ? 1000 : 0);
  let queue = Promise.resolve();
  let lastCall = 0;

  function throttle(fn) {
    const run = queue.then(async () => {
      const wait = lastCall + interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function getJson(url, headers = {}) {
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(geoConfig.timeoutMs) });
    } catch (err) {
      throw providerUnavailable(provider, err.name === 'TimeoutError' ? 'request timed out' : err.message);
    }
    if (!res.ok) throw providerUnavailable(provider, `HTTP ${res.status}`);
    return res.json();
  }

  const providers = {
    async nominatim(address) {
      const url = new URL('/search', geoConfig.nominatimBaseUrl);
      url.search = new URLSearchParams({ q: address, format: 'jsonv2', limit: '1' });
      if (geoConfig.countryCodes) url.searchParams.set('countrycodes', geoConfig.countryCodes);
      const results = await throttle(() => getJson(url, { 'User-Agent': geoConfig.userAgent }));
      if (!Array.isArray(results) || results.length === 0) throw addressNotFound(address);
      const [hit] = results;
      return { lat: Number(hit.lat), lng: Number(hit.lon), displayName: hit.display_name };
    },
    async google(address) {
      const url = new URL('/maps/api/geocode/json', geoConfig.googleBaseUrl);
      url.search = new URLSearchParams({ address, key: geoConfig.googleApiKey });
      const data = await getJson(url);
      if (data.status === 'ZERO_RESULTS') throw addressNotFound(address);
      if (data.status !== 'OK') throw providerUnavailable('google', data.status);
      const [hit] = data.results;
      return { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, displayName: hit.formatted_address };
    },
    async mock(address) {
      const hit = MOCK_PLACES[address.trim().toLowerCase()];
      if (!hit) throw addressNotFound(address);
      return { ...hit };
    },
  };

  const reverseProviders = {
    async nominatim(lat, lng) {
      const url = new URL('/reverse', geoConfig.nominatimBaseUrl);
      url.search = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2' });
      const data = await throttle(() => getJson(url, { 'User-Agent': geoConfig.userAgent }));
      if (data.error) throw new HttpError(422, 'LOCATION_NOT_FOUND', 'No address found for these coordinates');
      return { lat, lng, displayName: data.display_name };
    },
    async google(lat, lng) {
      const url = new URL('/maps/api/geocode/json', geoConfig.googleBaseUrl);
      url.search = new URLSearchParams({ latlng: `${lat},${lng}`, key: geoConfig.googleApiKey });
      const data = await getJson(url);
      if (data.status === 'ZERO_RESULTS') {
        throw new HttpError(422, 'LOCATION_NOT_FOUND', 'No address found for these coordinates');
      }
      if (data.status !== 'OK') throw providerUnavailable('google', data.status);
      return { lat, lng, displayName: data.results[0].formatted_address };
    },
    async mock(lat, lng) {
      return { lat, lng, displayName: `Mock address near ${lat.toFixed(4)}, ${lng.toFixed(4)}` };
    },
  };

  if (!providers[provider]) throw new Error(`Unknown GEOCODER_PROVIDER "${provider}"`);

  return {
    provider,
    async geocode(address) {
      const coords = COORDS.exec(address);
      if (coords) {
        return { lat: Number(coords[1]), lng: Number(coords[2]), displayName: address.trim(), provider: 'coordinates' };
      }
      const key = address.trim().toLowerCase();
      if (cache.has(key)) return { ...cache.get(key), cached: true };
      const result = { ...(await providers[provider](address)), provider };
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, result);
      return result;
    },
    async reverse(lat, lng) {
      return { ...(await reverseProviders[provider](lat, lng)), provider };
    },
  };
}
