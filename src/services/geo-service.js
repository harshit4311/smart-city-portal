// Geo service: map utilities on top of the geocoding provider (OpenStreetMap or Google).
import { authenticate } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { createServiceApp, finalizeApp } from '../lib/app.js';
import { distanceKm, round } from '../lib/geo.js';
import { parseNumber } from '../lib/validate.js';

export function createGeoService(config, { geocoder }) {
  const app = createServiceApp('geo-service', config);
  // Maps endpoints require login so anonymous traffic cannot use up the provider's quota.
  app.use('/api/maps', authenticate(config.jwt));

  function requireQuery(req, name) {
    const value = req.query[name];
    if (typeof value !== 'string' || !value.trim()) {
      throw badRequest(`Query parameter "${name}" is required`, [{ field: name, message: `${name} is required` }]);
    }
    return value.trim();
  }

  // GET /api/maps/geocode?address=MG Road, Bengaluru
  app.get('/api/maps/geocode', async (req, res) => {
    const address = requireQuery(req, 'address');
    res.json({ query: address, location: await geocoder.geocode(address) });
  });

  // GET /api/maps/reverse?lat=12.9758&lng=77.6045
  app.get('/api/maps/reverse', async (req, res) => {
    const lat = parseNumber(req.query.lat, 'lat', { min: -90, max: 90 });
    const lng = parseNumber(req.query.lng, 'lng', { min: -180, max: 180 });
    res.json({ location: await geocoder.reverse(lat, lng) });
  });

  // GET /api/maps/distance?from=MG Road, Bengaluru&to=12.9698,77.75
  app.get('/api/maps/distance', async (req, res) => {
    const [from, to] = await Promise.all([
      geocoder.geocode(requireQuery(req, 'from')),
      geocoder.geocode(requireQuery(req, 'to')),
    ]);
    res.json({ from, to, distanceKm: round(distanceKm(from, to)) });
  });

  return finalizeApp(app);
}
