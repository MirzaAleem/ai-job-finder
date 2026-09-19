import type { FinalEvaluation } from '../domain/evaluation.schema.js';

export interface CachedEvaluation {
  score: number;
  confidence: number;
  recommendation: FinalEvaluation['recommendation'];
  matchingSkills: string[];
  missingSkills: string[];
  reasons: string[];
  concerns: string[];
  providerUsed: FinalEvaluation['providerUsed'];
  provider: string;
  model: string;
}

/**
 * Keyed on (contentHash, model) rather than job id: the same posting re-scraped
 * with an unchanged description must not cost a single token, and a model change
 * must invalidate every prior judgement.
 */
export interface EvaluationCache {
  get(contentHash: string, model: string): Promise<CachedEvaluation | null>;
  set(contentHash: string, model: string, value: CachedEvaluation): Promise<void>;
}

export class InMemoryEvaluationCache implements EvaluationCache {
  private readonly store = new Map<string, CachedEvaluation>();

  private key(contentHash: string, model: string): string {
    return `${model}::${contentHash}`;
  }

  async get(contentHash: string, model: string): Promise<CachedEvaluation | null> {
    return this.store.get(this.key(contentHash, model)) ?? null;
  }

  async set(contentHash: string, model: string, value: CachedEvaluation): Promise<void> {
    this.store.set(this.key(contentHash, model), value);
  }

  get size(): number {
    return this.store.size;
  }
}

/** Used when LLM_CACHE_ENABLED=false. */
export class NoopEvaluationCache implements EvaluationCache {
  async get(): Promise<CachedEvaluation | null> {
    return null;
  }
  async set(): Promise<void> {
    /* intentionally empty */
  }
}
