import express, { type Express } from 'express';
import { registerSonosAuthRoute } from '../routes/SonosAuthRoute.ts';
import { registerSonosTestToneRoute, registerSonosTopologyRoutes } from '../routes/SonosDiscoveryRoute.ts';

export function createSonosBridgeApp(): Express {
  const app = express();
  const allowedOrigins = new Set([
    'http://localhost:5173', 'http://127.0.0.1:5173',
    process.env.CLIENT_ORIGIN?.trim().replace(/\/+$/, ''),
  ].filter((origin): origin is string => Boolean(origin)));

  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      response.header('Access-Control-Allow-Origin', origin);
      response.header('Vary', 'Origin');
      response.header('Access-Control-Allow-Headers', 'Content-Type');
      response.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') { response.sendStatus(204); return; }
    next();
  });

  app.get('/api/health', (_request, response) => response.json({
    ok: true, service: 'sacscape-sonos-bridge',
  }));
  registerSonosAuthRoute(app);
  registerSonosTopologyRoutes(app);
  registerSonosTestToneRoute(app);
  return app;
}
