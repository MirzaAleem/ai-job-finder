import { getDb } from './connection.js';
import { fromJson, toJson } from './mapping.js';
import type { RunRow } from './rows.js';

export interface RunCompletion {
  sourceCounts: Record<string, number>;
  jobsFetched: number;
  jobsDeduplicated: number;
  jobsFiltered: number;
  jobsEvaluated: number;
  jobsFromCache: number;
  jobsNew: number;
  localLLMRequests: number;
  cloudLLMRequests: number;
  cloudInputTokens: number;
  cloudOutputTokens: number;
  estimatedCloudCost: number;
  escalationReasonCounts: Record<string, number>;
  highPriorityCount: number;
  applyCount: number;
  considerCount: number;
  skipCount: number;
  outputFiles: string[];
  errors: string[];
}

/** Run bookkeeping: one row per pipeline invocation, opened then closed. */
export interface RunListFilters {
  limit?: number;
  offset?: number;
  status?: 'RUNNING' | 'COMPLETED' | 'FAILED';
}

export class RunRepository {
  async start(startedAt: Date): Promise<string> {
    const now = new Date().toISOString();
    const info = getDb()
      .prepare(
        `INSERT INTO runs (started_at, status, created_at, updated_at) VALUES (?, 'RUNNING', ?, ?)`,
      )
      .run(startedAt.toISOString(), now, now);
    return String(info.lastInsertRowid);
  }

  async complete(runId: string, summary: RunCompletion): Promise<void> {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `UPDATE runs SET
           completed_at = @completed_at, status = 'COMPLETED',
           source_counts = @source_counts,
           jobs_fetched = @jobs_fetched, jobs_deduplicated = @jobs_deduplicated,
           jobs_filtered = @jobs_filtered, jobs_evaluated = @jobs_evaluated,
           jobs_from_cache = @jobs_from_cache, jobs_new = @jobs_new,
           local_llm_requests = @local_llm_requests, cloud_llm_requests = @cloud_llm_requests,
           cloud_input_tokens = @cloud_input_tokens, cloud_output_tokens = @cloud_output_tokens,
           estimated_cloud_cost = @estimated_cloud_cost,
           escalation_reason_counts = @escalation_reason_counts,
           high_priority_count = @high_priority_count, apply_count = @apply_count,
           consider_count = @consider_count, skip_count = @skip_count,
           output_files = @output_files, errors = @errors, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id: Number(runId),
        completed_at: now,
        source_counts: toJson(summary.sourceCounts),
        jobs_fetched: summary.jobsFetched,
        jobs_deduplicated: summary.jobsDeduplicated,
        jobs_filtered: summary.jobsFiltered,
        jobs_evaluated: summary.jobsEvaluated,
        jobs_from_cache: summary.jobsFromCache,
        jobs_new: summary.jobsNew,
        local_llm_requests: summary.localLLMRequests,
        cloud_llm_requests: summary.cloudLLMRequests,
        cloud_input_tokens: summary.cloudInputTokens,
        cloud_output_tokens: summary.cloudOutputTokens,
        estimated_cloud_cost: summary.estimatedCloudCost,
        escalation_reason_counts: toJson(summary.escalationReasonCounts),
        high_priority_count: summary.highPriorityCount,
        apply_count: summary.applyCount,
        consider_count: summary.considerCount,
        skip_count: summary.skipCount,
        output_files: toJson(summary.outputFiles),
        errors: toJson(summary.errors),
        updated_at: now,
      });
  }

  /** Marks the run failed and appends the error, preserving any already recorded. */
  async fail(runId: string, error: unknown): Promise<void> {
    const db = getDb();
    const row = db
      .prepare<[number], Pick<RunRow, 'errors'>>('SELECT errors FROM runs WHERE id = ?')
      .get(Number(runId));
    if (!row) return;

    const errors = fromJson<string[]>(row.errors, []);
    errors.push(error instanceof Error ? error.message : String(error));

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE runs SET completed_at = ?, status = 'FAILED', errors = ?, updated_at = ? WHERE id = ?`,
    ).run(now, toJson(errors), now, Number(runId));
  }

  async findLatest(): Promise<RunRow | undefined> {
    return getDb()
      .prepare<[], RunRow>('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT 1')
      .get();
  }

  async findById(runId: string): Promise<RunRow | undefined> {
    return getDb().prepare<[number], RunRow>('SELECT * FROM runs WHERE id = ?').get(Number(runId));
  }

  /**
   * Newest first, for the run history view.
   *
   * Clamping lives here rather than in the route so it is enforced once and
   * tested once, whatever calls it.
   */
  async findAll(filters: RunListFilters = {}): Promise<RunRow[]> {
    const limit = clamp(filters.limit ?? 20, 1, 100);
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0));

    // Both orderings are covered by idx_runs_started / idx_runs_status.
    if (filters.status) {
      return getDb()
        .prepare<[string, number, number], RunRow>(
          `SELECT * FROM runs WHERE status = ?
           ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(filters.status, limit, offset);
    }

    return getDb()
      .prepare<[number, number], RunRow>(
        'SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset);
  }

  async count(filters: Pick<RunListFilters, 'status'> = {}): Promise<number> {
    const db = getDb();
    const row = filters.status
      ? db
          .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM runs WHERE status = ?')
          .get(filters.status)
      : db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM runs').get();
    return row?.n ?? 0;
  }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.trunc(value)));
}
