// User service: registration, login (JWT), profiles and roles.
// Owns all user data; other services only see users through JWT claims or /internal routes.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ROLES, authenticate, requireInternalKey, requireRole, signToken } from '../lib/auth.js';
import { conflict, notFound, unauthorized } from '../lib/errors.js';
import { createServiceApp, finalizeApp } from '../lib/app.js';
import { isEmail, isPhone, isString, oneOf, required, validate } from '../lib/validate.js';

const BCRYPT_ROUNDS = 10;
// Compared against when an email is unknown, so a failed login takes the same time either way
// and attackers cannot discover which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const toPublic = ({ passwordHash, ...user }) => user;

export function createUserService(config) {
  const app = createServiceApp('user-service', config);
  const users = new Map(); // id -> user
  const byEmail = new Map(); // email -> id
  const auth = authenticate(config.jwt);

  function addUser({ name, email, password, phone, role = 'citizen' }) {
    const normalized = email.trim().toLowerCase();
    if (byEmail.has(normalized)) throw conflict('An account with this email already exists');
    const now = new Date().toISOString();
    const user = {
      id: `usr_${crypto.randomUUID()}`,
      name: name.trim(),
      email: normalized,
      phone,
      role,
      passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
      createdAt: now,
    };
    users.set(user.id, user);
    byEmail.set(normalized, user.id);
    return user;
  }

  if (config.admin.email && config.admin.password) {
    addUser({ ...config.admin, role: 'admin' });
  }

  const registerRules = {
    name: [required, isString(2, 80)],
    email: [required, isEmail],
    password: [required, isString(8, 128)],
    phone: [required, isPhone],
  };

  app.post('/api/users/register', (req, res) => {
    validate(req.body, registerRules);
    // Everyone registers as a citizen; only an admin can grant officer/admin roles.
    const user = addUser({ ...req.body, role: 'citizen' });
    res.status(201).json({ user: toPublic(user), token: signToken(user, config.jwt), tokenType: 'Bearer' });
  });

  app.post('/api/users/login', async (req, res) => {
    validate(req.body, { email: [required, isEmail], password: [required, isString(1, 128)] });
    const user = users.get(byEmail.get(req.body.email.trim().toLowerCase()));
    const ok = await bcrypt.compare(req.body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Invalid email or password');
    res.json({
      token: signToken(user, config.jwt),
      tokenType: 'Bearer',
      expiresIn: config.jwt.expiresIn,
      user: toPublic(user),
    });
  });

  app.get('/api/users/me', auth, (req, res) => {
    const user = users.get(req.user.id);
    if (!user) throw notFound('User no longer exists');
    res.json(toPublic(user));
  });

  app.get('/api/users', auth, requireRole('admin'), (req, res) => {
    res.json({ count: users.size, users: [...users.values()].map(toPublic) });
  });

  app.patch('/api/users/:id/role', auth, requireRole('admin'), (req, res) => {
    validate(req.body, { role: [required, oneOf(ROLES)] });
    const user = users.get(req.params.id);
    if (!user) throw notFound('User not found');
    user.role = req.body.role;
    res.json(toPublic(user));
  });

  // Service-to-service lookup (used by the complaint service to find a phone number for SMS).
  app.get('/internal/users/:id', requireInternalKey(config.internalServiceKey), (req, res) => {
    const user = users.get(req.params.id);
    if (!user) throw notFound('User not found');
    res.json({ id: user.id, name: user.name, phone: user.phone, role: user.role });
  });

  return finalizeApp(app);
}
