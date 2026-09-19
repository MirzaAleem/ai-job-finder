import type { RemoteStatus } from '../domain/job.schema.js';

/**
 * The raw shapes `better-sqlite3` hands back — snake_case, with JSON columns
 * still text and booleans still 0/1. Everything outside `src/db` deals in domain
 * types; these exist so the mapping functions have something honest to accept.
 */

export type ProviderUsed = 'LOCAL' | 'CLOUD';
export type Recommendation = 'HIGH_PRIORITY' | 'APPLY' | 'CONSIDER' | 'SKIP';
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface JobRow {
  id: number;
  source: string;
  external_id: string;
  company: string;
  title: string;
  description: string;
  location: string | null;
  remote: RemoteStatus;
  salary: string | null;
  experience_required: string | null;
  skills: string;
  url: string;
  application_url: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  fingerprint: string;
  content_hash: string;
  raw_data: string;
  created_at: string;
  updated_at: string;
}

export interface EvaluationRow {
  id: number;
  job_id: number;
  run_id: number | null;
  provider: string;
  model: string;
  local_model: string;
  provider_used: ProviderUsed;
  score: number;
  confidence: number;
  recommendation: Recommendation;
  matching_skills: string;
  missing_skills: string;
  reasons: string;
  concerns: string;
  needs_cloud: number;
  escalated: number;
  escalation_reason: string;
  degraded: number;
  local_evaluation: string | null;
  cloud_evaluation: string | null;
  content_hash: string;
  created_at: string;
}

export interface ApplicationRow {
  id: number;
  job_id: number;
  status: string;
  notes: string;
  applied_at: string | null;
  status_history: string;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: RunStatus;
  source_counts: string;
  jobs_fetched: number;
  jobs_deduplicated: number;
  jobs_filtered: number;
  jobs_evaluated: number;
  jobs_from_cache: number;
  jobs_new: number;
  local_llm_requests: number;
  cloud_llm_requests: number;
  cloud_input_tokens: number;
  cloud_output_tokens: number;
  estimated_cloud_cost: number;
  escalation_reason_counts: string;
  high_priority_count: number;
  apply_count: number;
  consider_count: number;
  skip_count: number;
  output_files: string;
  errors: string;
  created_at: string;
  updated_at: string;
}
