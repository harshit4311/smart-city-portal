// Flow 3: Role-based access failures (e.g. unauthorised delete)
import { expect } from 'chai';
import { startTestEnv } from './helpers.js';

describe('Flow 3: Role-based access control', () => {
  let env;
  let admin;
  let officer;
  let citizen;
  let complaint;

  before(async () => {
    env = await startTestEnv();
    admin = await env.loginAdmin();
    officer = await env.createOfficer(admin.token);
    citizen = await env.registerCitizen();
  });
  beforeEach(async () => {
    complaint = await env.createComplaint(citizen.token);
  });
  after(() => env.close());

  it('blocks a citizen from deleting a complaint (403) and leaves it in place', async () => {
    const res = await env.del(`/api/complaints/${complaint.id}`, citizen.token).expect(403);
    expect(res.body.error).to.deep.equal({ code: 'FORBIDDEN', message: 'This action requires one of these roles: admin' });
    await env.get(`/api/complaints/${complaint.id}`, citizen.token).expect(200);
  });

  it('blocks an officer from deleting a complaint (403)', async () => {
    await env.del(`/api/complaints/${complaint.id}`, officer.token).expect(403);
  });

  it('lets an admin delete a complaint (204), after which it is gone (404)', async () => {
    await env.del(`/api/complaints/${complaint.id}`, admin.token).expect(204);
    await env.get(`/api/complaints/${complaint.id}`, admin.token).expect(404);
  });

  it('blocks a citizen from changing complaint status (403) and sends no SMS', async () => {
    const before = env.twilio.state.messages.length;
    const res = await env.patch(`/api/complaints/${complaint.id}/status`, { status: 'resolved' }, citizen.token).expect(403);
    expect(res.body.error.message).to.equal('This action requires one of these roles: officer, admin');
    expect(env.twilio.state.messages.length).to.equal(before);
  });

  it("blocks a citizen from viewing someone else's complaint (403)", async () => {
    const stranger = await env.registerCitizen();
    const res = await env.get(`/api/complaints/${complaint.id}`, stranger.token).expect(403);
    expect(res.body.error.code).to.equal('FORBIDDEN');
  });

  it('blocks non-admins from admin-only user routes', async () => {
    await env.get('/api/users', citizen.token).expect(403);
    await env.get('/api/users', officer.token).expect(403);
    await env.patch(`/api/users/${citizen.user.id}/role`, { role: 'admin' }, citizen.token).expect(403);
    await env.get('/api/complaints/notifications', officer.token).expect(403);
    const list = await env.get('/api/users', admin.token).expect(200);
    expect(list.body.count).to.be.at.least(3);
  });

  it('requires a token at all (401 without one)', async () => {
    await env.del(`/api/complaints/${complaint.id}`).expect(401);
  });
});
