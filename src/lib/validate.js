import { badRequest } from './errors.js';

// Minimal schema validation: each rule returns an error message or undefined.
// Collects every problem so the client can fix them all at once.
export function validate(body, rules) {
  const details = [];
  for (const [field, checks] of Object.entries(rules)) {
    for (const check of checks) {
      const message = check(body?.[field], field);
      if (message) {
        details.push({ field, message });
        break;
      }
    }
  }
  if (details.length) throw badRequest('Request validation failed', details);
}

export const required = (v, f) => (v === undefined || v === null || v === '' ? `${f} is required` : undefined);
export const optional = () => undefined;
export const isString = (min = 1, max = 500) => (v, f) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return `${f} must be a string`;
  const len = v.trim().length;
  if (len < min || len > max) return `${f} must be between ${min} and ${max} characters`;
  return undefined;
};
export const isEmail = (v, f) =>
  v !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)) ? `${f} must be a valid email address` : undefined;
// E.164 format, e.g. +919876543210 - the format SMS providers such as Twilio require.
export const isPhone = (v, f) =>
  v !== undefined && !/^\+[1-9]\d{7,14}$/.test(String(v))
    ? `${f} must be in international E.164 format, e.g. +919876543210`
    : undefined;
export const oneOf = (values) => (v, f) =>
  v !== undefined && !values.includes(v) ? `${f} must be one of: ${values.join(', ')}` : undefined;

export function parseNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`${field} must be a number between ${min} and ${max}`, [
      { field, message: `${field} must be a number between ${min} and ${max}` },
    ]);
  }
  return n;
}
