// Flow 4: Integration with external APIs (OpenStreetMap geocoding and Twilio SMS), mocked
// with local fake servers so the real HTTP client code runs end to end.
import { expect } from 'chai';
import { createGeocoder } from '../src/integrations/geocoder.js';
import { createSmsClient } from '../src/integrations/sms.js';
import { INVALID_PHONE } from './fakes.js';
import { startTestEnv } from './helpers.js';

describe('Flow 4: External API integrations (mocked)', () => {
  let env;
  let citizen;
  let admin;

  before(async () => {
    env = await startTestEnv();
    citizen = await env.registerCitizen();
    admin = await env.loginAdmin();
  });
  after(() => env.close());

  describe('Geocoding (OpenStreetMap Nominatim)', () => {
    it('geocodes an address with the correct request and caches the result', async () => {
      const res = await env.get('/api/maps/geocode?address=Cubbon Park, Bengaluru', citizen.token).expect(200);
      expect(res.headers['x-served-by']).to.equal('geo-service');
      expect(res.body.location).to.include({ lat: 12.9763, lng: 77.5929, provider: 'nominatim' });

      const calls = env.nominatim.state.requests.filter((r) => r.query.q === 'Cubbon Park, Bengaluru');
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].query).to.include({ format: 'jsonv2', limit: '1', countrycodes: 'in' });
      expect(calls[0].userAgent).to.contain('SmartCityPortal'); // required by the OSM usage policy

      const again = await env.get('/api/maps/geocode?address=cubbon park, bengaluru', citizen.token).expect(200);
      expect(again.body.location.cached).to.equal(true);
      expect(env.nominatim.state.requests.filter((r) => r.query.q?.toLowerCase() === 'cubbon park, bengaluru')).to.have.lengthOf(1);
    });

    it('reverse-geocodes coordinates to an address', async () => {
      const res = await env.get('/api/maps/reverse?lat=12.9763&lng=77.5929', citizen.token).expect(200);
      expect(res.body.location.displayName).to.contain('Cubbon Park');
      await env.get('/api/maps/reverse?lat=0&lng=0', citizen.token).expect(422);
      await env.get('/api/maps/reverse?lat=200&lng=0', citizen.token).expect(400);
    });

    it('returns 422 ADDRESS_NOT_FOUND for an unknown address, both in maps and complaint creation', async () => {
      const res = await env.get('/api/maps/geocode?address=Nowhere Street 999', citizen.token).expect(422);
      expect(res.body.error.code).to.equal('ADDRESS_NOT_FOUND');
      const create = await env
        .post('/api/complaints', { title: 'Water leak somewhere', description: 'Water has been leaking for days.', category: 'water', address: 'Nowhere Street 999' }, citizen.token)
        .expect(422);
      expect(create.body.error.code).to.equal('ADDRESS_NOT_FOUND');
    });

    it('returns 502 GEOCODER_UNAVAILABLE when the provider fails', async () => {
      const res = await env.get('/api/maps/geocode?address=provider down', citizen.token).expect(502);
      expect(res.body.error.code).to.equal('GEOCODER_UNAVAILABLE');
    });

    it('returns 502 GEOCODER_UNAVAILABLE when the provider cannot be reached at all', async () => {
      const geocoder = createGeocoder({ provider: 'nominatim', nominatimBaseUrl: 'http://127.0.0.1:9', userAgent: 'test', timeoutMs: 500 }, { minIntervalMs: 0 });
      try {
        await geocoder.geocode('MG Road, Bengaluru');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.include({ status: 502, code: 'GEOCODER_UNAVAILABLE' });
      }
    });

    it('computes the distance between two places', async () => {
      const res = await env.get('/api/maps/distance?from=MG Road, Bengaluru&to=Whitefield, Bengaluru', citizen.token).expect(200);
      expect(res.body.distanceKm).to.be.closeTo(15.6, 0.5);
    });
  });

  describe('Nearby complaints (within X km)', () => {
    before(async () => {
      await env.createComplaint(citizen.token, { title: 'Pothole on MG Road', address: 'MG Road, Bengaluru' }); // ~1.5 km from Cubbon Park
      await env.createComplaint(citizen.token, { title: 'Garbage on Brigade Road', address: 'Brigade Road, Bengaluru' }); // ~1.7 km
      await env.createComplaint(citizen.token, { title: 'Flooding in Whitefield', address: 'Whitefield, Bengaluru' }); // ~17 km
    });

    it('returns only complaints inside the radius, nearest first, with public fields only', async () => {
      const res = await env.get('/api/complaints/nearby?lat=12.9763&lng=77.5929&radiusKm=2', citizen.token).expect(200);
      const titles = res.body.complaints.map((c) => c.title);
      expect(titles).to.include('Pothole on MG Road').and.include('Garbage on Brigade Road');
      expect(titles).to.not.include('Flooding in Whitefield');
      const distances = res.body.complaints.map((c) => c.distanceKm);
      expect(distances).to.deep.equal([...distances].sort((a, b) => a - b));
      expect(distances.every((d) => d <= 2)).to.equal(true);
      expect(res.body.complaints[0]).to.not.have.property('userId');
    });

    it('accepts an address as the centre and a larger radius', async () => {
      const res = await env.get('/api/complaints/nearby?address=Cubbon Park, Bengaluru&radiusKm=20', citizen.token).expect(200);
      expect(res.body.complaints.map((c) => c.title)).to.include('Flooding in Whitefield');
    });

    it('validates the radius and coordinates', async () => {
      await env.get('/api/complaints/nearby?lat=12.97&lng=77.59&radiusKm=500', citizen.token).expect(400);
      await env.get('/api/complaints/nearby?lat=abc&lng=77.59', citizen.token).expect(400);
    });
  });

  describe('SMS (Twilio)', () => {
    it('keeps the status change when the SMS fails, and records the failure in the log', async () => {
      const unlucky = await env.registerCitizen({ phone: INVALID_PHONE });
      const complaint = await env.createComplaint(unlucky.token);
      const res = await env.patch(`/api/complaints/${complaint.id}/status`, { status: 'rejected', note: 'Duplicate' }, admin.token).expect(200);
      expect(res.body.complaint.status).to.equal('rejected');
      expect(res.body.notification.status).to.equal('failed');

      const log = await env.get('/api/complaints/notifications', admin.token).expect(200);
      const entry = log.body.notifications.find((n) => n.complaintId === complaint.id);
      expect(entry).to.include({ status: 'failed', provider: 'twilio' });
      expect(entry.error).to.contain('21211');
      expect(entry.to).to.equal('+15******0001'); // stored masked, never in full
    });

    it('mock provider: sends without any network call and logs only a masked number', async () => {
      const lines = [];
      const sms = createSmsClient({ provider: 'mock' }, { log: (l) => lines.push(l) });
      const result = await sms.send('+919876543210', 'Hello');
      expect(result).to.include({ provider: 'mock', status: 'sent' });
      expect(result.providerMessageId).to.match(/^mock-/);
      expect(lines[0]).to.contain('+91******3210').and.not.contain('9876543210');
    });
  });
});
