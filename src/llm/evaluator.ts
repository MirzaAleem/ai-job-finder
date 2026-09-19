import {
  LLMBatchEvaluationSchema,
  LLMEvaluationSchema,
  type EscalationReason,
  type FinalEvaluation,
  type LLMEvaluation,
} from '../domain/evaluation.schema.js';
import type { CandidateProfile } from '../domain/profile.schema.js';
import type { ScoreThresholds } from '../config/scoring.js';
import { recommendationForScore } from '../config/scoring.js';
import type { Logger } from '../util/logger.js';
import { parseStructured } from './json.js';
import { decideEscalation, escalationWarranted, type EscalationConfig } from './escalation.js';
import { buildCloudVerifyPrompt, CLOUD_SYSTEM_PROMPT } from './prompts/cloud-verify.js';
import {
  LOCAL_SYSTEM_PROMPT,
  REPAIR_SYSTEM_PROMPT,
  buildBatchEvalPrompt,
  buildSingleEvalPrompt,
  type PromptJob,
} from './prompts/local-eval.js';
import type { LLMProvider } from './provider.js';
import type { UsageTracker } from './cost.js';
import type { EvaluationCache } from './cache.js';

export interface EvaluatorOptions {
  local: LLMProvider;
  cloud: LLMProvider | null;
  cache: EvaluationCache;
  usage: UsageTracker;
  logger: Logger;
  escalation: EscalationConfig;
  thresholds: ScoreThresholds;
  batchSize: number;
  maxRetries: number;
  maxCloudRequests: number;
  /**
   * Called before each batch. Evaluation is the long pole of a run — often
   * minutes — and it is a single awaited call from the outside, so without this
   * there is nothing to show a waiting user.
   */
  onBatch?(done: number, total: number): void;
  /** Checked between batches; a request already in flight is allowed to finish. */
  signal?: AbortSignal;
}

export interface EvaluationInput {
  job: PromptJob;
  contentHash: string;
}

/** Thrown when a run is cancelled between batches. */
export class EvaluationCancelledError extends Error {
  constructor() {
    super('cancelled by user');
    this.name = 'EvaluationCancelledError';
  }
}

export class Evaluator {
  private cloudCallsThisRun = 0;

  constructor(private readonly options: EvaluatorOptions) {}

  /**
   * Evaluate a set of jobs. Cached jobs cost nothing; the remainder are batched
   * through the local model; only jobs that fail the escalation rules reach the
   * cloud, one at a time.
   */
  async evaluateAll(
    profile: CandidateProfile,
    inputs: EvaluationInput[],
  ): Promise<FinalEvaluation[]> {
    const { cache, logger, batchSize } = this.options;

    const results: FinalEvaluation[] = [];
    const pending: EvaluationInput[] = [];

    for (const input of inputs) {
      const cached = await cache.get(input.contentHash, this.options.local.model);
      if (cached) {
        logger.debug('CACHE', 'hit — skipping LLM', { jobId: input.job.jobId });
        results.push({
          jobId: input.job.jobId,
          score: cached.score,
          confidence: cached.confidence,
          recommendation: cached.recommendation,
          matchingSkills: cached.matchingSkills,
          missingSkills: cached.missingSkills,
          reasons: cached.reasons,
          concerns: cached.concerns,
          needsCloud: false,
          escalationReason: null,
          uncertainties: {
            seniority: false,
            experience: false,
            salary: false,
            requirements: false,
            conflicting: false,
          },
          providerUsed: cached.providerUsed,
          localEvaluation: null,
          cloudEvaluation: null,
          escalated: false,
          escalationReasons: [],
          degraded: false,
          provider: cached.provider,
          model: cached.model,
          localModel: this.options.local.model,
          contentHash: input.contentHash,
          fromCache: true,
        });
      } else {
        pending.push(input);
      }
    }

    if (pending.length > 0) {
      logger.info('LOCAL-LLM', 'evaluating', {
        jobs: pending.length,
        cached: results.length,
        model: this.options.local.model,
        batchSize,
      });
    }

    const batches = chunk(pending, Math.max(1, batchSize));
    let batchNumber = 0;
    for (const batch of batches) {
      if (this.options.signal?.aborted) throw new EvaluationCancelledError();
      batchNumber += 1;
      this.options.onBatch?.(batchNumber, batches.length);
      logger.debug('LOCAL-LLM', `batch ${batchNumber}/${batches.length}`, { size: batch.length });
      const evaluated = await this.evaluateBatch(profile, batch);
      results.push(...evaluated);
    }

    return results;
  }

