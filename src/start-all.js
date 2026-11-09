// Starts the three services and the gateway. Each is a separate Express app on its own port,
// as in a microservice setup; they run in one process here so the project needs only one
// command locally and one web service on Render. Only the gateway port is public.
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createGateway } from './gateway/gateway.js';
import { createGeocoder } from './integrations/geocoder.js';
import { createSmsClient } from './integrations/sms.js';
import { createComplaintService } from './services/complaint-service.js';
import { createGeoService } from './services/geo-service.js';
import { createUserService } from './services/user-service.js';

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
}

export async function startAll(config = loadConfig(), { geocoderOptions } = {}) {
  const geocoder = createGeocoder(config.geocoder, geocoderOptions);
  const sms = createSmsClient(config.sms);
  // Internal services bind to localhost only; the gateway listens on all interfaces.
  const servers = {
    users: await listen(createUserService(config), config.ports.users, '127.0.0.1'),
    complaints: await listen(createComplaintService(config, { geocoder, sms }), config.ports.complaints, '127.0.0.1'),
    geo: await listen(createGeoService(config, { geocoder }), config.ports.geo, '127.0.0.1'),
  };
  servers.gateway = await listen(createGateway(config), config.gatewayPort);
  return {
    servers,
    geocoder,
    sms,
    async stop() {
      await Promise.all(Object.values(servers).map((s) => new Promise((r) => s.close(r))));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = loadConfig();
    const { stop } = await startAll(config);
    console.log(`
Smart City Portal is running
  Gateway      http://localhost:${config.gatewayPort}
  Swagger UI   http://localhost:${config.gatewayPort}/docs
  ReDoc        http://localhost:${config.gatewayPort}/redoc
  Services     users :${config.ports.users}  complaints :${config.ports.complaints}  geo :${config.ports.geo}
  Geocoder     ${config.geocoder.provider}    SMS ${config.sms.provider}
`);
    const shutdown = async () => {
      await stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
