// Flow 1: Login + JWT verification
import { expect } from 'chai';
import jwt from 'jsonwebtoken';
import { ADMIN, JWT_SECRET, startTestEnv } from './helpers.js';

describe('Flow 1: Login + JWT verification', () => {
  let env;
  before(async () => {
    env = await startTestEnv();
  });
  after(() => env.close());

  it('registers a citizen and returns a signed JWT with the citizen role', async () => {
    const res = await env
      .post('/api/users/register', { name: 'Asha Rao', email: 'asha@test.local', password: 'S3cure!pass', phone: '+919876543210' })
      .expect(201);
    expect(res.body.user).to.include({ name: 'Asha Rao', email: 'asha@test.local', role: 'citizen' });
    expect(res.body.user).to.not.have.property('passwordHash');
    const payload = jwt.verify(res.body.token, JWT_SECRET, { issuer: 'smart-city-portal' });
    expect(payload).to.include({ sub: res.body.user.id, role: 'citizen' });
    expect(payload.exp - payload.iat).to.equal(3600);
  });

  it('ignores a self-assigned role: new accounts are always citizens', async () => {
    const res = await env
      .post('/api/users/register', { name: 'Sneaky', email: 'sneaky@test.local', password: 'S3cure!pass', phone: '+919876543211', role: 'admin' })
      .expect(201);
    expect(res.body.user.role).to.equal('citizen');
  });

  it('logs in with correct credentials and the token works on a protected route', async () => {
    const login = await env.post('/api/users/login', { email: ADMIN.email, password: ADMIN.password }).expect(200);
    expect(login.body).to.include({ tokenType: 'Bearer', expiresIn: '1h' });
    const me = await env.get('/api/users/me', login.body.token).expect(200);
    expect(me.body).to.include({ email: ADMIN.email, role: 'admin' });
  });

  it('rejects a wrong password with 401 and a generic message', async () => {
    const res = await env.post('/api/users/login', { email: ADMIN.email, password: 'wrong-password' }).expect(401);
    expect(res.body.error).to.deep.equal({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
    const unknown = await env.post('/api/users/login', { email: 'nobody@test.local', password: 'whatever1' }).expect(401);
    expect(unknown.body.error.message).to.equal('Invalid email or password');
  });

  it('rejects requests without a token, with a tampered token, a foreign token or an expired token', async () => {
    const { token, user } = await env.registerCitizen();

    const none = await env.get('/api/users/me').expect(401);
    expect(none.body.error.code).to.equal('UNAUTHORIZED');

    // Change the payload (role -> admin) but keep the old signature.
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: user.id, role: 'admin', iss: 'smart-city-portal' })).toString('base64url');
    const tampered = await env.get('/api/users/me', `${header}.${forgedPayload}.${signature}`).expect(401);
    expect(tampered.body.error.message).to.equal('Invalid token');

    const foreign = jwt.sign({ role: 'admin' }, 'some-other-secret-that-is-long-enough!!', { subject: user.id, issuer: 'smart-city-portal' });
    await env.get('/api/users/me', foreign).expect(401);

    const expired = jwt.sign({ role: 'citizen' }, JWT_SECRET, { subject: user.id, issuer: 'smart-city-portal', expiresIn: -10 });
    const exp = await env.get('/api/users/me', expired).expect(401);
    expect(exp.body.error.message).to.equal('Token has expired');
  });

  it('validates registration input and reports every invalid field', async () => {
    const res = await env.post('/api/users/register', { name: 'A', email: 'not-an-email', password: 'short', phone: '9876543210' }).expect(400);
    expect(res.body.error.code).to.equal('VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field)).to.have.members(['name', 'email', 'password', 'phone']);
  });

  it('rejects a duplicate email with 409', async () => {
    await env.registerCitizen({ email: 'dup@test.local' });
    const res = await env
      .post('/api/users/register', { name: 'Dup Two', email: 'DUP@test.local', password: 'S3cure!pass', phone: '+919876543299' })
      .expect(409);
    expect(res.body.error.code).to.equal('CONFLICT');
  });
});
