// Common Express setup shared by the three services.
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { errorHandler, notFoundHandler } from './errors.js';

export function createServiceApp(name, config) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet());
  app.use((req, res, next) => {
    // Reuse the gateway's request ID so one request can be traced across services.
    const id = req.get('x-request-id') || crypto.randomUUID();
    req.headers['x-request-id'] = id;
    res.set('x-request-id', id);
    next();
  });
  if (config.logRequests) app.use(morgan(`[${name}] :method :url :status :response-time ms`));
  app.use(express.json({ limit: '100kb' }));
  app.get('/health', (req, res) => res.json({ service: name, status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));
  return app;
}

export function finalizeApp(app) {
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
