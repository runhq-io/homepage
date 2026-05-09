/**
 * Unified server entry point.
 *
 * Hosts both Next.js (pages + OAuth) and Hono (REST API + WebSocket) in a
 * single Node.js process on a single port.
 *
 * Routing:
 *   /api/auth/*           → Next.js (auth endpoints)
 *   /api/*                → Hono (80+ REST endpoints)
 *   /health               → Hono
 *   /billing/*            → Hono
 *   /oauth/*              → Hono (OAuth 2.0 endpoints)
 *   ws:// (upgrade)       → WebSocket server
 *   /*                    → Next.js (pages, SSR)
 */

// Load environment variables FIRST — ESM executes imports in declaration order,
// so this must come before any module that reads process.env at load time.
import './env';

import * as http from 'node:http';
import * as path from 'node:path';
import { db } from './db/index';
import { runSeeds } from './db/seed';
import { createHttpApp } from './api/HttpServer';
import { RunHQWebSocketServer } from './api/WebSocketServer';
import { registerWsHandlers } from './api/wsHandlers';
import { initProviders } from './api/services/providers/registry';
import * as MachineUsageService from './api/services/MachineUsageService';
import * as ServerService from './api/services/ServerService';
import { registerCronSyncRoute } from './api/internal/cron-sync';
import { WorkflowCronScheduler } from './api/services/WorkflowCronScheduler';
import { ServerRegistry } from './api/services/ServerRegistry';
import { widgetSecretCrypto } from './lib/widgetSecretCrypto';

const PORT = parseInt(process.env.PORT || '8080', 10);

