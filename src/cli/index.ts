import { loadEnv } from '../config/env.js';
import { loadProfile } from '../config/profile.js';
import { createLogger } from '../util/logger.js';
import { connectDb } from '../db/connection.js';
import { runPipeline, markRunFailed } from '../pipeline/run.js';
import { createLocalProvider, createCloudProvider } from '../llm/factory.js';
import { buildSources, sourceQueries } from '../sources/registry.js';
import { normalizeJob } from '../pipeline/normalize.js';
import { deduplicateJobs } from '../pipeline/dedupe.js';
import { JobRepository } from '../db/job.repository.js';
import { rankJobs } from '../pipeline/rank.js';
import { writeCsv } from '../export/csv.js';
import { writeJson } from '../export/json.js';
import { printSummary } from './summary.js';
import { runModelsCommand } from './models.js';
import { startDashboard } from '../dashboard/server.js';
import { createConfigStore } from '../dashboard/config-store.js';
import type { RankedJob } from '../export/types.js';

type Command = 'run' | 'fetch' | 'match' | 'export' | 'models' | 'schedule' | 'dashboard' | 'help';

interface ParsedArgs {
  command: Command;
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand = 'run', ...rest] = argv;
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (const arg of rest) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    if (!key) continue;
    if (value === undefined) flags.add(key);
    else values.set(key, value);
  }

  const known: Command[] = [
    'run',
    'fetch',
    'match',
    'export',
    'models',
    'schedule',
    'dashboard',
    'help',
  ];
  const command = (known as string[]).includes(rawCommand) ? (rawCommand as Command) : 'help';
  return { command, flags, values };
}

