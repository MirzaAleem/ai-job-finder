import type { Env } from '../config/env.js';
import { thresholdsFromEnv } from '../config/scoring.js';
import type { CandidateProfile } from '../domain/profile.schema.js';
import type { NormalizedJob } from '../domain/job.schema.js';
import {
  ESCALATION_REASON_LABELS,
  type EscalationReason,
  type FinalEvaluation,
} from '../domain/evaluation.schema.js';
import type { Logger } from '../util/logger.js';
import { JobRepository, type JobState } from '../db/job.repository.js';
import { SqliteEvaluationCache } from '../db/evaluation-cache.js';
import { RunRepository } from '../db/run.repository.js';
import { isConnected } from '../db/connection.js';
import { NoopEvaluationCache, type EvaluationCache } from '../llm/cache.js';
import { UsageTracker } from '../llm/cost.js';
import { Evaluator, type EvaluationInput } from '../llm/evaluator.js';
import { createCloudProvider, createLocalProvider } from '../llm/factory.js';
import { toPromptJob } from '../llm/prompts/local-eval.js';
import type { LLMProvider } from '../llm/provider.js';
import { buildSources, sourceQueries } from '../sources/registry.js';
import { SourceUnsupportedError } from '../sources/source.js';
import { normalizeJob, NormalizationError } from './normalize.js';
import { deduplicateJobs } from './dedupe.js';
import { applyFilters, DEFAULT_FILTER_CONFIG, type FilterConfig } from './filter.js';
import { countRecommendations, rankJobs } from './rank.js';
import type { RankedJob } from '../export/types.js';
import { writeCsv } from '../export/csv.js';
import { writeJson } from '../export/json.js';

/** The pipeline's own section headings, in the order they run. */
export type RunStage =
  | 'starting'
  | 'fetching'
  | 'normalizing'
  | 'deduplicating'
  | 'filtering'
  | 'persisting'
  | 'evaluating'
  | 'ranking'
  | 'exporting'
  | 'done';

export interface RunProgress {
  stage: RunStage;
  /** Already safe to show to a person. */
  message: string;
  /** Present only where the stage has countable units, such as LLM batches. */
  current?: number;
  total?: number;
}

/** Thrown when a caller asks a run to stop. Caught and reported, never fatal. */
export class RunCancelledError extends Error {
  constructor() {
    super('cancelled by user');
    this.name = 'RunCancelledError';
  }
}

export interface RunOptions {
  env: Env;
  profile: CandidateProfile;
  logger: Logger;
  filterConfig?: FilterConfig;
  /** Test seam: substitute providers without touching the network. */
  localProvider?: LLMProvider;
  cloudProvider?: LLMProvider | null;
  cache?: EvaluationCache;
  /** Skip writing CSV/JSON (used by `jobs:match`). */
  skipExport?: boolean;
  /** Persist nothing; used when the database is unavailable. */
  skipPersistence?: boolean;
  /**
   * Fired as soon as the run row exists, before any real work.
   *
   * Without this the caller has no id until runPipeline returns, so a run that
   * crashes can never be marked FAILED and sits at RUNNING forever.
   */
  onRunStarted?(runId: string | null): void;
  /**
   * Structured stage updates, for a progress display.
   *
   * Deliberately separate from the logger: a progress bar driven by parsing log
   * strings breaks the moment someone rewords a message.
   */
  onProgress?(progress: RunProgress): void;
  /**
   * Cooperative cancellation, checked between sources and between LLM batches.
   * A run cannot be interrupted mid-request, so stopping takes until the end of
   * the current batch.
   */
  signal?: AbortSignal;
}

export interface RunSummary {
  runId: string | null;
  sourceCounts: Record<string, number>;
  jobsFetched: number;
  jobsDeduplicated: number;
  jobsFiltered: number;
  jobsEvaluated: number;
  jobsFromCache: number;
  jobsNew: number;
  filterRuleCounts: Record<string, number>;
  escalationReasonCounts: Record<string, number>;
  counts: ReturnType<typeof countRecommendations>;
  usage: ReturnType<UsageTracker['summary']>;
  localModel: string;
  cloudModel: string | null;
  batches: number;
  outputFiles: string[];
  errors: string[];
  ranked: RankedJob[];
}

/**
 * The whole pipeline, in order:
 * fetch → normalize → dedupe → filter → (cache) → local LLM → escalate → persist → export.
 */
