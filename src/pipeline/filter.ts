import type { NormalizedJob } from '../domain/job.schema.js';
import type { CandidateProfile } from '../domain/profile.schema.js';
import { containsAnyKeyword, normalizeKey, tokenSetSimilarity } from '../util/text.js';

export type FilterRuleName =
  | 'TITLE_RELEVANCE'
  | 'EXCLUDED_ROLE'
  | 'EXCLUDED_KEYWORD'
  | 'EXCLUDED_INDUSTRY'
  | 'LOCATION'
  | 'REMOTE_PREFERENCE'
  | 'EXPERIENCE'
  | 'SALARY'
  | 'REQUIRED_SKILLS';

export interface FilterDecision {
  passed: boolean;
  rule: FilterRuleName | null;
  reason: string;
}

export interface FilterConfig {
  /** Similarity between the posting title and the closest target role. */
  titleSimilarityThreshold: number;
  /** How many more years than the candidate has a posting may demand. */
  experienceOverheadYears: number;
  /** How many fewer years a posting's maximum may be below the candidate. */
  experienceUnderheadYears: number;
  enableTitleRelevance: boolean;
  enableLocation: boolean;
  enableExperience: boolean;
  enableSalary: boolean;
  enableRequiredSkills: boolean;
  /** Of the profile's requiredSkills, the fraction a posting must mention. */
  requiredSkillsMinRatio: number;
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  titleSimilarityThreshold: 0.2,
  experienceOverheadYears: 4,
  experienceUnderheadYears: 3,
  enableTitleRelevance: true,
  enableLocation: true,
  enableExperience: true,
  enableSalary: true,
  enableRequiredSkills: false,
  requiredSkillsMinRatio: 0.3,
};

export interface FilterOutcome {
  job: NormalizedJob;
  decision: FilterDecision;
}

export interface FilterResult {
  passed: NormalizedJob[];
  rejected: FilterOutcome[];
  /** Count of rejections per rule, for the run summary. */
  ruleCounts: Record<string, number>;
}

const pass = (reason: string): FilterDecision => ({ passed: true, rule: null, reason });
const reject = (rule: FilterRuleName, reason: string): FilterDecision => ({
  passed: false,
  rule,
  reason,
});

/**
 * Cheap local gate applied before any LLM call.
 *
 * The governing rule: only an AFFIRMATIVE conflict rejects. A posting that does
 * not state its salary, location, or experience is not rejected for it — missing
 * information is `unknown` and is left for the model to weigh.
 */