const HELP = `
AI Job Finder — local-first job discovery

Usage: pnpm jobs:<command> [--flags]

Commands:
  run        Full pipeline: fetch → dedupe → filter → evaluate → export   (default)
  fetch      Fetch and persist jobs only; no LLM calls, no export
  match      Fetch and evaluate, but write no files
  export     Re-export recently seen jobs from the database without re-evaluating
  dashboard  Open the web dashboard to triage and track applications
  models     List models installed in Ollama (--select to choose and save one)
  schedule   Run on the JOB_RUN_CRON schedule until interrupted
  help       Show this message

Flags:
  --source=<name>   Override SOURCES_ENABLED for this run (e.g. --source=mock)
  --no-db           Run without the database; nothing is persisted or cached
  --no-cloud        Disable cloud escalation for this run
  --days=<n>        For \`export\`: how far back to look (default 7)
  --select          For \`models\`: prompt for a model and write it to .env
  --port=<n>        For \`dashboard\`: port to listen on (default 4321)
  --no-open         For \`dashboard\`: do not open a browser window
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    console.log(HELP);
    return 0;
  }

  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  // Per-run overrides, applied before anything reads the config.
  const effectiveEnv = {
    ...env,
    ...(args.values.has('source') ? { SOURCES_ENABLED: args.values.get('source') as string } : {}),
    ...(args.flags.has('no-cloud') ? { CLOUD_ESCALATION_ENABLED: false } : {}),
  };

  if (args.command === 'models') {
    return runModelsCommand(effectiveEnv, logger, { select: args.flags.has('select') });
  }

  if (args.command === 'schedule') {
    return runSchedule(effectiveEnv, logger, args);
  }

  let useDb = !args.flags.has('no-db');
  if (args.command === 'dashboard' && !useDb) {
    logger.error('ERROR', 'the dashboard is a view of the database — remove --no-db');
    return 1;
  }
  if (args.command === 'dashboard') useDb = true;

  let db: Awaited<ReturnType<typeof connectDb>> | null = null;

  if (useDb) {
    try {
      db = await connectDb(effectiveEnv.SQLITE_PATH, logger);
    } catch (err) {
      logger.error('DB', err instanceof Error ? err.message : String(err));
      logger.plain();
      logger.plain('Set SQLITE_PATH in .env, or re-run with --no-db to skip persistence.');
      return 1;
    }
  } else {
    logger.warn('DB', 'running without a database — no history, no caching, nothing persisted');
  }

  try {
    switch (args.command) {
      case 'fetch':
        return await commandFetch(effectiveEnv, logger, useDb);
      case 'export':
        return await commandExport(
          effectiveEnv,
          logger,
          useDb,
          Number(args.values.get('days') ?? 7),
        );
      case 'dashboard':
        return await commandDashboard(effectiveEnv, logger, args);
      case 'run':
      case 'match':
        return await commandRun(effectiveEnv, logger, useDb, args.command === 'match');
      default:
        console.log(HELP);
        return 0;
    }
  } finally {
    await db?.disconnect();
  }
}

async function commandRun(
  env: ReturnType<typeof loadEnv>,
  logger: ReturnType<typeof createLogger>,
  useDb: boolean,
  skipExport: boolean,
): Promise<number> {
  const profile = await loadProfile(env.PROFILE_PATH);

  logger.plain();
  logger.plain('Starting Job Finder...');

  await reportProviderHealth(env, logger);

  // Captured via onRunStarted so a crash can be recorded against the real run.
  // Passing null here used to make markRunFailed a no-op, which left every
  // failed run sitting at RUNNING in the database forever.
  let runId: string | null = null;

  try {
    const summary = await runPipeline({
      env,
      profile,
      logger,
      skipExport,
      skipPersistence: !useDb,
      onRunStarted: (id) => {
        runId = id;
      },
    });
    printSummary(summary, logger);
    return summary.errors.length > 0 ? 0 : 0;
  } catch (err) {
    logger.error('ERROR', 'run failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    await markRunFailed(runId, err);
    return 1;
  }
}

/** Fetch and store only — useful for building history without spending any LLM time. */
async function commandFetch(
  env: ReturnType<typeof loadEnv>,
  logger: ReturnType<typeof createLogger>,
  useDb: boolean,
): Promise<number> {
  const { sources, browser } = buildSources(env, logger);
  const queries = sourceQueries(env);
  const raw = [];

  for (const source of sources) {
    if (source.status === 'UNSUPPORTED') {
      logger.warn('FETCH', `${source.name}: unsupported, skipping`, { reason: source.notes });
      continue;
    }
    try {
      const jobs = await source.fetchJobs({ queries, maxPages: env.SCRAPE_MAX_PAGES });
      logger.info('FETCH', `${source.name}: ${jobs.length} jobs`);
      raw.push(...jobs);
    } catch (err) {
      logger.error('FETCH', `${source.name} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await browser?.close();

  const normalized = [];
  for (const job of raw) {
    try {
      normalized.push(normalizeJob(job));
    } catch {
      /* already counted as unusable */
    }
  }

  const { jobs: deduped } = deduplicateJobs(normalized);
  logger.plain();
  logger.plain(`Fetched ${raw.length} jobs, ${deduped.length} after deduplication.`);

  if (useDb) {
    const repository = new JobRepository();
    const results = await repository.upsertMany(deduped);
    const created = results.filter((r) => r.state === 'NEW').length;
    const changed = results.filter((r) => r.state === 'CHANGED').length;
    logger.plain(
      `Persisted: ${created} new, ${changed} changed, ${results.length - created - changed} unchanged.`,
    );
  }
  logger.plain();
  return 0;
}

/** Re-export what is already in the database, with no LLM calls at all. */
async function commandExport(
  env: ReturnType<typeof loadEnv>,
  logger: ReturnType<typeof createLogger>,
  useDb: boolean,
  days: number,
): Promise<number> {
  if (!useDb) {
    logger.error('EXPORT', 'export needs the database; remove --no-db');
    return 1;
  }

  const repository = new JobRepository();
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  const jobs = await repository.findRecentJobs(since);

  if (jobs.length === 0) {
    logger.plain(`No jobs seen in the last ${days} days. Run \`pnpm jobs:run\` first.`);
    return 0;
  }

  const evaluations = await repository.latestEvaluations(jobs.map((j) => j.id));
  const ranked: RankedJob[] = rankJobs(
    jobs
      .map<RankedJob | null>((job) => {
        const evaluation = evaluations.get(job.id);
        return evaluation ? { job, evaluation, isNew: job.isNew } : null;
      })
      .filter((item): item is RankedJob => item !== null),
  );

  if (ranked.length === 0) {
    logger.plain('Jobs found, but none have been evaluated yet. Run `pnpm jobs:run`.');
    return 0;
  }

  const csvPath = await writeCsv(ranked, env.OUTPUT_DIR);
  const jsonPath = await writeJson(
    ranked,
    {
      generatedAt: new Date().toISOString(),
      totalJobs: ranked.length,
      newJobs: ranked.filter((r) => r.isNew).length,
      localModel: env.OLLAMA_MODEL,
      cloudModel: null,
      cloudRequests: 0,
      estimatedCloudCost: 0,
    },
    env.OUTPUT_DIR,
  );

  logger.plain();
  logger.plain(`Exported ${ranked.length} evaluated jobs from the last ${days} days:`);
  logger.plain(`  ${csvPath}`);
  logger.plain(`  ${jsonPath}`);
  logger.plain();
  return 0;
}

