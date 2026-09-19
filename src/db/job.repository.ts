import type { NormalizedJob, StoredJob } from '../domain/job.schema.js';
import type { FinalEvaluation } from '../domain/evaluation.schema.js';
import type { CandidateProfile } from '../domain/profile.schema.js';
import { sha256 } from '../util/hash.js';
import { getDb } from './connection.js';
import {
  fromBool,
  fromJson,
  toBool,
  toDate,
  toDateRequired,
  toIso,
  toIsoRequired,
  toJson,
} from './mapping.js';
import type { EvaluationRow, JobRow } from './rows.js';

export type JobState = 'NEW' | 'UNCHANGED' | 'CHANGED';

export interface UpsertResult {
  job: StoredJob;
  state: JobState;
}

/**
 * Persists jobs and decides, per job, whether it is new, unchanged, or changed.
 *
 * This is what makes a daily run cheap: an unchanged job keeps its stored
 * contentHash, hits the evaluation cache, and never reaches a model.
 */
export class JobRepository {
  /**
   * Upsert on (source, externalId). firstSeenAt is preserved on update so job
   * history survives; lastSeenAt always moves forward.
   */
  async upsert(job: NormalizedJob): Promise<UpsertResult> {
    const db = getDb();
    const now = new Date().toISOString();

    const existing = db
      .prepare<[string, string], Pick<JobRow, 'id' | 'content_hash' | 'first_seen_at'>>(
        'SELECT id, content_hash, first_seen_at FROM jobs WHERE source = ? AND external_id = ?',
      )
      .get(job.source, job.externalId);

    if (!existing) {
      const info = db
        .prepare(
          `INSERT INTO jobs (
             source, external_id, company, title, description, location, remote,
             salary, experience_required, skills, url, application_url, posted_at,
             first_seen_at, last_seen_at, fingerprint, content_hash, raw_data,
             created_at, updated_at
           ) VALUES (
             @source, @external_id, @company, @title, @description, @location, @remote,
             @salary, @experience_required, @skills, @url, @application_url, @posted_at,
             @first_seen_at, @last_seen_at, @fingerprint, @content_hash, @raw_data,
             @created_at, @updated_at
           )`,
        )
        .run({ ...jobToRow(job), created_at: now, updated_at: now });

      return {
        job: { ...job, id: String(info.lastInsertRowid), isNew: true },
        state: 'NEW',
      };
    }

    const changed = existing.content_hash !== job.contentHash;

    db.prepare(
      `UPDATE jobs SET
         company = @company, title = @title, description = @description,
         location = @location, remote = @remote, salary = @salary,
         experience_required = @experience_required, skills = @skills,
         url = @url, application_url = @application_url, posted_at = @posted_at,
         last_seen_at = @last_seen_at, fingerprint = @fingerprint,
         content_hash = @content_hash, raw_data = @raw_data, updated_at = @updated_at
       WHERE id = @id`,
      // first_seen_at is deliberately absent: never let a re-scrape rewrite history.
    ).run({ ...jobToRow(job), id: existing.id, updated_at: now });

    return {
      job: {
        ...job,
        firstSeenAt: toDateRequired(existing.first_seen_at),
        id: String(existing.id),
        isNew: false,
      },
      state: changed ? 'CHANGED' : 'UNCHANGED',
    };
  }

  async upsertMany(jobs: NormalizedJob[]): Promise<UpsertResult[]> {
    const results: UpsertResult[] = [];
    for (const job of jobs) results.push(await this.upsert(job));
    return results;
  }

  async saveEvaluation(
    evaluation: FinalEvaluation,
    jobId: string,
    runId: string | null,
  ): Promise<void> {
    const snapshot = (source: FinalEvaluation['localEvaluation']) =>
      source
        ? toJson({
            score: source.score,
            confidence: source.confidence,
            recommendation: source.recommendation,
            matchingSkills: source.matchingSkills,
            missingSkills: source.missingSkills,
            reasons: source.reasons,
            concerns: source.concerns,
            needsCloud: source.needsCloud,
            escalationReason: source.escalationReason,
          })
        : null;

    getDb()
      .prepare(
        `INSERT INTO job_evaluations (
           job_id, run_id, provider, model, local_model, provider_used,
           score, confidence, recommendation, matching_skills, missing_skills,
           reasons, concerns, needs_cloud, escalated, escalation_reason, degraded,
           local_evaluation, cloud_evaluation, content_hash, created_at
         ) VALUES (
           @job_id, @run_id, @provider, @model, @local_model, @provider_used,
           @score, @confidence, @recommendation, @matching_skills, @missing_skills,
           @reasons, @concerns, @needs_cloud, @escalated, @escalation_reason, @degraded,
           @local_evaluation, @cloud_evaluation, @content_hash, @created_at
         )`,
      )
      .run({
        job_id: Number(jobId),
        run_id: runId === null ? null : Number(runId),
        provider: evaluation.provider,
        model: evaluation.model,
        local_model: evaluation.localModel,
        provider_used: evaluation.providerUsed,
        score: evaluation.score,
        confidence: evaluation.confidence,
        recommendation: evaluation.recommendation,
        matching_skills: toJson(evaluation.matchingSkills),
        missing_skills: toJson(evaluation.missingSkills),
        reasons: toJson(evaluation.reasons),
        concerns: toJson(evaluation.concerns),
        needs_cloud: fromBool(evaluation.needsCloud),
        escalated: fromBool(evaluation.escalated),
        escalation_reason: toJson(evaluation.escalationReasons),
        degraded: fromBool(evaluation.degraded),
        local_evaluation: snapshot(evaluation.localEvaluation),
        cloud_evaluation: snapshot(evaluation.cloudEvaluation),
        content_hash: evaluation.contentHash,
        created_at: new Date().toISOString(),
      });
  }

