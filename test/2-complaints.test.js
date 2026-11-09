// Flow 2: Complaint creation and status change (with SMS notification)
import { expect } from 'chai';
import { startTestEnv } from './helpers.js';

describe('Flow 2: Complaint creation and status change', () => {
  let env;
  let admin;
  let officer;
  let citizen;

  before(async () => {
    env = await startTestEnv();
    admin = await env.loginAdmin();
    officer = await env.createOfficer(admin.token);
    citizen = await env.registerCitizen({ phone: '+919812345678' });
  });
  after(() => env.close());

  it('creates a complaint and stores the geocoded latitude/longitude', async () => {
    const res = await env
      .post(
        '/api/complaints',
        { title: 'Large pothole near metro', description: 'Deep pothole in the left lane near the metro.', category: 'pothole', address: 'MG Road, Bengaluru' },
        citizen.token,
      )
      .expect(201);
    expect(res.headers['x-served-by']).to.equal('complaints-service');
    expect(res.headers.location).to.equal(`/api/complaints/${res.body.id}`);
    expect(res.body).to.include({ status: 'open', category: 'pothole', userId: citizen.user.id });
    expect(res.body.location).to.include({ lat: 12.9755, lng: 77.6068, provider: 'nominatim' });
    expect(res.body.history).to.have.lengthOf(1);
  });

  it('rejects an invalid complaint body with field-level errors', async () => {
    const res = await env.post('/api/complaints', { title: 'Hi', category: 'aliens' }, citizen.token).expect(400);
    expect(res.body.error.details.map((d) => d.field)).to.have.members(['title', 'description', 'category', 'address']);
  });

  it('lets an officer move a complaint through open -> in_progress -> resolved and SMSes the citizen each time', async () => {
    const complaint = await env.createComplaint(citizen.token);

    const step1 = await env
      .patch(`/api/complaints/${complaint.id}/status`, { status: 'in_progress', note: 'Crew assigned' }, officer.token)
      .expect(200);
    expect(step1.body.complaint.status).to.equal('in_progress');
    expect(step1.body.notification).to.include({ channel: 'sms', provider: 'twilio', status: 'sent', to: '+91******5678' });

    const step2 = await env.patch(`/api/complaints/${complaint.id}/status`, { status: 'resolved' }, officer.token).expect(200);
    expect(step2.body.complaint.status).to.equal('resolved');
    expect(step2.body.complaint.history.map((h) => h.status)).to.deep.equal(['open', 'in_progress', 'resolved']);

    // The fake Twilio server received real API calls with the citizen's full number.
    const sent = env.twilio.state.messages.filter((m) => m.To === '+919812345678');
    expect(sent).to.have.lengthOf(2);
    expect(sent[0]).to.include({ From: '+15005550006' });
    expect(sent[0].Body).to.contain('IN PROGRESS').and.contain('Crew assigned');
    expect(sent[1].Body).to.contain('RESOLVED');
  });

  it('refuses transitions that are not allowed (409)', async () => {
    const complaint = await env.createComplaint(citizen.token);
    const res = await env.patch(`/api/complaints/${complaint.id}/status`, { status: 'resolved' }, officer.token).expect(409);
    expect(res.body.error.code).to.equal('CONFLICT');
    expect(res.body.error.message).to.contain('Allowed: in_progress, rejected');
  });

  it('shows citizens only their own complaints, but staff see all', async () => {
    const other = await env.registerCitizen();
    await env.createComplaint(other.token, { title: 'Garbage not collected' });

    const mine = await env.get('/api/complaints', citizen.token).expect(200);
    expect(mine.body.complaints.every((c) => c.userId === citizen.user.id)).to.equal(true);

    const all = await env.get('/api/complaints', officer.token).expect(200);
    expect(all.body.count).to.be.greaterThan(mine.body.count);

    const filtered = await env.get('/api/complaints?status=resolved', officer.token).expect(200);
    expect(filtered.body.complaints.every((c) => c.status === 'resolved')).to.equal(true);
  });
});
