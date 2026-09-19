import { z } from 'zod';
import type { DashboardContext } from '../context.js';
import { handleJson, numberParam, sendJson } from '../http.js';
import type { Route } from '../router.js';
import type { RunController } from '../run-controller.js';
import { KNOWN_SOURCES } from '../run-controller.js';
import type { SseHub } from '../sse.js';
import { toRunDetailView, toRunSummaryView } from '../views/run.view.js';

const StartSchema = z.object({
  sources: z.array(z.enum(KNOWN_SOURCES)).optional(),
  noCloud: z.boolean().optional(),
  skipExport: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

const STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;

export function createRunRoutes(
  ctx: DashboardContext & { runner: RunController; sse: SseHub },
): Route[] {
  const { runner, sse, logger } = ctx;
  const runs = ctx.runRepository;

  return [
    // Literal paths first: a parameterised /api/runs/:id must never shadow them.
    {
      method: 'GET',
      path: '/api/runs/current',
      handle: async ({ res }) => sendJson(res, 200, runner.state()),
    },

    {
      method: 'GET',
      path: '/api/runs/events',
      handle: async ({ res, url }) =>
        sendJson(res, 200, { events: runner.events(numberParam(url.searchParams, 'after') ?? 0) }),
    },

    {
      method: 'GET',
      path: '/api/runs/stream',
      handle: async ({ req, res, url }) => {
        const cleanup = sse.add(res);

        // Replay whatever the client missed, so a reconnect loses no log lines.
        const lastId =
          Number(req.headers['last-event-id']) || numberParam(url.searchParams, 'after') || 0;
        for (const event of runner.events(lastId)) sse.send(res, event);

        const unsubscribe = runner.subscribe((event) => sse.send(res, event));
        res.on('close', () => {
          unsubscribe();
          cleanup();
        });

        // Deliberately never resolves: the response stays open until the client
        // disconnects or the server shuts every stream down.
        await new Promise<void>((resolve) => res.on('close', resolve));
      },
    },

    {
      method: 'POST',
      path: '/api/runs/cancel',
      handle: async ({ res }) => {
        if (!runner.cancel()) {
          sendJson(res, 409, { error: 'no run is in progress' });
          return;
        }
        sendJson(res, 200, { cancelling: true });
      },
    },

    {
      method: 'POST',
      path: '/api/runs',
      handle: handleJson(
        StartSchema,
        async (request, { res }) => {
          const result = runner.start(request);
          if (!result.started) {
            sendJson(res, 409, { error: result.reason ?? 'could not start a run' });
            return undefined;
          }
          logger.info('RUN', 'run started from the dashboard', { sources: request.sources });
          // 202: accepted and running; the outcome arrives on the stream.
          sendJson(res, 202, { started: true, ...runner.state() });
          return undefined;
        },
        { errorLabel: 'run request' },
      ),
    },

    {
      method: 'GET',
      path: '/api/runs',
      handle: async ({ res, url }) => {
        const statusParam = url.searchParams.get('status');
        const status = (STATUSES as readonly string[]).includes(statusParam ?? '')
          ? (statusParam as (typeof STATUSES)[number])
          : undefined;

        const limit = numberParam(url.searchParams, 'limit') ?? 20;
        const offset = numberParam(url.searchParams, 'offset') ?? 0;

        const [rows, total] = await Promise.all([
          runs.findAll({ limit, offset, status }),
          runs.count({ status }),
        ]);

        sendJson(res, 200, {
          runs: rows.map((row) => toRunSummaryView(row)),
          total,
          limit,
          offset,
        });
      },
    },

    {
      method: 'GET',
      path: /^\/api\/runs\/(\d{1,15})$/,
      handle: async ({ res, params }) => {
        const row = await runs.findById(params['1'] as string);
        if (!row) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, { run: toRunDetailView(row) });
      },
    },
  ];
}
