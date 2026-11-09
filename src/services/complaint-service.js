// Complaint service: creating complaints (geocoded), status workflow with SMS notifications,
// nearby search, and admin-only deletion.
import crypto from 'node:crypto';
import { authenticate, requireRole } from '../lib/auth.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { createServiceApp, finalizeApp } from '../lib/app.js';
import { distanceKm, round } from '../lib/geo.js';
import { isString, oneOf, parseNumber, required, validate } from '../lib/validate.js';
import { maskPhone } from '../integrations/sms.js';

export const CATEGORIES = ['pothole', 'garbage', 'streetlight', 'water', 'drainage', 'traffic', 'other'];
export const STATUSES = ['open', 'in_progress', 'resolved', 'rejected'];
// Allowed status changes. Resolved and rejected complaints are closed.
const TRANSITIONS = {
  open: ['in_progress', 'rejected'],
  in_progress: ['resolved', 'rejected'],
  resolved: [],
  rejected: [],
};
const STAFF = ['officer', 'admin'];

const publicView = (c, distance) => ({
  id: c.id,
  title: c.title,
  category: c.category,
  status: c.status,
  location: c.location,
  createdAt: c.createdAt,
  ...(distance !== undefined && { distanceKm: round(distance) }),
});

export function createComplaintService(config, { geocoder, sms }) {
  const app = createServiceApp('complaint-service', config);
  const complaints = new Map();
  const notifications = [];
  const auth = authenticate(config.jwt);

  function findOr404(id) {
    const complaint = complaints.get(id);
    if (!complaint) throw notFound('Complaint not found');
    return complaint;
  }

  async function lookupUser(userId) {
    const res = await fetch(`${config.serviceUrls.users}/internal/users/${encodeURIComponent(userId)}`, {
      headers: { 'x-internal-key': config.internalServiceKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`user-service returned HTTP ${res.status}`);
    return res.json();
  }

  async function notifyStatusChange(complaint, note) {
    const pretty = complaint.status.replace('_', ' ').toUpperCase();
    const body =
      `Smart City Portal: your complaint "${complaint.title}" (${complaint.id.slice(0, 12)}) is now ${pretty}.` +
      (note ? ` Note: ${note}` : '');
    const record = {
      id: `ntf_${crypto.randomUUID()}`,
      complaintId: complaint.id,
      channel: 'sms',
      body,
      createdAt: new Date().toISOString(),
    };
    try {
      const user = await lookupUser(complaint.userId);
      record.to = maskPhone(user.phone);
      Object.assign(record, await sms.send(user.phone, body));
    } catch (err) {
      Object.assign(record, { provider: sms.provider, status: 'failed', error: err.message });
    }
    notifications.push(record);
    return record;
  }

  app.use('/api/complaints', auth);

  const createRules = {
    title: [required, isString(5, 120)],
    description: [required, isString(10, 2000)],
    category: [required, oneOf(CATEGORIES)],
    address: [required, isString(3, 300)],
  };

  app.post('/api/complaints', async (req, res) => {
    validate(req.body, createRules);
    // Third-party call: address -> latitude/longitude (OpenStreetMap or Google).
    const location = await geocoder.geocode(req.body.address);
    const now = new Date().toISOString();
    const complaint = {
      id: `cmp_${crypto.randomUUID()}`,
      title: req.body.title.trim(),
      description: req.body.description.trim(),
      category: req.body.category,
      address: req.body.address.trim(),
      location,
      status: 'open',
      userId: req.user.id,
      history: [{ status: 'open', changedBy: req.user.id, note: 'Complaint created', at: now }],
      createdAt: now,
      updatedAt: now,
    };
    complaints.set(complaint.id, complaint);
    res.status(201).location(`/api/complaints/${complaint.id}`).json(complaint);
  });

  app.get('/api/complaints', (req, res) => {
    const { status, category } = req.query;
    validate({ status, category }, { status: [oneOf(STATUSES)], category: [oneOf(CATEGORIES)] });
    let list = [...complaints.values()];
    // Citizens see only their own complaints; officers and admins see everything.
    if (!STAFF.includes(req.user.role)) list = list.filter((c) => c.userId === req.user.id);
    if (status) list = list.filter((c) => c.status === status);
    if (category) list = list.filter((c) => c.category === category);
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ count: list.length, complaints: list });
  });

  // GET /api/complaints/nearby?lat=12.97&lng=77.59&radiusKm=2   (or ?address=MG Road, Bengaluru)
  app.get('/api/complaints/nearby', async (req, res) => {
    const radiusKm = req.query.radiusKm === undefined ? 2 : parseNumber(req.query.radiusKm, 'radiusKm', { min: 0.1, max: 50 });
    let center;
    if (req.query.address) {
      center = await geocoder.geocode(String(req.query.address));
    } else {
      center = {
        lat: parseNumber(req.query.lat, 'lat', { min: -90, max: 90 }),
        lng: parseNumber(req.query.lng, 'lng', { min: -180, max: 180 }),
      };
    }
    const nearby = [...complaints.values()]
      .map((c) => ({ c, d: distanceKm(center, c.location) }))
      .filter(({ d }) => d <= radiusKm)
      .sort((a, b) => a.d - b.d)
      // Public fields only: nearby results show civic issues, not who reported them.
      .map(({ c, d }) => publicView(c, d));
    res.json({ center, radiusKm, count: nearby.length, complaints: nearby });
  });

  app.get('/api/complaints/notifications', requireRole('admin'), (req, res) => {
    res.json({ provider: sms.provider, count: notifications.length, notifications: [...notifications].reverse() });
  });

  app.get('/api/complaints/:id', (req, res) => {
    const complaint = findOr404(req.params.id);
    if (!STAFF.includes(req.user.role) && complaint.userId !== req.user.id) {
      throw forbidden('You can only view your own complaints');
    }
    res.json(complaint);
  });

  app.patch('/api/complaints/:id/status', requireRole(...STAFF), async (req, res) => {
    validate(req.body, { status: [required, oneOf(STATUSES)], note: [isString(1, 300)] });
    const complaint = findOr404(req.params.id);
    const { status, note } = req.body;
    if (!TRANSITIONS[complaint.status].includes(status)) {
      throw conflict(
        `Cannot change status from "${complaint.status}" to "${status}". ` +
          `Allowed: ${TRANSITIONS[complaint.status].join(', ') || 'none (complaint is closed)'}`,
      );
    }
    const now = new Date().toISOString();
    complaint.status = status;
    complaint.updatedAt = now;
    complaint.history.push({ status, changedBy: req.user.id, note: note?.trim(), at: now });
    // Third-party call: SMS to the citizen who raised the complaint.
    const notification = await notifyStatusChange(complaint, note?.trim());
    res.json({
      complaint,
      notification: { id: notification.id, channel: 'sms', to: notification.to, provider: notification.provider, status: notification.status },
    });
  });

  app.delete('/api/complaints/:id', requireRole('admin'), (req, res) => {
    findOr404(req.params.id);
    complaints.delete(req.params.id);
    res.status(204).end();
  });

  return finalizeApp(app);
}