  /** Local batch call, falling back to per-job calls when the batch is unusable. */
  private async evaluateBatch(
    profile: CandidateProfile,
    batch: EvaluationInput[],
  ): Promise<FinalEvaluation[]> {
    if (batch.length === 1) {
      const only = batch[0];
      return only ? [await this.evaluateSingle(profile, only)] : [];
    }

    const byId = new Map(batch.map((input) => [input.job.jobId, input]));
    const prompt = buildBatchEvalPrompt(
      profile,
      batch.map((input) => input.job),
    );

    let parsedEvaluations: LLMEvaluation[] | null = null;
    try {
      const response = await this.options.local.complete({
        system: LOCAL_SYSTEM_PROMPT,
        user: prompt,
        json: true,
      });
      this.options.usage.record('local', response.usage);

      const parsed = parseStructured(response.text, LLMBatchEvaluationSchema);
      if (parsed.ok) {
        parsedEvaluations = parsed.value.evaluations;
      } else {
        this.options.logger.warn('LOCAL-LLM', 'batch response rejected, retrying per job', {
          error: parsed.error,
        });
      }
    } catch (err) {
      this.options.logger.warn('LOCAL-LLM', 'batch request failed, retrying per job', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // A batch that returned the wrong number of entries is as bad as no batch:
    // we cannot tell which job an evaluation belongs to.
    const usable =
      parsedEvaluations !== null &&
      parsedEvaluations.length === batch.length &&
      parsedEvaluations.every((e) => byId.has(e.jobId ?? ''));

    if (!usable) {
      if (parsedEvaluations !== null) {
        this.options.logger.warn('LOCAL-LLM', 'batch/job mismatch, falling back to per job', {
          expected: batch.length,
          received: parsedEvaluations.length,
        });
      }
      const out: FinalEvaluation[] = [];
      for (const input of batch) out.push(await this.evaluateSingle(profile, input));
      return out;
    }

    const out: FinalEvaluation[] = [];
    for (const evaluation of parsedEvaluations ?? []) {
      const input = byId.get(evaluation.jobId ?? '');
      if (!input) continue;
      out.push(await this.settle(profile, input, evaluation, false));
    }
    return out;
  }

  /** One job through the local model, with a single repair retry on bad output. */
  private async evaluateSingle(
    profile: CandidateProfile,
    input: EvaluationInput,
  ): Promise<FinalEvaluation> {
    const prompt = buildSingleEvalPrompt(profile, input.job);
    const attempts = 1 + Math.max(0, this.options.maxRetries);

    let evaluation: LLMEvaluation | null = null;
    let lastError = 'no attempt made';

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.options.local.complete({
          system: attempt === 0 ? LOCAL_SYSTEM_PROMPT : REPAIR_SYSTEM_PROMPT,
          user: prompt,
          json: true,
        });
        this.options.usage.record('local', response.usage);

        const parsed = parseStructured(response.text, LLMEvaluationSchema);
        if (parsed.ok) {
          evaluation = parsed.value;
          break;
        }
        lastError = parsed.error;
        this.options.logger.warn('LOCAL-LLM', `unusable response (attempt ${attempt + 1})`, {
          jobId: input.job.jobId,
          error: parsed.error,
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.options.logger.warn('LOCAL-LLM', `request failed (attempt ${attempt + 1})`, {
          jobId: input.job.jobId,
          error: lastError,
        });
      }
    }

    if (evaluation === null) {
      this.options.logger.warn('LOCAL-LLM', 'local evaluation failed, escalating', {
        jobId: input.job.jobId,
        error: lastError,
      });
    }
    return this.settle(profile, input, evaluation, evaluation === null);
  }

  /** Apply escalation rules, call the cloud if warranted, and finalise the record. */
  private async settle(
    profile: CandidateProfile,
    input: EvaluationInput,
    local: LLMEvaluation | null,
    parseFailed: boolean,
  ): Promise<FinalEvaluation> {
    const decision = decideEscalation(local, this.options.escalation, parseFailed);
    const warranted = escalationWarranted(local, this.options.escalation, parseFailed);

    let cloud: LLMEvaluation | null = null;
    let degraded = warranted && !decision.shouldEscalate;

    if (decision.shouldEscalate) {
      if (!this.options.cloud) {
        this.options.logger.warn(
          'CLOUD-LLM',
          'escalation needed but no cloud provider configured',
          {
            jobId: input.job.jobId,
            reasons: decision.reasons,
          },
        );
        degraded = true;
      } else if (this.cloudCallsThisRun >= this.options.maxCloudRequests) {
        this.options.logger.warn('CLOUD-LLM', 'cloud request budget exhausted for this run', {
          jobId: input.job.jobId,
          limit: this.options.maxCloudRequests,
        });
        degraded = true;
      } else {
        cloud = await this.callCloud(profile, input, local, decision.reasons);
        if (cloud === null) degraded = true;
      }
    }

    const chosen = cloud ?? local;
    const providerUsed = cloud !== null ? 'CLOUD' : 'LOCAL';
    const provider =
      cloud !== null ? (this.options.cloud?.name ?? 'cloud') : this.options.local.name;
    const model =
      cloud !== null ? (this.options.cloud?.model ?? 'unknown') : this.options.local.model;

    // When both the local model and the cloud failed there is nothing to trust.
    // Score 0 with confidence 0 and an explicit concern beats inventing a number.
    const base: LLMEvaluation = chosen ?? {
      score: 0,
      confidence: 0,
      recommendation: 'SKIP',
      matchingSkills: [],
      missingSkills: [],
      reasons: [],
      concerns: ['Evaluation failed: no usable model response. Review this posting manually.'],
      needsCloud: true,
      escalationReason: 'MALFORMED_RESPONSE',
      uncertainties: {
        seniority: false,
        experience: false,
        salary: false,
        requirements: false,
        conflicting: false,
      },
    };

    return {
      ...base,
      jobId: input.job.jobId,
      // The score is authoritative; the label is derived so the two cannot disagree.
      recommendation: recommendationForScore(base.score, this.options.thresholds),
      providerUsed,
      localEvaluation: local,
      cloudEvaluation: cloud,
      escalated: cloud !== null,
      escalationReasons: decision.reasons,
      degraded,
      provider,
      model,
      localModel: this.options.local.model,
      contentHash: input.contentHash,
      fromCache: false,
    };
  }

  private async callCloud(
    profile: CandidateProfile,
    input: EvaluationInput,
    local: LLMEvaluation | null,
    reasons: EscalationReason[],
  ): Promise<LLMEvaluation | null> {
    const cloudProvider = this.options.cloud;
    if (!cloudProvider) return null;

    this.options.logger.info('CLOUD-LLM', 'escalating', {
      jobId: input.job.jobId,
      reasons,
      model: cloudProvider.model,
    });

    const cached = await this.options.cache.get(`cloud:${input.contentHash}`, cloudProvider.model);
    if (cached) {
      this.options.logger.debug('CACHE', 'cloud cache hit', { jobId: input.job.jobId });
      return {
        score: cached.score,
        confidence: cached.confidence,
        recommendation: cached.recommendation,
        matchingSkills: cached.matchingSkills,
        missingSkills: cached.missingSkills,
        reasons: cached.reasons,
        concerns: cached.concerns,
        needsCloud: false,
        escalationReason: null,
        uncertainties: {
          seniority: false,
          experience: false,
          salary: false,
          requirements: false,
          conflicting: false,
        },
      };
    }

    try {
      this.cloudCallsThisRun += 1;
      const response = await cloudProvider.complete({
        system: CLOUD_SYSTEM_PROMPT,
        user: buildCloudVerifyPrompt(profile, input.job, local, reasons),
        json: true,
      });
      this.options.usage.record('cloud', response.usage);

      const parsed = parseStructured(response.text, LLMEvaluationSchema);
      if (!parsed.ok) {
        this.options.logger.error('CLOUD-LLM', 'cloud response rejected', {
          jobId: input.job.jobId,
          error: parsed.error,
        });
        return null;
      }

      await this.options.cache.set(`cloud:${input.contentHash}`, cloudProvider.model, {
        score: parsed.value.score,
        confidence: parsed.value.confidence,
        recommendation: parsed.value.recommendation,
        matchingSkills: parsed.value.matchingSkills,
        missingSkills: parsed.value.missingSkills,
        reasons: parsed.value.reasons,
        concerns: parsed.value.concerns,
        providerUsed: 'CLOUD',
        provider: cloudProvider.name,
        model: cloudProvider.model,
      });

      return parsed.value;
    } catch (err) {
      this.options.logger.error('CLOUD-LLM', 'escalation failed', {
        jobId: input.job.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
