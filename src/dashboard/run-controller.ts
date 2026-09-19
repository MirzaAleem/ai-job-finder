import { loadProfile, ProfileNotFoundError, ProfileValidationError } from '../config/profile.js';
import { enabledSources, type Env } from '../config/env.js';
import { markRunFailed, runPipeline, type RunProgress, type RunSummary } from '../pipeline/run.js';
import type { Logger } from '../util/logger.js';
import type { ConfigStore } from './config-store.js';
import { createStreamLogger, type LogLine } from './stream-logger.js';

export const KNOWN_SOURCES = ['mock', 'import', 'companies'] as const;

export interface StartRunRequest {
  /** Overrides SOURCES_ENABLED for this run only; never written to .env. */
  sources?: string[];
  noCloud?: boolean;
  skipExport?: boolean;
  /** Evaluate without writing to the database. */
  dryRun?: boolean;
}

/**
 * A run summary without `ranked`.
 *
 * `ranked` holds every job and evaluation, descriptions included — kilobytes of
 * data the browser already has a tab for. Stripping it once here keeps it out of
 * both the summary event and every /api/runs/current poll.
 */
export type RunCounts = Omit<RunSummary, 'ranked'>;

export type RunEventType = 'state' | 'progress' | 'log' | 'summary' | 'error';

export interface RunEvent {
  seq: number;
  type: RunEventType;
  at: string;
  data: unknown;
}

export interface RunState {
  running: boolean;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progress: RunProgress | null;
  cancelling: boolean;
  lastSummary: RunCounts | null;
  lastError: string | null;
  lastEventId: number;
}

export interface RunController {
  state(): RunState;
  start(request: StartRunRequest): { started: boolean; reason?: string };
  cancel(): boolean;
  /** Buffered events after `sinceSeq`, so a reconnect loses nothing. */
  events(sinceSeq?: number): RunEvent[];
  subscribe(listener: (event: RunEvent) => void): () => void;
}

/** Enough to repopulate a log pane on reconnect without unbounded memory. */
const BUFFER_LIMIT = 500;

export function createRunController(deps: {
  config: ConfigStore;
  logger: Logger;
  profileFile(): string;
}): RunController {
  const { config, logger } = deps;

  const listeners = new Set<(event: RunEvent) => void>();
  let buffer: RunEvent[] = [];
  let seq = 0;

  // Set synchronously before the first await, so two requests arriving together
  // cannot both get past it. This is the only concurrency guard in the app.
  let running = false;
  let controller: AbortController | null = null;

  let runId: string | null = null;
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  let progress: RunProgress | null = null;
  let cancelling = false;
  let lastSummary: RunCounts | null = null;
  let lastError: string | null = null;

  function emit(type: RunEventType, data: unknown): void {
    seq += 1;
    const event: RunEvent = { seq, type, at: new Date().toISOString(), data };
    buffer.push(event);
    if (buffer.length > BUFFER_LIMIT) buffer = buffer.slice(-BUFFER_LIMIT);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* one broken subscriber must not stop the run */
      }
    }
  }

  function snapshot(): RunState {
    return {
      running,
      runId,
      startedAt,
      finishedAt,
      progress,
      cancelling,
      lastSummary,
      lastError,
      lastEventId: seq,
    };
  }

  function announceState(): void {
    emit('state', snapshot());
  }

  function runEnv(request: StartRunRequest): Env {
    // The same spread the CLI uses for --source and --no-cloud.
    return {
      ...config.current(),
      ...(request.sources?.length ? { SOURCES_ENABLED: request.sources.join(',') } : {}),
      ...(request.noCloud ? { CLOUD_ESCALATION_ENABLED: false } : {}),
    };
  }

  async function execute(request: StartRunRequest): Promise<void> {
    const env = runEnv(request);
    const streamLogger = createStreamLogger({
      base: logger,
      level: env.LOG_LEVEL,
      emit: (line: LogLine) => emit('log', line),
    });

    try {
      const profile = await loadProfile(deps.profileFile()).catch((err) => {
        if (err instanceof ProfileNotFoundError) {
          throw new Error('You do not have a profile yet. Open Profile to create one.');
        }
        if (err instanceof ProfileValidationError) {
          throw new Error('Your profile is not valid. Open Profile to fix it.');
        }
        throw err;
      });

      const summary = await runPipeline({
        env,
        profile,
        logger: streamLogger,
        skipExport: request.skipExport ?? false,
        skipPersistence: request.dryRun ?? false,
        signal: controller?.signal,
        onRunStarted: (id) => {
          runId = id;
          announceState();
        },
        onProgress: (next) => {
          progress = next;
          emit('progress', next);
        },
      });

      const { ranked: _ranked, ...counts } = summary;
      lastSummary = counts;
      lastError = null;
      emit('summary', counts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      await markRunFailed(runId, err);
      emit('error', { message, cancelled: cancelling });
    } finally {
      running = false;
      cancelling = false;
      controller = null;
      finishedAt = new Date().toISOString();
      progress = null;
      announceState();
    }
  }

  return {
    state: snapshot,
    events: (sinceSeq = 0) => buffer.filter((event) => event.seq > sinceSeq),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start(request) {
      if (running) return { started: false, reason: 'a run is already in progress' };

      const unknown = (request.sources ?? []).filter(
        (name) => !(KNOWN_SOURCES as readonly string[]).includes(name),
      );
      if (unknown.length > 0) {
        return { started: false, reason: `unknown source: ${unknown.join(', ')}` };
      }

      const sources = request.sources?.length ? request.sources : enabledSources(config.current());
      if (sources.length === 0) {
        return { started: false, reason: 'no sources are enabled' };
      }

      running = true;
      cancelling = false;
      controller = new AbortController();
      runId = null;
      lastError = null;
      lastSummary = null;
      startedAt = new Date().toISOString();
      finishedAt = null;
      progress = null;
      buffer = [];

      announceState();
      // Deliberately not awaited: the HTTP response returns immediately and the
      // run reports itself through the event stream.
      void execute(request);
      return { started: true };
    },

    cancel() {
      if (!running || !controller) return false;
      cancelling = true;
      controller.abort();
      announceState();
      return true;
    },
  };
}