export async function runPipeline(options: RunOptions): Promise<RunSummary> {
  const { env, profile, logger } = options;
  const startedAt = new Date();
  const errors: string[] = [];

  const usage = new UsageTracker({
    inputCostPerMTok: env.CLOUD_INPUT_COST_PER_MTOK,
    outputCostPerMTok: env.CLOUD_OUTPUT_COST_PER_MTOK,
  });

  const local = options.localProvider ?? createLocalProvider(env);
  const cloud =
    options.cloudProvider !== undefined ? options.cloudProvider : createCloudProvider(env, logger);

  const repository = new JobRepository();
  const runs = new RunRepository();
  const persist = !options.skipPersistence;

  const cache =
    options.cache ??
    (env.LLM_CACHE_ENABLED && persist ? new SqliteEvaluationCache() : new NoopEvaluationCache());

  const report = (stage: RunStage, message: string, counts?: { current: number; total: number }) =>
    options.onProgress?.({ stage, message, ...counts });

  const stopIfCancelled = (): void => {
    if (options.signal?.aborted) throw new RunCancelledError();
  };

  report('starting', 'Starting up');

  let runId: string | null = null;
  if (persist) {
    runId = await runs.start(startedAt);
    await repository.recordProfile(profile).catch((err) => {
      logger.warn('DB', 'could not record profile snapshot', { error: String(err) });
      return '';
    });
  }
  options.onRunStarted?.(runId);

  // ---------------------------------------------------------------- FETCH ---
  report('fetching', 'Fetching jobs');
  const { sources, browser } = buildSources(env, logger);
  const sourceCounts: Record<string, number> = {};
  const rawJobs = [];

  const queries = sourceQueries(env);

  let sourceNumber = 0;
  for (const source of sources) {
    try {
      stopIfCancelled();
    } catch (err) {
      await browser?.close();
      throw err;
    }
    sourceNumber += 1;
    report('fetching', `Fetching from ${source.name}`, {
      current: sourceNumber,
      total: sources.length,
    });

    if (source.status === 'UNSUPPORTED') {
      logger.warn('FETCH', `${source.name}: unsupported, skipping`, { reason: source.notes });
      errors.push(`${source.name}: unsupported — ${source.notes ?? 'no detail'}`);
      sourceCounts[source.name] = 0;
      continue;
    }

    try {
      const fetched = await source.fetchJobs({
        queries,
        maxPages: env.SCRAPE_MAX_PAGES,
      });
      sourceCounts[source.name] = fetched.length;
      rawJobs.push(...fetched);
      logger.info('FETCH', `${source.name}: ${fetched.length} jobs`);
    } catch (err) {
      const message =
        err instanceof SourceUnsupportedError
          ? err.message
          : `${source.name} failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error('FETCH', message);
      errors.push(message);
      sourceCounts[source.name] = 0;
    }
  }

  await browser?.close();

  // ------------------------------------------------------------ NORMALIZE ---
  report('normalizing', `Tidying up ${rawJobs.length} postings`);
  const normalized: NormalizedJob[] = [];
  let normalizationFailures = 0;
  for (const raw of rawJobs) {
    try {
      normalized.push(normalizeJob(raw, { now: startedAt }));
    } catch (err) {
      normalizationFailures += 1;
      if (err instanceof NormalizationError) {
        logger.debug('FETCH', 'dropping unusable job', { reason: err.message });
      }
    }
  }
  if (normalizationFailures > 0) {
    logger.warn('FETCH', 'some jobs could not be normalized', { count: normalizationFailures });
  }

  // --------------------------------------------------------------- DEDUPE ---
  report('deduplicating', 'Removing duplicates');
  const { jobs: deduped, duplicates } = deduplicateJobs(normalized);
  logger.info('FILTER', 'deduplicated', {
    before: normalized.length,
    after: deduped.length,
    removed: duplicates.length,
  });

  // --------------------------------------------------------------- FILTER ---
  report('filtering', 'Matching against your profile');
  const filterConfig = options.filterConfig ?? DEFAULT_FILTER_CONFIG;
  const filtered = applyFilters(deduped, profile, filterConfig);
  logger.info('FILTER', 'deterministic filtering complete', {
    passed: filtered.passed.length,
    rejected: filtered.rejected.length,
    byRule: filtered.ruleCounts,
  });

  // ------------------------------------------------------------- PERSIST ----
  report('persisting', `Saving ${filtered.passed.length} jobs`);
  const stateById = new Map<string, JobState>();
  const idByFingerprint = new Map<string, string>();

  let jobsNew = 0;
  if (persist) {
    const upserts = await repository.upsertMany(filtered.passed);
    for (const result of upserts) {
      stateById.set(result.job.fingerprint, result.state);
      idByFingerprint.set(result.job.fingerprint, result.job.id);
      if (result.state === 'NEW') jobsNew += 1;
    }
    logger.info('DB', 'jobs persisted', { total: upserts.length, new: jobsNew });
  } else {
    for (const job of filtered.passed) {
      stateById.set(job.fingerprint, 'NEW');
      idByFingerprint.set(job.fingerprint, job.fingerprint);
    }
    jobsNew = filtered.passed.length;
  }

  // ------------------------------------------------------------ EVALUATE ----
  report('evaluating', 'Scoring jobs with the local model');
  const evaluator = new Evaluator({
    local,
    cloud,
    cache,
    usage,
    logger,
    escalation: {
      confidenceThreshold: env.LLM_CONFIDENCE_THRESHOLD,
      enabled: env.CLOUD_ESCALATION_ENABLED,
      softFlagThreshold: env.LLM_SOFT_FLAG_THRESHOLD,
    },
    thresholds: thresholdsFromEnv(env),
    batchSize: env.LLM_BATCH_SIZE,
    maxRetries: env.LLM_MAX_RETRIES,
    maxCloudRequests: env.CLOUD_MAX_REQUESTS_PER_RUN,
    signal: options.signal,
    onBatch: (done, total) =>
      report('evaluating', `Scoring batch ${done} of ${total}`, { current: done, total }),
  });

  const jobByKey = new Map<string, NormalizedJob>();
  const inputs: EvaluationInput[] = filtered.passed.map((job) => {
    const key = idByFingerprint.get(job.fingerprint) ?? job.fingerprint;
    jobByKey.set(key, job);
    return {
      job: toPromptJob(job, key, env.LLM_MAX_DESCRIPTION_CHARS),
      contentHash: job.contentHash,
    };
  });

  const evaluations = await evaluator.evaluateAll(profile, inputs);

  const escalationReasonCounts: Record<string, number> = {};
  let jobsFromCache = 0;
  for (const evaluation of evaluations) {
    if (evaluation.fromCache) jobsFromCache += 1;
    for (const reason of evaluation.escalationReasons) {
      const label = ESCALATION_REASON_LABELS[reason as EscalationReason] ?? reason;
      escalationReasonCounts[label] = (escalationReasonCounts[label] ?? 0) + 1;
    }
  }

  if (persist) {
    for (const evaluation of evaluations) {
      if (evaluation.fromCache) continue;
      try {
        await repository.saveEvaluation(evaluation, evaluation.jobId, runId);
      } catch (err) {
        logger.error('DB', 'could not save evaluation', {
          jobId: evaluation.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ---------------------------------------------------------------- RANK ----
  report('ranking', 'Ranking results');
  const ranked = rankJobs(
    evaluations
      .map<RankedJob | null>((evaluation) => {
        const job = jobByKey.get(evaluation.jobId);
        if (!job) return null;
        return {
          job,
          evaluation,
          isNew: stateById.get(job.fingerprint) === 'NEW',
        };
      })
      .filter((item): item is RankedJob => item !== null),
  );

  const counts = countRecommendations(ranked);

  // -------------------------------------------------------------- EXPORT ----
  const outputFiles: string[] = [];
  if (!options.skipExport) {
    report('exporting', 'Writing CSV and JSON');
    const csvPath = await writeCsv(ranked, env.OUTPUT_DIR, startedAt);
    const jsonPath = await writeJson(
      ranked,
      {
        generatedAt: startedAt.toISOString(),
        totalJobs: ranked.length,
        newJobs: ranked.filter((r) => r.isNew).length,
        localModel: local.model,
        cloudModel: cloud?.model ?? null,
        cloudRequests: usage.summary().cloudRequests,
        estimatedCloudCost: usage.estimatedCloudCost(),
      },
      env.OUTPUT_DIR,
      startedAt,
    );
    outputFiles.push(csvPath, jsonPath);
    logger.info('EXPORT', 'written', { csv: csvPath, json: jsonPath });
  }

  const summary: RunSummary = {
    runId,
    sourceCounts,
    jobsFetched: rawJobs.length,
    jobsDeduplicated: deduped.length,
    jobsFiltered: filtered.passed.length,
    jobsEvaluated: evaluations.length,
    jobsFromCache,
    jobsNew,
    filterRuleCounts: filtered.ruleCounts,
    escalationReasonCounts,
    counts,
    usage: usage.summary(),
    localModel: local.model,
    cloudModel: cloud?.model ?? null,
    batches: Math.ceil(
      Math.max(0, evaluations.length - jobsFromCache) / Math.max(1, env.LLM_BATCH_SIZE),
    ),
    outputFiles,
    errors,
    ranked,
  };

  if (persist && runId) {
    await runs.complete(runId, {
      sourceCounts,
      jobsFetched: summary.jobsFetched,
      jobsDeduplicated: summary.jobsDeduplicated,
      jobsFiltered: summary.jobsFiltered,
      jobsEvaluated: summary.jobsEvaluated,
      jobsFromCache: summary.jobsFromCache,
      jobsNew: summary.jobsNew,
      localLLMRequests: summary.usage.localRequests,
      cloudLLMRequests: summary.usage.cloudRequests,
      cloudInputTokens: summary.usage.cloudInputTokens,
      cloudOutputTokens: summary.usage.cloudOutputTokens,
      estimatedCloudCost: summary.usage.estimatedCloudCost,
      escalationReasonCounts,
      highPriorityCount: counts.HIGH_PRIORITY,
      applyCount: counts.APPLY,
      considerCount: counts.CONSIDER,
      skipCount: counts.SKIP,
      outputFiles,
      errors,
    });
  }

  report('done', 'Finished');
  return summary;
}

/** Marks a run failed so a crashed run is not left RUNNING forever. */
export async function markRunFailed(runId: string | null, error: unknown): Promise<void> {
  if (!runId || !isConnected()) return;
  await new RunRepository().fail(runId, error).catch(() => undefined);
}

export type { FinalEvaluation };
