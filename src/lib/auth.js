// JWT helpers shared by all services. Tokens are issued by the user service and verified
// locally by every service with the same secret, so no service has to call another one
// just to check a token.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { forbidden, unauthorized } from './errors.js';

export const ROLES = Object.freeze(['citizen', 'officer', 'admin']);

export function signToken(user, jwtConfig) {
  return jwt.sign({ role: user.role, name: user.name }, jwtConfig.secret, {
    subject: user.id,
    expiresIn: jwtConfig.expiresIn,
    issuer: jwtConfig.issuer,
    algorithm: 'HS256',
  });
}

export function authenticate(jwtConfig) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return next(unauthorized('Missing bearer token. Send "Authorization: Bearer <token>"'));
    }
    try {
      const payload = jwt.verify(token, jwtConfig.secret, {
        issuer: jwtConfig.issuer,
        algorithms: ['HS256'],
      });
      req.user = { id: payload.sub, role: payload.role, name: payload.name };
      return next();
    } catch (err) {
      const message = err.name === 'TokenExpiredError' ? 'Token has expired' : 'Invalid token';
      return next(unauthorized(message));
    }
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action requires one of these roles: ${roles.join(', ')}`));
    }
    return next();
  };
}

// Guards /internal/* routes used for service-to-service calls.
export function requireInternalKey(internalServiceKey) {
  const expected = Buffer.from(internalServiceKey);
  return (req, res, next) => {
    const given = Buffer.from(req.get('x-internal-key') || '');
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    return ok ? next() : next(forbidden('Internal route'));
  };
}
