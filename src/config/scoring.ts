import type { Recommendation } from '../domain/evaluation.schema.js';
import type { Env } from './env.js';

export interface ScoreThresholds {
  highPriority: number;
  apply: number;
  consider: number;
}

export function thresholdsFromEnv(env: Env): ScoreThresholds {
  return {
    highPriority: env.SCORE_HIGH_PRIORITY,
    apply: env.SCORE_APPLY,
    consider: env.SCORE_CONSIDER,
  };
}

/**
 * The score is the source of truth for the recommendation label. The model is
 * asked for both, but we recompute so a model that scores 95 and then labels it
 * SKIP cannot produce an inconsistent row in the CSV.
 */
export function recommendationForScore(score: number, t: ScoreThresholds): Recommendation {
  if (score >= t.highPriority) return 'HIGH_PRIORITY';
  if (score >= t.apply) return 'APPLY';
  if (score >= t.consider) return 'CONSIDER';
  return 'SKIP';
}
