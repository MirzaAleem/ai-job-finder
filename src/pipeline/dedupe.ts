import type { NormalizedJob } from '../domain/job.schema.js';
import {
  normalizeCompany,
  normalizeKey,
  normalizeTitle,
  normalizeUrl,
  tokenSetSimilarity,
} from '../util/text.js';

export type DedupeStrategy = 'EXTERNAL_ID' | 'URL' | 'FINGERPRINT' | 'FUZZY';

export interface DuplicatePair {
  kept: NormalizedJob;
  dropped: NormalizedJob;
  strategy: DedupeStrategy;
  similarity?: number;
}

export interface DedupeOptions {
  /** Jaccard similarity on company+title above which two postings are the same. */
  fuzzyThreshold?: number;
  enableFuzzy?: boolean;
}

export interface DedupeResult {
  jobs: NormalizedJob[];
  duplicates: DuplicatePair[];
}

/** Prefer the record with more information; ties go to the earlier one. */
function richness(job: NormalizedJob): number {
  let score = job.description.length;
  if (job.salary) score += 500;
  if (job.experienceRequired) score += 500;
  if (job.location) score += 200;
  if (job.remote) score += 200;
  score += job.skills.length * 50;
  if (job.postedAt) score += 100;
  if (job.applicationUrl) score += 100;
  return score;
}

/**
 * Layered deduplication, cheapest and most certain first. Fuzzy matching runs
 * last and is intentionally strict: a missed duplicate costs one extra row in a
 * CSV, while a wrong merge silently hides a real job.
 */
export function deduplicateJobs(input: NormalizedJob[], options: DedupeOptions = {}): DedupeResult {
  const fuzzyThreshold = options.fuzzyThreshold ?? 0.9;
  const enableFuzzy = options.enableFuzzy ?? true;

  const duplicates: DuplicatePair[] = [];
  const kept: NormalizedJob[] = [];

  const byExternalId = new Map<string, number>();
  const byUrl = new Map<string, number>();
  const byFingerprint = new Map<string, number>();

  const resolve = (
    existingIndex: number,
    incoming: NormalizedJob,
    strategy: DedupeStrategy,
    similarity?: number,
  ) => {
    const existing = kept[existingIndex];
    if (!existing) return;
    if (richness(incoming) > richness(existing)) {
      // Keep the richer record but preserve the earliest sighting.
      const merged: NormalizedJob = {
        ...incoming,
        firstSeenAt:
          existing.firstSeenAt < incoming.firstSeenAt ? existing.firstSeenAt : incoming.firstSeenAt,
      };
      kept[existingIndex] = merged;
      duplicates.push({
        kept: merged,
        dropped: existing,
        strategy,
        ...(similarity !== undefined ? { similarity } : {}),
      });
    } else {
      duplicates.push({
        kept: existing,
        dropped: incoming,
        strategy,
        ...(similarity !== undefined ? { similarity } : {}),
      });
    }
  };

  for (const job of input) {
    const idKey = `${job.source}::${job.externalId}`;
    const urlKey = normalizeUrl(job.url);

    // 1. Same source, same external id — certainly the same posting.
    const idHit = byExternalId.get(idKey);
    if (idHit !== undefined) {
      resolve(idHit, job, 'EXTERNAL_ID');
      continue;
    }

    // 2. Same canonical URL — the same posting, possibly via two sources.
    const urlHit = urlKey ? byUrl.get(urlKey) : undefined;
    if (urlHit !== undefined) {
      resolve(urlHit, job, 'URL');
      continue;
    }

    // 3. Identical deterministic fingerprint.
    const fpHit = byFingerprint.get(job.fingerprint);
    if (fpHit !== undefined) {
      resolve(fpHit, job, 'FINGERPRINT');
      continue;
    }

    // 4. Conservative fuzzy match: same company, same location, near-identical title.
    if (enableFuzzy) {
      let matchedIndex = -1;
      let matchedSimilarity = 0;
      const company = normalizeCompany(job.company);
      const title = normalizeTitle(job.title);
      const location = normalizeKey(job.location);

      for (let i = 0; i < kept.length; i += 1) {
        const other = kept[i];
        if (!other) continue;
        if (normalizeCompany(other.company) !== company) continue;
        // Different cities are different jobs, even with the same title.
        if (normalizeKey(other.location) !== location) continue;

        const similarity = tokenSetSimilarity(title, normalizeTitle(other.title));
        if (similarity >= fuzzyThreshold && similarity > matchedSimilarity) {
          matchedIndex = i;
          matchedSimilarity = similarity;
        }
      }

      if (matchedIndex !== -1) {
        resolve(matchedIndex, job, 'FUZZY', matchedSimilarity);
        continue;
      }
    }

    const index = kept.push(job) - 1;
    byExternalId.set(idKey, index);
    if (urlKey) byUrl.set(urlKey, index);
    byFingerprint.set(job.fingerprint, index);
  }

  return { jobs: kept, duplicates };
}
