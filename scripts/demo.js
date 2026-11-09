// End-to-end demo for screenshots/screencast. Start the app first (npm start), then run:
//   npm run demo                                       (local gateway on :8080)
//   BASE_URL=https://your-app.onrender.com npm run demo   (deployed gateway)
// Reads the API key and admin login from .env (or the environment).
import 'dotenv/config';

const BASE = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '');
const API_KEY = (process.env.API_KEYS || '').split(',')[0].trim();
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const c = { bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` };
let step = 0;

async function call(method, path, { body, token, apiKey = API_KEY } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  const colour = res.status < 400 ? c.green : c.red;
  console.log(`   ${c.cyan(`${method} ${path}`)} -> ${colour(res.status)} ${c.dim(res.headers.get('x-served-by') || '')}`);
  return { status: res.status, body: json };
}

function title(text) {
  step += 1;
  console.log(`\n${c.bold(`${step}. ${text}`)}`);
}

function show(obj) {
  console.log(
    JSON.stringify(obj, null, 2)
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n'),
  );
}

if (!API_KEY || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set API_KEYS, ADMIN_EMAIL and ADMIN_PASSWORD (for example in .env) before running the demo.');
  process.exit(1);
}

console.log(c.bold(`Smart City Portal - integration demo against ${BASE}`));

title('Gateway health (public)');
show((await call('GET', '/health', { apiKey: null })).body);

title('Gateway security: request without an API key is rejected');
show((await call('GET', '/api/complaints', { apiKey: null })).body);

title('Admin logs in (JWT issued by the user service)');
const admin = (await call('POST', '/api/users/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })).body;
console.log(`      token: ${admin.token.slice(0, 40)}...  role: ${admin.user.role}`);

title('Citizen registers');
const stamp = Date.now();
const citizen = (
  await call('POST', '/api/users/register', {
    body: { name: 'Demo Citizen', email: `citizen.${stamp}@demo.local`, password: 'DemoPass#2026', phone: '+919876543210' },
  })
).body;
console.log(`      user: ${citizen.user.email}  role: ${citizen.user.role}`);

title('Geocoding with OpenStreetMap: address -> latitude/longitude');
show((await call('GET', '/api/maps/geocode?address=' + encodeURIComponent('MG Road, Bengaluru'), { token: citizen.token })).body);

title('Citizen files 3 complaints (each address geocoded automatically)');
const complaints = [];
for (const [t, cat, addr] of [
  ['Large pothole near metro station', 'pothole', 'MG Road, Bengaluru'],
  ['Overflowing garbage bins', 'garbage', 'Brigade Road, Bengaluru'],
  ['Streetlights not working', 'streetlight', 'Whitefield, Bengaluru'],
]) {
  const r = await call('POST', '/api/complaints', {
    token: citizen.token,
    body: { title: t, category: cat, address: addr, description: `${t} - reported during the demo.` },
  });
  complaints.push(r.body);
  console.log(`      ${r.body.id}  ${addr.padEnd(24)} -> ${r.body.location.lat}, ${r.body.location.lng}`);
}

title('Nearby complaints: within 3 km of Cubbon Park');
const nearby = (await call('GET', `/api/complaints/nearby?address=${encodeURIComponent('Cubbon Park, Bengaluru')}&radiusKm=3`, { token: citizen.token })).body;
console.log(`      centre: ${nearby.center.lat}, ${nearby.center.lng}  radius: ${nearby.radiusKm} km  found: ${nearby.count}`);
for (const n of nearby.complaints) console.log(`      - ${n.title.padEnd(34)} ${n.distanceKm} km`);

title('Distance between two places');
const dist = (await call('GET', `/api/maps/distance?from=${encodeURIComponent('MG Road, Bengaluru')}&to=${encodeURIComponent('Whitefield, Bengaluru')}`, { token: citizen.token })).body;
console.log(`      MG Road -> Whitefield: ${dist.distanceKm} km`);

title('Role-based access: citizen tries to delete a complaint');
show((await call('DELETE', `/api/complaints/${complaints[0].id}`, { token: citizen.token })).body);

title('Admin updates complaint status -> SMS sent to the citizen');
const upd = (await call('PATCH', `/api/complaints/${complaints[0].id}/status`, { token: admin.token, body: { status: 'in_progress', note: 'Repair crew assigned for tomorrow morning' } })).body;
console.log(`      status: ${upd.complaint.status}`);
show(upd.notification);

title('SMS notification log (admin only)');
const log = (await call('GET', '/api/complaints/notifications', { token: admin.token })).body;
show(log.notifications[0]);

console.log(`\n${c.green('Demo complete.')} Swagger UI: ${BASE}/docs   ReDoc: ${BASE}/redoc\n`);