/**
 * Serve the dashboard until interrupted. The database connection is held open by
 * the caller's `finally`, so the server can query for as long as it runs.
 */
async function commandDashboard(
  env: ReturnType<typeof loadEnv>,
  logger: ReturnType<typeof createLogger>,
  args: ParsedArgs,
): Promise<number> {
  const port = Number(args.values.get('port') ?? env.DASHBOARD_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    logger.error('ERROR', 'invalid port', { port: args.values.get('port') });
    return 1;
  }

  let dashboard: Awaited<ReturnType<typeof startDashboard>>;
  try {
    const config = await createConfigStore({ envPath: '.env', fallback: env, logger });
    dashboard = await startDashboard({ port, logger, config });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EADDRINUSE') {
      logger.error('ERROR', `port ${port} is already in use`, {
        hint: 'pass --port=<n> to use a different one',
      });
      return 1;
    }
    throw err;
  }

  logger.plain();
  logger.plain(`  Job Finder dashboard  →  ${dashboard.url}`);
  logger.plain();
  logger.plain('  Bound to localhost only. Press Ctrl+C to stop.');
  logger.plain();

  if (!args.flags.has('no-open') && process.platform === 'darwin') {
    const { spawn } = await import('node:child_process');
    spawn('open', [dashboard.url], { stdio: 'ignore', detached: true }).unref();
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      logger.plain('\nStopping dashboard...');
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  await dashboard.close();
  return 0;
}

async function runSchedule(
  env: ReturnType<typeof loadEnv>,
  logger: ReturnType<typeof createLogger>,
  args: ParsedArgs,
): Promise<number> {
  const { schedule, validate } = await import('node-cron');

  if (!validate(env.JOB_RUN_CRON)) {
    logger.error('RUN', 'JOB_RUN_CRON is not a valid cron expression', { value: env.JOB_RUN_CRON });
    return 1;
  }

  logger.plain();
  logger.plain(`Scheduler started. Running on "${env.JOB_RUN_CRON}". Ctrl+C to stop.`);
  logger.plain('Manual runs with `pnpm jobs:run` continue to work independently.');
  logger.plain();

  const useDb = !args.flags.has('no-db');
  let running = false;

  schedule(env.JOB_RUN_CRON, async () => {
    if (running) {
      logger.warn('RUN', 'previous scheduled run still in progress — skipping this tick');
      return;
    }
    running = true;
    let db: Awaited<ReturnType<typeof connectDb>> | null = null;
    try {
      if (useDb) {
        db = await connectDb(env.SQLITE_PATH, logger);
      }
      const profile = await loadProfile(env.PROFILE_PATH);
      const summary = await runPipeline({ env, profile, logger, skipPersistence: !useDb });
      printSummary(summary, logger);
    } catch (err) {
      logger.error('ERROR', 'scheduled run failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await db?.disconnect();
      running = false;
    }
  });

  // Keep the process alive for the scheduler.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      logger.plain('\nScheduler stopped.');
      resolve();
    });
  });
  return 0;
}

async function reportProviderHealth(
  env: ReturnType<typeof loadEnv>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const local = createLocalProvider(env);
  const healthy = await local.healthCheck();

  if (!healthy) {
    logger.warn('LOCAL-LLM', `model "${env.OLLAMA_MODEL}" is not available in Ollama`, {
      hint: `run \`ollama pull ${env.OLLAMA_MODEL}\`, or \`pnpm jobs:models\` to see what is installed`,
    });
  } else {
    logger.info('LOCAL-LLM', 'ready', { model: env.OLLAMA_MODEL, baseUrl: env.OLLAMA_BASE_URL });
  }

  const cloud = createCloudProvider(env, logger);
  if (cloud) {
    logger.info('CLOUD-LLM', 'escalation available', {
      provider: cloud.name,
      model: cloud.model,
    });
  } else {
    logger.info('CLOUD-LLM', 'escalation unavailable — running local-only');
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
