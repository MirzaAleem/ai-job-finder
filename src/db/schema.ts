import type BetterSqlite3 from 'better-sqlite3';

/**
 * The full schema, applied on every connect.
 *
 * Every statement is `IF NOT EXISTS`, so this is idempotent and doubles as the
 * migration path for an existing file: adding a table or index here is picked up
 * on the next run with no separate migration step. Changing or dropping a column
 * is not, and would need a real migration.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id                  INTEGER PRIMARY KEY,
  source              TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  company             TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  location            TEXT,
  remote              TEXT CHECK (remote IN ('REMOTE', 'HYBRID', 'ONSITE') OR remote IS NULL),
  salary              TEXT,
  experience_required TEXT,
  skills              TEXT NOT NULL DEFAULT '[]',
  url                 TEXT NOT NULL,
  application_url     TEXT,
  posted_at           TEXT,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  fingerprint         TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  raw_data            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- One row per posting per source; the natural key for an upsert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_external ON jobs (source, external_id);
CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint  ON jobs (fingerprint);
CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON jobs (content_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen   ON jobs (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen    ON jobs (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_posted       ON jobs (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company      ON jobs (company, title);

CREATE TABLE IF NOT EXISTS runs (
  id                       INTEGER PRIMARY KEY,
  started_at               TEXT NOT NULL,
  completed_at             TEXT,
  status                   TEXT NOT NULL DEFAULT 'RUNNING'
                             CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  source_counts            TEXT NOT NULL DEFAULT '{}',
  jobs_fetched             INTEGER NOT NULL DEFAULT 0,
  jobs_deduplicated        INTEGER NOT NULL DEFAULT 0,
  jobs_filtered            INTEGER NOT NULL DEFAULT 0,
  jobs_evaluated           INTEGER NOT NULL DEFAULT 0,
  jobs_from_cache          INTEGER NOT NULL DEFAULT 0,
  jobs_new                 INTEGER NOT NULL DEFAULT 0,
  local_llm_requests       INTEGER NOT NULL DEFAULT 0,
  cloud_llm_requests       INTEGER NOT NULL DEFAULT 0,
  cloud_input_tokens       INTEGER NOT NULL DEFAULT 0,
  cloud_output_tokens      INTEGER NOT NULL DEFAULT 0,
  estimated_cloud_cost     REAL NOT NULL DEFAULT 0,
  escalation_reason_counts TEXT NOT NULL DEFAULT '{}',
  high_priority_count      INTEGER NOT NULL DEFAULT 0,
  apply_count              INTEGER NOT NULL DEFAULT 0,
  consider_count           INTEGER NOT NULL DEFAULT 0,
  skip_count               INTEGER NOT NULL DEFAULT 0,
  output_files             TEXT NOT NULL DEFAULT '[]',
  errors                   TEXT NOT NULL DEFAULT '[]',
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status  ON runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS job_evaluations (
  id                INTEGER PRIMARY KEY,
  job_id            INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  run_id            INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  -- Cache key. See FinalEvaluation.localModel for why this is not the "model" column.
  local_model       TEXT NOT NULL,
  provider_used     TEXT NOT NULL CHECK (provider_used IN ('LOCAL', 'CLOUD')),
  score             REAL NOT NULL,
  confidence        REAL NOT NULL,
  recommendation    TEXT NOT NULL
                      CHECK (recommendation IN ('HIGH_PRIORITY', 'APPLY', 'CONSIDER', 'SKIP')),
  matching_skills   TEXT NOT NULL DEFAULT '[]',
  missing_skills    TEXT NOT NULL DEFAULT '[]',
  reasons           TEXT NOT NULL DEFAULT '[]',
  concerns          TEXT NOT NULL DEFAULT '[]',
  needs_cloud       INTEGER NOT NULL DEFAULT 0,
  escalated         INTEGER NOT NULL DEFAULT 0,
  escalation_reason TEXT NOT NULL DEFAULT '[]',
  degraded          INTEGER NOT NULL DEFAULT 0,
  -- Both sides are kept so a local/cloud disagreement can be audited later.
  local_evaluation  TEXT,
  cloud_evaluation  TEXT,
  -- Ties the evaluation to the exact job content it was made against.
  content_hash      TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

-- The cache lookup: "has this local model already judged this exact content?"
-- Keyed on local_model so an escalated job is still a cache hit next run.
CREATE INDEX IF NOT EXISTS idx_eval_cache  ON job_evaluations (content_hash, local_model, id DESC);
CREATE INDEX IF NOT EXISTS idx_eval_job    ON job_evaluations (job_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_eval_run    ON job_evaluations (run_id);
CREATE INDEX IF NOT EXISTS idx_eval_score  ON job_evaluations (score DESC);
CREATE INDEX IF NOT EXISTS idx_eval_recomm ON job_evaluations (recommendation, score DESC);

-- User-authored state, deliberately kept in its own table rather than on the jobs table.
--
-- JobRepository.upsert rewrites a job row on every scrape. Anything the user
-- typed living on that row would be one careless UPDATE away from being lost,
-- and losing a record of where you applied is not a recoverable error.
CREATE TABLE IF NOT EXISTS job_applications (
  id             INTEGER PRIMARY KEY,
  job_id         INTEGER NOT NULL UNIQUE REFERENCES jobs (id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'NEW',
  notes          TEXT NOT NULL DEFAULT '',
  -- Set the first time the status becomes APPLIED, and never moved after.
  applied_at     TEXT,
  status_history TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_status  ON job_applications (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_updated ON job_applications (updated_at DESC);

-- A snapshot of the YAML profile as it was at run time. Evaluations are only
-- meaningful relative to the profile that produced them, so we version it.
CREATE TABLE IF NOT EXISTS candidate_profiles (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT 'default',
  profile_hash TEXT NOT NULL,
  data         TEXT NOT NULL,
  active_from  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_name_hash ON candidate_profiles (name, profile_hash);
CREATE INDEX IF NOT EXISTS idx_profile_active ON candidate_profiles (active_from DESC);
`;

export function applySchema(db: BetterSqlite3.Database): void {
  db.exec(DDL);
}
