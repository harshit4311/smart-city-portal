// Central configuration. Every secret comes from environment variables (.env locally,
// the dashboard on Render/Railway in production) and is never hard-coded or committed.
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const env = process.env;

function list(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(...overrides) {
  const nodeEnv = env.NODE_ENV || 'development';
  const config = {
    nodeEnv,
    gatewayPort: int(env.PORT, 8080),
    ports: {
      users: int(env.USER_SERVICE_PORT, 4001),
      complaints: int(env.COMPLAINT_SERVICE_PORT, 4002),
      geo: int(env.GEO_SERVICE_PORT, 4003),
    },
    serviceUrls: {
      users: env.USER_SERVICE_URL || `http://127.0.0.1:${int(env.USER_SERVICE_PORT, 4001)}`,
      complaints: env.COMPLAINT_SERVICE_URL || `http://127.0.0.1:${int(env.COMPLAINT_SERVICE_PORT, 4002)}`,
      geo: env.GEO_SERVICE_URL || `http://127.0.0.1:${int(env.GEO_SERVICE_PORT, 4003)}`,
    },
    jwt: {
      secret: env.JWT_SECRET,
      expiresIn: env.JWT_EXPIRES_IN || '1h',
      issuer: 'smart-city-portal',
    },
    // Shared secret that services use when calling each other's /internal routes.
    // The gateway never routes /internal/*, so these routes are not reachable from outside.
    internalServiceKey: env.INTERNAL_SERVICE_KEY,
    gateway: {
      apiKeys: list(env.API_KEYS),
      rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_MS, 60_000),
      rateLimitMax: int(env.RATE_LIMIT_MAX, 100),
      authRateLimitMax: int(env.AUTH_RATE_LIMIT_MAX, 10),
      corsOrigins: list(env.CORS_ORIGINS),
      // Number of reverse proxies in front of the gateway (Render/Railway/Heroku: 1).
      // Needed so rate limiting sees the real client IP instead of the proxy's.
      trustProxy: int(env.TRUST_PROXY, 0),
    },
    admin: {
      name: env.ADMIN_NAME || 'City Admin',
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      phone: env.ADMIN_PHONE || '+919999999999',
    },
    geocoder: {
      provider: env.GEOCODER_PROVIDER || 'nominatim', // nominatim | google | mock
      nominatimBaseUrl: env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org',
      // OpenStreetMap's usage policy requires an identifying User-Agent.
      userAgent: env.NOMINATIM_USER_AGENT || 'SmartCityPortal/2.0 (BITS student project)',
      countryCodes: env.GEOCODER_COUNTRY_CODES || '',
      googleApiKey: env.GOOGLE_MAPS_API_KEY,
      googleBaseUrl: env.GOOGLE_MAPS_BASE_URL || 'https://maps.googleapis.com',
      timeoutMs: int(env.GEOCODER_TIMEOUT_MS, 8000),
    },
    sms: {
      provider: env.SMS_PROVIDER || 'mock', // mock | twilio
      twilioAccountSid: env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: env.TWILIO_AUTH_TOKEN,
      twilioFromNumber: env.TWILIO_FROM_NUMBER,
      twilioBaseUrl: env.TWILIO_BASE_URL || 'https://api.twilio.com',
    },
    logRequests: env.LOG_REQUESTS !== 'false',
  };
  for (const o of overrides) deepMerge(config, o);
  validate(config);
  return config;
}

// Lets tests override single nested settings, e.g. { gateway: { rateLimitMax: 3 } }.
function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const isObject = value && typeof value === 'object' && !Array.isArray(value);
    if (isObject && target[key] && typeof target[key] === 'object') deepMerge(target[key], value);
    else target[key] = value;
  }
  return target;
}

// Fail fast on missing or weak secrets instead of silently running with insecure defaults.
function validate(config) {
  const problems = [];
  if (!config.jwt.secret || config.jwt.secret.length < 32) {
    problems.push('JWT_SECRET must be set and at least 32 characters long');
  }
  if (!config.internalServiceKey || config.internalServiceKey.length < 16) {
    problems.push('INTERNAL_SERVICE_KEY must be set and at least 16 characters long');
  }
  if (config.gateway.apiKeys.length === 0) {
    problems.push('API_KEYS must contain at least one key (comma-separated)');
  }
  if (config.sms.provider === 'twilio') {
    for (const k of ['twilioAccountSid', 'twilioAuthToken', 'twilioFromNumber']) {
      if (!config.sms[k]) problems.push(`SMS_PROVIDER=twilio requires ${k.replace('twilio', 'TWILIO_').toUpperCase()}`);
    }
  }
  if (config.geocoder.provider === 'google' && !config.geocoder.googleApiKey) {
    problems.push('GEOCODER_PROVIDER=google requires GOOGLE_MAPS_API_KEY');
  }
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}\nCopy .env.example to .env and fill in the values.`);
  }
}
