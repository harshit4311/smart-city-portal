// Flow 5: API gateway - routing, API key verification and rate limiting
import { expect } from 'chai';
import express from 'express';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/gateway/gateway.js';
import { ADMIN, API_KEY, startTestEnv } from './helpers.js';

describe('Flow 5: API gateway', () => {
  describe('routing and API keys', () => {
    let env;
    before(async () => {
      env = await startTestEnv();
    });
    after(() => env.close());

    it('rejects /api requests without an API key (401) or with a wrong one (403)', async () => {
      const missing = await env.api.post('/api/users/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(401);
      expect(missing.body.error.code).to.equal('API_KEY_MISSING');
      const wrong = await env.api.get('/api/users/me').set('x-api-key', 'nope').expect(403);
      expect(wrong.body.error.code).to.equal('API_KEY_INVALID');
    });

    it('routes each path prefix to the right service', async () => {
      const { token } = await env.loginAdmin();
      const users = await env.get('/api/users/me', token).expect(200);
      const complaints = await env.get('/api/complaints', token).expect(200);
      const maps = await env.get('/api/maps/geocode?address=MG Road, Bengaluru', token).expect(200);
      expect(users.headers['x-served-by']).to.equal('users-service');
      expect(complaints.headers['x-served-by']).to.equal('complaints-service');
      expect(maps.headers['x-served-by']).to.equal('geo-service');
    });

    it('does not expose internal service routes or unknown paths', async () => {
      await env.get('/internal/users/anything').expect(404);
      const res = await env.get('/api/payments/123').expect(404);
      expect(res.body.error.code).to.equal('NOT_FOUND');
    });

    it('serves health and docs without an API key', async () => {
      const health = await env.api.get('/health').expect(200);
      expect(health.body.services).to.deep.equal({ users: 'ok', complaints: 'ok', geo: 'ok' });
      const spec = await env.api.get('/openapi.json').expect(200);
      expect(spec.body.openapi).to.match(/^3\./);
      expect(Object.keys(spec.body.paths)).to.include.members(['/api/users/login', '/api/complaints/{id}/status', '/api/maps/geocode']);
      await env.api.get('/docs/').expect(200).expect('content-type', /html/);
    });

    it('returns 502 SERVICE_UNAVAILABLE when a downstream service is down', async () => {
      const config = loadConfig({
        logRequests: false,
        gateway: { apiKeys: [API_KEY] },
        serviceUrls: { users: 'http://127.0.0.1:9', complaints: 'http://127.0.0.1:9', geo: 'http://127.0.0.1:9' },
      });
      const res = await request(createGateway(config)).get('/api/users/me').set('x-api-key', API_KEY).expect(502);
      expect(res.body.error.code).to.equal('SERVICE_UNAVAILABLE');
      await request(createGateway(config)).get('/health').expect(503);
    });

    it('strips the API key and adds a request ID before forwarding', async () => {
      let seen;
      const echo = express().use((req, res) => {
        seen = req.headers;
        res.json({ ok: true });
      });
      const server = await new Promise((r) => {
        const s = echo.listen(0, '127.0.0.1', () => r(s));
      });
      const url = `http://127.0.0.1:${server.address().port}`;
      const config = loadConfig({ logRequests: false, gateway: { apiKeys: [API_KEY] }, serviceUrls: { users: url } });
      const res = await request(createGateway(config)).get('/api/users/me').set('x-api-key', API_KEY).expect(200);
      server.close();
      expect(seen).to.not.have.property('x-api-key');
      expect(seen['x-request-id']).to.equal(res.headers['x-request-id']);
      expect(seen['x-forwarded-for']).to.be.a('string');
    });
  });

  describe('rate limiting', () => {
    let env;
    before(async () => {
      env = await startTestEnv({ gateway: { rateLimitMax: 5, authRateLimitMax: 3 } });
    });
    after(() => env.close());

    it('allows 5 requests per window per API key, then returns 429 with Retry-After', async () => {
      for (let i = 0; i < 5; i += 1) {
        const ok = await env.get('/api/complaints').expect(401); // counted even without a JWT
        expect(ok.headers.ratelimit).to.contain(`r=${4 - i}`);
      }
      const blocked = await env.get('/api/complaints').expect(429);
      expect(blocked.body.error.code).to.equal('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).to.be.greaterThan(0);
    });

    it('limits login attempts per IP more strictly (brute-force protection)', async () => {
      const fresh = await startTestEnv({ gateway: { rateLimitMax: 100, authRateLimitMax: 3 } });
      try {
        for (let i = 0; i < 3; i += 1) {
          await fresh.post('/api/users/login', { email: ADMIN.email, password: 'guess' + i }).expect(401);
        }
        const blocked = await fresh.post('/api/users/login', { email: ADMIN.email, password: ADMIN.password }).expect(429);
        expect(blocked.body.error.code).to.equal('RATE_LIMITED');
      } finally {
        await fresh.close();
      }
    });
  });
});