  /** Records the profile that produced a run's evaluations, once per version. */
  async recordProfile(profile: CandidateProfile, name = 'default'): Promise<string> {
    const db = getDb();
    const profileHash = sha256(JSON.stringify(profile));

    const existing = db
      .prepare<[string, string], { id: number }>(
        'SELECT id FROM candidate_profiles WHERE name = ? AND profile_hash = ?',
      )
      .get(name, profileHash);
    if (existing) return String(existing.id);

    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO candidate_profiles (name, profile_hash, data, active_from, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, profileHash, toJson(profile), now, now, now);

    return String(info.lastInsertRowid);
  }

  /** Latest evaluation per job, for `jobs:export` without re-running the LLM. */
  async latestEvaluations(jobIds: string[]): Promise<Map<string, FinalEvaluation>> {
    const out = new Map<string, FinalEvaluation>();
    if (jobIds.length === 0) return out;

    const rows = getDb()
      .prepare<number[], EvaluationRow>(
        `SELECT * FROM job_evaluations
          WHERE job_id IN (${placeholders(jobIds.length)})
          ORDER BY created_at DESC, id DESC`,
      )
      .all(...jobIds.map(Number));

    for (const row of rows) {
      const key = String(row.job_id);
      if (out.has(key)) continue;
      out.set(key, {
        jobId: key,
        score: row.score,
        confidence: row.confidence,
        recommendation: row.recommendation,
        matchingSkills: fromJson<string[]>(row.matching_skills, []),
        missingSkills: fromJson<string[]>(row.missing_skills, []),
        reasons: fromJson<string[]>(row.reasons, []),
        concerns: fromJson<string[]>(row.concerns, []),
        needsCloud: toBool(row.needs_cloud),
        escalationReason: null,
        uncertainties: {
          seniority: false,
          experience: false,
          salary: false,
          requirements: false,
          conflicting: false,
        },
        providerUsed: row.provider_used,
        localEvaluation: null,
        cloudEvaluation: null,
        escalated: toBool(row.escalated),
        escalationReasons: [],
        degraded: toBool(row.degraded),
        provider: row.provider,
        model: row.model,
        localModel: row.local_model ?? row.model,
        contentHash: row.content_hash,
        fromCache: true,
      } as FinalEvaluation);
    }
    return out;
  }

  async findJobsById(ids: string[]): Promise<Map<string, NormalizedJob>> {
    const out = new Map<string, NormalizedJob>();
    if (ids.length === 0) return out;

    const rows = getDb()
      .prepare<number[], JobRow>(`SELECT * FROM jobs WHERE id IN (${placeholders(ids.length)})`)
      .all(...ids.map(Number));

    for (const row of rows) out.set(String(row.id), rowToJob(row));
    return out;
  }

  /** Backs `jobs:export`: the jobs seen on or after `since`. */
  async findRecentJobs(since: Date, limit = 500): Promise<StoredJob[]> {
    const sinceIso = since.toISOString();

    const rows = getDb()
      .prepare<[string, number], JobRow>(
        `SELECT * FROM jobs WHERE last_seen_at >= ? ORDER BY first_seen_at DESC LIMIT ?`,
      )
      .all(sinceIso, limit);

    return rows.map((row) => ({
      ...rowToJob(row),
      id: String(row.id),
      isNew: row.first_seen_at >= sinceIso,
    }));
  }
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function jobToRow(job: NormalizedJob) {
  return {
    source: job.source,
    external_id: job.externalId,
    company: job.company,
    title: job.title,
    description: job.description,
    location: job.location,
    remote: job.remote,
    salary: job.salary === null ? null : toJson(job.salary),
    experience_required: job.experienceRequired === null ? null : toJson(job.experienceRequired),
    skills: toJson(job.skills),
    url: job.url,
    application_url: job.applicationUrl,
    posted_at: toIso(job.postedAt),
    first_seen_at: toIsoRequired(job.firstSeenAt),
    last_seen_at: toIsoRequired(job.lastSeenAt),
    fingerprint: job.fingerprint,
    content_hash: job.contentHash,
    raw_data: toJson(job.rawData),
  };
}

export function rowToJob(row: JobRow): NormalizedJob {
  return {
    source: row.source,
    externalId: row.external_id,
    company: row.company,
    title: row.title,
    description: row.description ?? '',
    location: row.location ?? null,
    remote: row.remote ?? null,
    salary: fromJson(row.salary, null),
    experienceRequired: fromJson(row.experience_required, null),
    skills: fromJson<string[]>(row.skills, []),
    url: row.url,
    applicationUrl: row.application_url ?? null,
    postedAt: toDate(row.posted_at),
    firstSeenAt: toDateRequired(row.first_seen_at),
    lastSeenAt: toDateRequired(row.last_seen_at),
    fingerprint: row.fingerprint,
    contentHash: row.content_hash,
    rawData: fromJson<Record<string, unknown>>(row.raw_data, {}),
  };
}
