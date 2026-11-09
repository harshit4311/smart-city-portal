// Fake versions of the external providers (OpenStreetMap Nominatim and Twilio).
// The real integration code sends real HTTP requests to these local servers, so the tests
// exercise the whole HTTP path without depending on the internet or paid accounts.
import express from 'express';

export const PLACES = {
  'mg road, bengaluru': { lat: '12.9755', lon: '77.6068', display_name: 'Mahatma Gandhi Road, Bengaluru, Karnataka, India' },
  'brigade road, bengaluru': { lat: '12.9716', lon: '77.6070', display_name: 'Brigade Road, Bengaluru, Karnataka, India' },
  'cubbon park, bengaluru': { lat: '12.9763', lon: '77.5929', display_name: 'Cubbon Park, Bengaluru, Karnataka, India' },
  'whitefield, bengaluru': { lat: '12.9698', lon: '77.7500', display_name: 'Whitefield, Bengaluru, Karnataka, India' },
};

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export async function startFakeNominatim() {
  const state = { requests: [] };
  const app = express();
  app.get('/search', (req, res) => {
    state.requests.push({ path: '/search', query: req.query, userAgent: req.get('user-agent') });
    const q = String(req.query.q).toLowerCase();
    if (q === 'provider down') return res.status(503).send('Service Unavailable');
    const hit = PLACES[q];
    return res.json(hit ? [{ place_id: 1, ...hit }] : []);
  });
  app.get('/reverse', (req, res) => {
    state.requests.push({ path: '/reverse', query: req.query, userAgent: req.get('user-agent') });
    if (Number(req.query.lat) === 0 && Number(req.query.lon) === 0) return res.json({ error: 'Unable to geocode' });
    return res.json({ lat: req.query.lat, lon: req.query.lon, display_name: 'Cubbon Park, Bengaluru, Karnataka, India' });
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.address().port}`, state, server };
}

// Mimics Twilio's Messages API, including its error for an invalid "To" number.
// +15005550001 is Twilio's real "magic" test number for that error.
export const INVALID_PHONE = '+15005550001';

export async function startFakeTwilio({ sid, token }) {
  const state = { messages: [] };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post('/2010-04-01/Accounts/:sid/Messages.json', (req, res) => {
    const expected = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
    if (req.params.sid !== sid || req.get('authorization') !== expected) {
      return res.status(401).json({ code: 20003, message: 'Authenticate', status: 401 });
    }
    if (req.body.To === INVALID_PHONE) {
      return res.status(400).json({ code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 });
    }
    const message = { sid: `SM${state.messages.length.toString().padStart(32, '0')}`, status: 'queued', ...req.body };
    state.messages.push(message);
    return res.status(201).json({ sid: message.sid, status: message.status, to: message.To, body: message.Body });
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.address().port}`, state, server };
}
