import { getDb } from './connection.js';
import { fromJson } from './mapping.js';
import type { EvaluationRow } from './rows.js';
import type { CachedEvaluation, EvaluationCache } from '../llm/cache.js';

/**
 * SQLite-backed cache. There is no separate cache table: a prior evaluation of
 * the same content by the same model IS the cache entry.
 */
export class SqliteEvaluationCache implements EvaluationCache {
  /** Per-process memo so a repeated hash inside one run does not re-query. */
  private readonly memo = new Map<string, CachedEvaluation | null>();

  async get(contentHash: string, model: string): Promise<CachedEvaluation | null> {
    const key = `${model}::${contentHash}`;
    if (this.memo.has(key)) return this.memo.get(key) ?? null;

    // `model` here is the LOCAL model. Matching on local_model means a job that
    // escalated still hits the cache and does not re-pay for the cloud.
    const row = getDb()
      .prepare<[string, string], EvaluationRow>(
        `SELECT * FROM job_evaluations
          WHERE content_hash = ? AND local_model = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(contentHash, model);

    const value: CachedEvaluation | null = row
      ? {
          score: row.score,
          confidence: row.confidence,
          recommendation: row.recommendation,
          matchingSkills: fromJson<string[]>(row.matching_skills, []),
          missingSkills: fromJson<string[]>(row.missing_skills, []),
          reasons: fromJson<string[]>(row.reasons, []),
          concerns: fromJson<string[]>(row.concerns, []),
          providerUsed: row.provider_used,
          provider: row.provider,
          model: row.model,
        }
      : null;

    this.memo.set(key, value);
    return value;
  }

  async set(contentHash: string, model: string, value: CachedEvaluation): Promise<void> {
    // Writing the job_evaluations row is what persists the cache entry; here we
    // only keep the in-process memo coherent.
    this.memo.set(`${model}::${contentHash}`, value);
  }
}
