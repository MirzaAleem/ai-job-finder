import type { RankedJob } from '../export/types.js';

/**
 * Sort order: score first, then newly-discovered jobs, then most recently
 * posted. The daily report exists to surface what changed, so a new job beats
 * an equally-scored one you have already seen.
 */
export function rankJobs(items: RankedJob[]): RankedJob[] {
  return [...items].sort((a, b) => {
    if (b.evaluation.score !== a.evaluation.score) {
      return b.evaluation.score - a.evaluation.score;
    }
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;

    const aPosted = a.job.postedAt?.getTime() ?? 0;
    const bPosted = b.job.postedAt?.getTime() ?? 0;
    if (bPosted !== aPosted) return bPosted - aPosted;

    if (b.evaluation.confidence !== a.evaluation.confidence) {
      return b.evaluation.confidence - a.evaluation.confidence;
    }
    return a.job.company.localeCompare(b.job.company);
  });
}

export interface RecommendationCounts {
  HIGH_PRIORITY: number;
  APPLY: number;
  CONSIDER: number;
  SKIP: number;
}

export function countRecommendations(items: RankedJob[]): RecommendationCounts {
  const counts: RecommendationCounts = { HIGH_PRIORITY: 0, APPLY: 0, CONSIDER: 0, SKIP: 0 };
  for (const item of items) counts[item.evaluation.recommendation] += 1;
  return counts;
}
