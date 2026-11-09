// API Gateway: the single public entry point.
//
//   /api/users/*       -> user service
//   /api/complaints/*  -> complaint service
//   /api/maps/*        -> geo service
//
// Responsibilities: API key verification, rate limiting, request IDs, CORS, security
// headers, and serving the OpenAPI docs. JWTs are passed through and verified by each service.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { notFoundHandler, sendError } from '../lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.join(here, '../../docs/openapi.yaml');

export const ROUTES = [
  { prefix: '/api/users', service: 'users' },
  { prefix: '/api/complaints', service: 'complaints' },
  { prefix: '/api/maps', service: 'geo' },
];

export function createGateway(config) {
  const app = express();
  const { gateway } = config;
  app.disable('x-powered-by');
  app.set('trust proxy', gateway.trustProxy);

  app.use((req, res, next) => {
    const id = req.get('x-request-id') || crypto.randomUUID();
    req.headers['x-request-id'] = id;
    res.set('x-request-id', id);
    next();
  });
  // Locally the gateway runs on plain HTTP, so only ask browsers to upgrade to HTTPS in production.
  const upgradeInsecureRequests = config.nodeEnv === 'production' ? [] : null;
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests } } }));
  app.use(cors({ origin: gateway.corsOrigins.length ? gateway.corsOrigins : true, exposedHeaders: ['x-request-id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'] }));
  if (config.logRequests) app.use(morgan('[gateway] :method :url :status :response-time ms'));

  // ---- Public routes (no API key) ------------------------------------------------------
  app.get('/', (req, res) =>
    res.json({
      name: 'Smart City Portal API Gateway',
      docs: { swaggerUi: '/docs', redoc: '/redoc', openapiJson: '/openapi.json', openapiYaml: '/openapi.yaml' },
      health: '/health',
      routes: Object.fromEntries(ROUTES.map((r) => [`${r.prefix}/*`, `${r.service} service`])),
    }),
  );

  app.get('/health', async (req, res) => {
    const checks = await Promise.all(
      ROUTES.map(async ({ service }) => {
        try {
          const r = await fetch(`${config.serviceUrls[service]}/health`, { signal: AbortSignal.timeout(2000) });
          return [service, r.ok ? 'ok' : `HTTP ${r.status}`];
        } catch {
          return [service, 'unreachable'];
        }
      }),
    );
    const services = Object.fromEntries(checks);
    const healthy = Object.values(services).every((s) => s === 'ok');
    res.status(healthy ? 200 : 503).json({ gateway: 'ok', services });
  });

  const spec = YAML.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
  app.get('/openapi.json', (req, res) => res.json(spec));
  app.get('/openapi.yaml', (req, res) => res.type('text/yaml').sendFile(OPENAPI_PATH));
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Smart City Portal API Docs',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );
  app.get('/redoc', (req, res) => {
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://cdn.redoc.ly blob:; worker-src blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:",
    );
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Smart City Portal API - ReDoc</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><redoc spec-url="/openapi.json"></redoc><script src="https://cdn.redoc.ly/redoc/v2.5.0/bundles/redoc.standalone.js"></script></body></html>`);
  });

  // ---- API key verification ------------------------------------------------------------
  const validKeys = gateway.apiKeys.map((k) => Buffer.from(k));
  function verifyApiKey(req, res, next) {
    const given = req.get('x-api-key');
    if (!given) {
      return sendError(res, 401, 'API_KEY_MISSING', 'Send your API key in the "x-api-key" header');
    }
    const buf = Buffer.from(given);
    const ok = validKeys.some((k) => k.length === buf.length && crypto.timingSafeEqual(k, buf));
    if (!ok) return sendError(res, 403, 'API_KEY_INVALID', 'The API key is not valid');
    // Short, non-secret fingerprint so the rate limiter and logs never store the raw key.
    req.apiKeyId = crypto.createHash('sha256').update(given).digest('hex').slice(0, 12);
    return next();
  }

  // ---- Rate limiting -------------------------------------------------------------------
  const rateLimitHandler = (req, res, next, options) =>
    sendError(res, 429, 'RATE_LIMITED', `Too many requests. Limit is ${options.limit} per ${options.windowMs / 1000}s; retry after the time in the Retry-After header.`);

  // Brute-force protection for credentials: counted per client IP.
  const authLimiter = rateLimit({
    windowMs: gateway.rateLimitWindowMs,
    limit: gateway.authRateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
    identifier: 'auth',
  });
  // General quota: counted per API key.
  const apiLimiter = rateLimit({
    windowMs: gateway.rateLimitWindowMs,
    limit: gateway.rateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `key:${req.apiKeyId}`,
    handler: rateLimitHandler,
    identifier: 'api',
  });

  app.use('/api', verifyApiKey, apiLimiter);
  app.use(['/api/users/login', '/api/users/register'], authLimiter);

  // ---- Routing to services -------------------------------------------------------------
  for (const { prefix, service } of ROUTES) {
    app.use(
      createProxyMiddleware({
        target: config.serviceUrls[service],
        pathFilter: prefix,
        changeOrigin: true,
        xfwd: true,
        proxyTimeout: 15_000,
        on: {
          proxyReq(proxyReq) {
            // The API key is a gateway concern; downstream services never receive it.
            proxyReq.removeHeader('x-api-key');
          },
          proxyRes(proxyRes) {
            proxyRes.headers['x-served-by'] = `${service}-service`;
          },
          error(err, req, res) {
            if (typeof res.status !== 'function' || res.headersSent) return;
            sendError(res, 502, 'SERVICE_UNAVAILABLE', `The ${service} service is not reachable right now`);
          },
        },
      }),
    );
  }

  app.use(notFoundHandler);
  return app;
}
