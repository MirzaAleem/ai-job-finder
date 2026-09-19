import type { CandidateProfile } from '../../src/domain/profile.schema.js';
import { CandidateProfileSchema } from '../../src/domain/profile.schema.js';
import type { NormalizedJob, RawJob } from '../../src/domain/job.schema.js';
import { normalizeJob } from '../../src/pipeline/normalize.js';
import { loadEnv, type Env } from '../../src/config/env.js';

export const testProfile: CandidateProfile = CandidateProfileSchema.parse({
  targetRoles: ['Backend Engineer', 'Senior Backend Engineer', 'Software Engineer'],
  preferredLocations: ['Bengaluru', 'Remote'],
  remotePreference: 'REMOTE_PREFERRED',
  yearsOfExperience: 6,
  salary: { currency: 'INR', minimum: 2_500_000, preferred: 4_000_000 },
  requiredSkills: ['TypeScript', 'Node.js', 'PostgreSQL'],
  preferredSkills: ['AWS', 'Docker'],
  excludedRoles: ['Sales', 'Technical Support'],
  excludedIndustries: ['Gambling', 'Defence'],
  excludedKeywords: ['bond required', 'unpaid'],
  education: 'B.Tech',
  workAuthorization: 'Indian citizen',
  noticePeriod: '60 days',
});

export function rawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'test',
    externalId: 'test-1',
    company: 'Acme Corp',
    title: 'Senior Backend Engineer',
    description: 'Build backend services with TypeScript and Node.js.',
    location: 'Bengaluru, India',
    remote: 'Hybrid',
    salary: '₹30-45 LPA',
    experience: '5-8 years',
    skills: ['TypeScript', 'Node.js'],
    url: 'https://example-jobs.test/test/test-1',
    applicationUrl: null,
    postedAt: '2 days ago',
    rawData: {},
    ...overrides,
  };
}

export function job(overrides: Partial<RawJob> = {}): NormalizedJob {
  return normalizeJob(rawJob(overrides), { now: new Date('2026-09-12T00:00:00Z') });
}

/** Env for tests: never reads the developer's real .env values. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    SQLITE_PATH: ':memory:',
    OLLAMA_MODEL: 'test-model',
    SOURCES_ENABLED: 'mock',
    OUTPUT_DIR: 'output/test',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
