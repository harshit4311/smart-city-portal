// Starts a complete, isolated copy of the system for a test file:
// fake Nominatim + fake Twilio -> three services on random ports -> gateway.
// Tests talk only to the gateway, exactly like a real client.
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/gateway/gateway.js';
import { createGeocoder } from '../src/integrations/geocoder.js';
import { createSmsClient } from '../src/integrations/sms.js';
import { createComplaintService } from '../src/services/complaint-service.js';
import { createGeoService } from '../src/services/geo-service.js';
import { createUserService } from '../src/services/user-service.js';
import { startFakeNominatim, startFakeTwilio } from './fakes.js';

export const API_KEY = 'test-api-key-123';
export const JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars';
export const ADMIN = { email: 'admin@test.local', password: 'AdminPass#2026', phone: '+919000000001' };
const TWILIO = { sid: 'ACtest00000000000000000000000000', token: 'test-auth-token' };

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export async function startTestEnv(overrides = {}) {
  const nominatim = await startFakeNominatim();
  const twilio = await startFakeTwilio(TWILIO);

  const config = loadConfig({
    logRequests: false,
    jwt: { secret: JWT_SECRET, expiresIn: '1h' },
    internalServiceKey: 'test-internal-key-456',
    gateway: { apiKeys: [API_KEY], rateLimitMax: 1000, authRateLimitMax: 1000, rateLimitWindowMs: 60_000, trustProxy: 0 },
    admin: { name: 'Test Admin', ...ADMIN },
    geocoder: { provider: 'nominatim', nominatimBaseUrl: nominatim.url, countryCodes: 'in', timeoutMs: 2000 },
    sms: {
      provider: 'twilio',
      twilioAccountSid: TWILIO.sid,
      twilioAuthToken: TWILIO.token,
      twilioFromNumber: '+15005550006',
      twilioBaseUrl: twilio.url,
    },
  }, overrides);

  const geocoder = createGeocoder(config.geocoder, { minIntervalMs: 0 });
  const sms = createSmsClient(config.sms, { log: () => {} });
  const servers = {
    users: await listen(createUserService(config)),
    complaints: await listen(createComplaintService(config, { geocoder, sms })),
    geo: await listen(createGeoService(config, { geocoder })),
  };
  for (const [name, server] of Object.entries(servers)) {
    config.serviceUrls[name] = `http://127.0.0.1:${server.address().port}`;
  }
  const gateway = createGateway(config);
  const gatewayServer = await listen(gateway);
  const api = request(`http://127.0.0.1:${gatewayServer.address().port}`);

  const env = {
    config,
    api,
    gateway,
    nominatim,
    twilio,
    servers,
    async close() {
      const all = [gatewayServer, ...Object.values(servers), nominatim.server, twilio.server];
      await Promise.all(all.map((s) => new Promise((r) => s.close(r))));
    },
    // Request helpers that add the API key and (optionally) a JWT.
    get: (url, token) => withAuth(api.get(url), token),
    post: (url, body, token) => withAuth(api.post(url), token).send(body),
    patch: (url, body, token) => withAuth(api.patch(url), token).send(body),
    del: (url, token) => withAuth(api.delete(url), token),
  };

  let counter = 0;
  env.registerCitizen = async (fields = {}) => {
    counter += 1;
    const res = await env.post('/api/users/register', {
      name: `Citizen ${counter}`,
      email: `citizen${counter}.${Date.now()}@test.local`,
      password: 'CitizenPass#1',
      phone: `+9198${String(10000000 + counter).slice(-8)}`,
      ...fields,
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { token: res.body.token, user: res.body.user };
  };
  env.loginAdmin = async () => {
    const res = await env.post('/api/users/login', { email: ADMIN.email, password: ADMIN.password });
    return { token: res.body.token, user: res.body.user };
  };
  env.createOfficer = async (adminToken) => {
    const officer = await env.registerCitizen();
    await env.patch(`/api/users/${officer.user.id}/role`, { role: 'officer' }, adminToken).expect(200);
    // Log in again so the new token carries the officer role.
    const res = await env.post('/api/users/login', { email: officer.user.email, password: 'CitizenPass#1' });
    return { token: res.body.token, user: res.body.user };
  };
  env.createComplaint = async (token, fields = {}) => {
    const res = await env.post(
      '/api/complaints',
      {
        title: 'Broken streetlight on main road',
        description: 'The streetlight has been off for a week and the road is dark.',
        category: 'streetlight',
        address: 'MG Road, Bengaluru',
        ...fields,
      },
      token,
    );
    if (res.status !== 201) throw new Error(`create complaint failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  return env;
}

function withAuth(req, token) {
  req.set('x-api-key', API_KEY);
  if (token) req.set('authorization', `Bearer ${token}`);
  return req;
}