async function main() {
  console.log('[be] Starting unified server...');

  // ── Required-secret invariants ────────────────────────────────────────
  // In production every widget JWT signing secret must be encrypted at
  // rest. Refusing to start without the encryption key is the only way to
  // make sure no deploy ever falls back to plaintext writes silently.
  if (process.env.NODE_ENV === 'production' && !widgetSecretCrypto.isConfigured()) {
    console.error('[be] WIDGET_SECRET_ENCRYPTION_KEY is required in production. Exiting.');
    process.exit(1);
  }
  if (!widgetSecretCrypto.isConfigured()) {
    console.warn('[be] WIDGET_SECRET_ENCRYPTION_KEY is not set — widget signing secrets will be stored as plaintext (dev/test only).');
  }

  // ── Database ──────────────────────────────────────────────────────────
  try {
    await (db as any).execute('SELECT 1');
    console.log('[be] Database connected');
    await runSeeds();
  } catch (error) {
    console.error('[be] Database connection failed:', error);
  }

  // ── Infrastructure providers ──────────────────────────────────────────
  initProviders();

  // ── Billing tick (every 5 min) ────────────────────────────────────────
  setInterval(() => {
    MachineUsageService.tickBilling().catch(console.error);
  }, 5 * 60 * 1000);
  MachineUsageService.tickBilling().catch(console.error);

  // ── Auto-suspend check (every 1 min) ──────────────────────────────────
  setInterval(() => {
    ServerService.checkAutoSuspend().catch(console.error);
  }, 60 * 1000);

  // ── Hono app (API routes) ────────────────────────────────────────────
  const honoApp = createHttpApp();

  // ── Workflow cron subsystem (feature-gated) ───────────────────────────
  const WORKFLOWS_V1 = process.env.WORKFLOWS_V1 === 'true' || process.env.WORKFLOWS_V1 === '1';
  let cronScheduler: WorkflowCronScheduler | null = null;

  if (WORKFLOWS_V1) {
    const serverRegistry = new ServerRegistry(db);

    registerCronSyncRoute(honoApp, {
      db,
      getServerToken: (serverId) => serverRegistry.getServerToken(serverId),
    });

    cronScheduler = new WorkflowCronScheduler({
      db,
      serverRegistry,
    });
    cronScheduler.start();

    console.log('[workflow] cron subsystem wired (WORKFLOWS_V1=true)');
  }

  // ── Next.js app ──────────────────────────────────────────────────────
  // Dynamic import so the server-only modules don't fail during tsc
  const next = (await import('next')).default;
  const nextApp = next({
    dev: process.env.NODE_ENV !== 'production',
    dir: path.resolve(import.meta.dirname ?? '.', '..'),
    port: PORT,
  });
  await nextApp.prepare();
  const nextHandler = nextApp.getRequestHandler();

  // ── WebSocket server (noServer mode) ─────────────────────────────────
  const wsServer = new RunHQWebSocketServer({ noServer: true });
  registerWsHandlers(wsServer);

  // ── HTTP server with routing ─────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // Routes that go to Next.js:
    //   /api/auth/*   (auth endpoints: login, register, me, web-me, web-token, device)
    //   /api/admin/usage/csv  (streaming CSV export — uses Next.js session auth)
    //   /_next/*      (Next.js assets)
    //   /login, /auth/*, /join/*, /admin/*, /(dashboard)/*
    //   Everything not matched by Hono patterns below
    const isNextAuthRoute = url.startsWith('/api/auth/'); // legacy variable name; routes auth endpoints to Next.js
    const isNextAdminCsvRoute = url.startsWith('/api/admin/usage/csv');
    const isNextAsset = url.startsWith('/_next/');

    // Routes that go to Hono:
    //   /api/* (except /api/auth/* and /api/admin/usage/csv)
    //   /health
    //   /billing/*
    //   /oauth/*
    //   /widget.js  — must go to Hono so the route handler can prepend
    //                 window.__RW_CONSTANTS__ before serving the file. If
    //                 it falls through to Next.js, public/widget.js is
    //                 served raw and the status registry is missing
    //                 (regression: status_change events fall back to
    //                 the generic "changed status" label).
    const isHonoApiRoute = url.startsWith('/api/') && !isNextAuthRoute && !isNextAdminCsvRoute;
    const isHonoRoute = isHonoApiRoute || url.startsWith('/health') || url.startsWith('/billing/') || url.startsWith('/oauth/') || url === '/widget.js' || url.startsWith('/widget.js?');

    if (isHonoRoute) {
      // Convert Node.js IncomingMessage to a Fetch API Request for Hono
      try {
        const protocol = 'http';
        const host = req.headers.host || `localhost:${PORT}`;
        const fetchUrl = `${protocol}://${host}${url}`;

        // Collect body for non-GET/HEAD requests
        let body: Buffer | undefined;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          body = Buffer.concat(chunks);
        }

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) {
            if (Array.isArray(value)) {
              value.forEach(v => headers.append(key, v));
            } else {
              headers.set(key, value);
            }
          }
        }

        const fetchReq = new Request(fetchUrl, {
          method: req.method,
          headers,
          body,
          // @ts-expect-error duplex is needed for streaming
          duplex: 'half',
        });

        const honoRes = await honoApp.fetch(fetchReq);

        // Write Hono response back to Node.js response
        res.writeHead(honoRes.status, Object.fromEntries(honoRes.headers.entries()));
        if (honoRes.body) {
          const reader = honoRes.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };
          await pump();
        } else {
          res.end();
        }
      } catch (err) {
        console.error('[be] Hono request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    } else {
      // Everything else goes to Next.js
      nextHandler(req, res);
    }
  });

  // ── WebSocket upgrade handling ────────────────────────────────────────
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    // Only upgrade requests to /ws (or root for backwards compat)
    if (url === '/ws' || url.startsWith('/ws?') || url === '/') {
      wsServer.handleUpgrade(req, socket, head);
    } else {
      // Let Next.js handle its own upgrades (HMR in dev)
      if (url.startsWith('/_next/')) {
        nextApp.getUpgradeHandler()(req, socket, head);
      } else {
        socket.destroy();
      }
    }
  });

  // ── Start listening ──────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`[be] Server ready on http://localhost:${PORT}`);
    console.log(`[be]   Next.js pages: http://localhost:${PORT}/`);
    console.log(`[be]   API endpoints: http://localhost:${PORT}/api/`);
    console.log(`[be]   WebSocket:     ws://localhost:${PORT}/ws`);
    console.log(`[be]   Health check:  http://localhost:${PORT}/health`);
  });

  // ── Graceful shutdown ────────────────────────────────────────────────
  const shutdown = () => {
    console.log('\n[be] Shutting down...');
    cronScheduler?.stop();
    server.close();
    wsServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[be] Failed to start server:', error);
  process.exit(1);
});
