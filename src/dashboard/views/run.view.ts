import { fromJson } from '../../db/mapping.js';
import type { RunRow } from '../../db/rows.js';

/**
 * RunRow -> API shape.
 *
 * The table is snake_case with JSON stuffed into TEXT columns; none of that
 * belongs in the API. Pure functions, so they are testable without a database.
 */

/** A RUNNING row older than this almost certainly belongs to a killed process. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface RunSummaryView {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  /** True for a RUNNING row left behind by a process that was killed. */
  interrupted: boolean;
  durationMs: number | null;
  jobsFetched: number;
  jobsEvaluated: number;
  jobsFromCache: number;
  jobsNew: number;
  counts: { HIGH_PRIORITY: number; APPLY: number; CONSIDER: number; SKIP: number };
  cloudRequests: number;
  estimatedCloudCost: number;
  errorCount: number;
  outputFiles: string[];
}

export interface RunDetailView extends RunSummaryView {
  jobsDeduplicated: number;
  jobsFiltered: number;
  localRequests: number;
  cloudInputTokens: number;
  cloudOutputTokens: number;
  sourceCounts: Record<string, number>;
  escalationReasonCounts: Record<string, number>;
  errors: string[];
}

function duration(row: RunRow): number | null {
  if (!row.completed_at) return null;
  const ms = Date.parse(row.completed_at) - Date.parse(row.started_at);
  return Number.isFinite(ms) ? ms : null;
}

function isInterrupted(row: RunRow, now: number): boolean {
  if (row.status !== 'RUNNING') return false;
  return now - Date.parse(row.started_at) > STALE_AFTER_MS;
}

export function toRunSummaryView(row: RunRow, now = Date.now()): RunSummaryView {
  return {
    id: String(row.id),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    status: row.status,
    interrupted: isInterrupted(row, now),
    durationMs: duration(row),
    jobsFetched: row.jobs_fetched,
    jobsEvaluated: row.jobs_evaluated,
    jobsFromCache: row.jobs_from_cache,
    jobsNew: row.jobs_new,
    counts: {
      HIGH_PRIORITY: row.high_priority_count,
      APPLY: row.apply_count,
      CONSIDER: row.consider_count,
      SKIP: row.skip_count,
    },
    cloudRequests: row.cloud_llm_requests,
    estimatedCloudCost: row.estimated_cloud_cost,
    errorCount: fromJson<string[]>(row.errors, []).length,
    outputFiles: fromJson<string[]>(row.output_files, []),
  };
}

export function toRunDetailView(row: RunRow, now = Date.now()): RunDetailView {
  return {
    ...toRunSummaryView(row, now),
    jobsDeduplicated: row.jobs_deduplicated,
    jobsFiltered: row.jobs_filtered,
    localRequests: row.local_llm_requests,
    cloudInputTokens: row.cloud_input_tokens,
    cloudOutputTokens: row.cloud_output_tokens,
    sourceCounts: fromJson<Record<string, number>>(row.source_counts, {}),
    escalationReasonCounts: fromJson<Record<string, number>>(row.escalation_reason_counts, {}),
    errors: fromJson<string[]>(row.errors, []),
  };
}
