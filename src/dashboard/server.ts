import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardRepository } from '../db/dashboard.repository.js';
import { RunRepository } from '../db/run.repository.js';
import type { Logger } from '../util/logger.js';
import type { ConfigStore } from './config-store.js';
import { createPaths, type DashboardContext, type DashboardPathOverrides } from './context.js';
import { BIND_HOST, MIME, isAllowedOrigin, resolveWithin, sendJson } from './http.js';
import { allowedMethods, matchRoute, type Route } from './router.js';
import { createJobRoutes } from './routes/jobs.routes.js';
import { createProfileRoutes } from './routes/profile.routes.js';
import { createRunRoutes } from './routes/runs.routes.js';
import { createSettingsRoutes } from './routes/settings.routes.js';
import { createRunController, type RunController } from './run-controller.js';
import { SseHub } from './sse.js';

export { BIND_HOST } from './http.js';
export { filtersFromQuery } from './routes/jobs.routes.js';

/** Methods that change something and therefore need the cross-site check. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface DashboardServerOptions {
  port: number;
  logger: Logger;
  /** Owns .env; handlers read the live config through it rather than a snapshot. */
  config: ConfigStore;
  /** Test seam: redirect the files the dashboard reads and writes. */
  paths?: DashboardPathOverrides;
  repository?: DashboardRepository;
  runRepository?: RunRepository;
  /** Test seam: supply a controller that does not run the real pipeline. */
  runner?: RunController;
  /** Override for tests; defaults to the bundled public/ directory. */
  publicDir?: string;
}

export interface RunningDashboard {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

function defaultPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'public');
}

export async function startDashboard(options: DashboardServerOptions): Promise<RunningDashboard> {
  const repository = options.repository ?? new DashboardRepository();
  const publicDir = options.publicDir ?? defaultPublicDir();
  const { logger } = options;

  const paths = createPaths(options.config, options.paths);
  const runRepository = options.runRepository ?? new RunRepository();

  const context: DashboardContext = {
    config: options.config,
    paths,
    logger,
    repository,
    runRepository,
  };

  const sse = new SseHub();
  const runner =
    options.runner ??
    createRunController({ config: options.config, logger, profileFile: paths.profileFile });

  const routes: Route[] = [
    ...createJobRoutes({ repository, logger }),
    ...createSettingsRoutes(context),
    ...createProfileRoutes(context),
    ...createRunRoutes({ ...context, runner, sse }),
  ];

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error('ERROR', 'dashboard request failed', {
        url: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${BIND_HOST}:${boundPort()}`);
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (MUTATING.has(method) && !isAllowedOrigin(req.headers.origin, boundPort())) {
      logger.warn('ERROR', 'rejected a cross-site request', {
        origin: req.headers.origin,
        url: req.url,
      });
      sendJson(res, 403, { error: 'cross-site requests are not allowed' });
      return;
    }

    const match = matchRoute(routes, method, pathname);

    if (match === 'method-not-allowed') {
      res.setHeader('Allow', allowedMethods(routes, pathname).join(', '));
      sendJson(res, 405, { error: `${method} is not allowed on this path` });
      return;
    }

    if (match) {
      await match.route.handle({ req, res, url, params: match.params });
      return;
    }

    if (method === 'GET') {
      await serveStatic(pathname, publicDir, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Explicitly loopback: passing no host would bind every interface and put
    // this on the local network.
    server.listen(options.port, BIND_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  function boundPort(): number {
    const address = server.address();
    return typeof address === 'object' && address ? address.port : options.port;
  }

  const port = boundPort();

  return {
    server,
    port,
    url: `http://${BIND_HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // An open SSE response keeps its socket alive forever, so without this
        // server.close() never calls back: Ctrl-C hangs, and so do the tests.
        sse.closeAll();
        server.close(() => resolve());
        server.closeIdleConnections?.();

        // Last resort for a client that ignores the FIN, so shutdown is bounded.
        const giveUp = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 1000);
        giveUp.unref?.();
      }),
  };
}

async function serveStatic(
  pathname: string,
  publicDir: string,
  res: ServerResponse,
): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = resolveWithin(publicDir, relative);

  if (!resolved) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  if (!existsSync(resolved)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const body = await readFile(resolved);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}