export function evaluateFilters(
  job: NormalizedJob,
  profile: CandidateProfile,
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): FilterDecision {
  const haystack = `${job.title} ${job.description}`;

  // --- Exclusions: explicit candidate vetoes, checked first and cheaply. ---
  const excludedRole = containsAnyKeyword(job.title, profile.excludedRoles);
  if (excludedRole) {
    return reject('EXCLUDED_ROLE', `title matches excluded role "${excludedRole}"`);
  }

  const excludedKeyword = containsAnyKeyword(haystack, profile.excludedKeywords);
  if (excludedKeyword) {
    return reject('EXCLUDED_KEYWORD', `contains excluded keyword "${excludedKeyword}"`);
  }

  const excludedIndustry = containsAnyKeyword(
    `${job.company} ${job.description}`,
    profile.excludedIndustries,
  );
  if (excludedIndustry) {
    return reject('EXCLUDED_INDUSTRY', `matches excluded industry "${excludedIndustry}"`);
  }

  // --- Title relevance against target roles. ---
  if (config.enableTitleRelevance && profile.targetRoles.length > 0) {
    const title = normalizeKey(job.title);
    const best = Math.max(
      ...profile.targetRoles.map((role) => tokenSetSimilarity(title, normalizeKey(role))),
    );
    if (best < config.titleSimilarityThreshold) {
      return reject(
        'TITLE_RELEVANCE',
        `title "${job.title}" is unrelated to target roles (similarity ${best.toFixed(2)})`,
      );
    }
  }

  // --- Location / remote. Unknown location never rejects. ---
  if (config.enableLocation) {
    const locationDecision = checkLocation(job, profile);
    if (!locationDecision.passed) return locationDecision;
  }

  // --- Experience. Only rejects on a stated, clearly incompatible band. ---
  if (config.enableExperience && job.experienceRequired) {
    const { minYears, maxYears } = job.experienceRequired;
    const candidateYears = profile.yearsOfExperience;

    if (minYears !== null && minYears > candidateYears + config.experienceOverheadYears) {
      return reject('EXPERIENCE', `requires ${minYears}+ years, candidate has ${candidateYears}`);
    }
    if (maxYears !== null && maxYears < candidateYears - config.experienceUnderheadYears) {
      return reject(
        'EXPERIENCE',
        `caps experience at ${maxYears} years, candidate has ${candidateYears}`,
      );
    }
  }

  // --- Salary. Only rejects when a maximum is stated and is below the floor. ---
  if (config.enableSalary && profile.salary.minimum !== undefined && job.salary) {
    const ceiling = job.salary.max ?? job.salary.min;
    const comparable = job.salary.period === null || job.salary.period === 'YEARLY';
    if (ceiling !== null && comparable && ceiling > 0 && ceiling < profile.salary.minimum) {
      return reject('SALARY', `offers up to ${ceiling}, below minimum ${profile.salary.minimum}`);
    }
  }

  // --- Required skills. Off by default: descriptions omit skills constantly. ---
  if (config.enableRequiredSkills && profile.requiredSkills.length > 0) {
    const text = `${haystack} ${job.skills.join(' ')}`;
    const matched = profile.requiredSkills.filter((skill) => containsAnyKeyword(text, [skill]));
    const ratio = matched.length / profile.requiredSkills.length;
    if (ratio < config.requiredSkillsMinRatio) {
      return reject(
        'REQUIRED_SKILLS',
        `mentions ${matched.length}/${profile.requiredSkills.length} required skills`,
      );
    }
  }

  return pass('passed all deterministic filters');
}

function checkLocation(job: NormalizedJob, profile: CandidateProfile): FilterDecision {
  const preference = profile.remotePreference;

  // Remote roles are location-compatible by definition.
  if (job.remote === 'REMOTE') return pass('remote role');

  if (preference === 'REMOTE_ONLY') {
    // Only reject when the posting affirmatively says it is not remote.
    if (job.remote === 'ONSITE' || job.remote === 'HYBRID') {
      return reject('REMOTE_PREFERENCE', `role is ${job.remote} but candidate requires remote`);
    }
    return pass('remote status not stated — left for the model');
  }

  // No stated location, or no stated preference: nothing to conflict with.
  if (!job.location || profile.preferredLocations.length === 0) {
    return pass('location unknown or unconstrained');
  }

  const jobLocation = normalizeKey(job.location);
  const matches = profile.preferredLocations.some((preferred) => {
    const norm = normalizeKey(preferred);
    if (!norm) return false;
    if (norm === 'anywhere' || norm === 'any') return true;
    return jobLocation.includes(norm) || norm.includes(jobLocation);
  });

  if (!matches) {
    return reject('LOCATION', `location "${job.location}" is not among preferred locations`);
  }
  return pass('location matches a preferred location');
}

export function applyFilters(
  jobs: NormalizedJob[],
  profile: CandidateProfile,
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): FilterResult {
  const passed: NormalizedJob[] = [];
  const rejected: FilterOutcome[] = [];
  const ruleCounts: Record<string, number> = {};

  for (const job of jobs) {
    const decision = evaluateFilters(job, profile, config);
    if (decision.passed) {
      passed.push(job);
    } else {
      rejected.push({ job, decision });
      const key = decision.rule ?? 'UNKNOWN';
      ruleCounts[key] = (ruleCounts[key] ?? 0) + 1;
    }
  }

  return { passed, rejected, ruleCounts };
}
