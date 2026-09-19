import { describe, expect, it } from 'vitest';
import { applyFilters, DEFAULT_FILTER_CONFIG, evaluateFilters } from '../../src/pipeline/filter.js';
import { job, testProfile } from '../helpers/fixtures.js';

const check = (overrides = {}, config = DEFAULT_FILTER_CONFIG) =>
  evaluateFilters(job(overrides), testProfile, config);

describe('deterministic filtering', () => {
  it('passes a well-matched job', () => {
    expect(check().passed).toBe(true);
  });

  it('rejects an excluded role by title', () => {
    const decision = check({ title: 'Technical Support Engineer' });
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('EXCLUDED_ROLE');
  });

  it('rejects an excluded keyword anywhere in the posting', () => {
    const decision = check({ description: 'Great role. Note: bond required for 2 years.' });
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('EXCLUDED_KEYWORD');
  });

  it('rejects an excluded industry', () => {
    const decision = check({
      company: 'Ironclad Defence Systems',
      description: 'Defence software.',
    });
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('EXCLUDED_INDUSTRY');
  });

  it('rejects a completely unrelated title', () => {
    const decision = check({ title: 'Legal Operations Associate' });
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('TITLE_RELEVANCE');
  });

  it('rejects a job demanding far more experience than the candidate has', () => {
    const decision = check({ experience: '15+ years' });
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('EXPERIENCE');
  });

  it('rejects a job capped far below the candidate', () => {
    const decision = check({ experience: '0-2 years' });
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('EXPERIENCE');
  });

  it('accepts a job slightly above the candidate experience', () => {
    expect(check({ experience: '8-12 years' }).passed).toBe(true);
  });

  it('rejects a job whose stated ceiling is below the salary floor', () => {
    const decision = check({ salary: '₹8-12 LPA' });
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('SALARY');
  });

  it('rejects a location that is not among the preferred ones', () => {
    const decision = check({ location: 'Kolkata, India', remote: 'On-site' });
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('LOCATION');
  });

  it('accepts a remote job regardless of its stated city', () => {
    expect(check({ location: 'Kolkata, India', remote: 'Fully remote' }).passed).toBe(true);
  });
});

describe('missing information is never a rejection reason', () => {
  it('does not reject a job with no salary stated', () => {
    expect(check({ salary: null }).passed).toBe(true);
  });

  it('does not reject a job whose salary is "Not disclosed"', () => {
    expect(check({ salary: 'Not disclosed' }).passed).toBe(true);
  });

  it('does not reject a job with no experience stated', () => {
    expect(check({ experience: null }).passed).toBe(true);
  });

  it('does not reject a job with no location stated', () => {
    expect(check({ location: null, remote: null }).passed).toBe(true);
  });

  it('does not reject a job with an empty description', () => {
    expect(check({ description: '' }).passed).toBe(true);
  });

  it('does not reject on unstated remote status even for a REMOTE_ONLY candidate', () => {
    const remoteOnly = { ...testProfile, remotePreference: 'REMOTE_ONLY' as const };
    const decision = evaluateFilters(job({ remote: null, location: null }), remoteOnly);
    expect(decision.passed).toBe(true);
  });

  it('does reject an explicitly onsite job for a REMOTE_ONLY candidate', () => {
    const remoteOnly = { ...testProfile, remotePreference: 'REMOTE_ONLY' as const };
    const decision = evaluateFilters(job({ remote: 'On-site' }), remoteOnly);
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('REMOTE_PREFERENCE');
  });
});

describe('filter configuration', () => {
  it('can disable individual rules', () => {
    const decision = check(
      { salary: '₹8-12 LPA' },
      { ...DEFAULT_FILTER_CONFIG, enableSalary: false },
    );
    expect(decision.passed).toBe(true);
  });

  it('can enforce required skills when opted in', () => {
    const decision = check(
      { title: 'Backend Engineer', description: 'COBOL mainframe work.', skills: [] },
      { ...DEFAULT_FILTER_CONFIG, enableRequiredSkills: true },
    );
    expect(decision.passed).toBe(false);
    expect(decision.rule).toBe('REQUIRED_SKILLS');
  });

  it('leaves required-skill filtering off by default', () => {
    expect(check({ description: 'COBOL mainframe work.', skills: [] }).passed).toBe(true);
  });
});

describe('applyFilters', () => {
  it('partitions jobs and counts rejections by rule', () => {
    const result = applyFilters(
      [
        job({ externalId: '1', url: 'https://x.test/1' }),
        job({ externalId: '2', url: 'https://x.test/2', title: 'Sales Executive' }),
        job({ externalId: '3', url: 'https://x.test/3', title: 'Technical Support Engineer' }),
      ],
      testProfile,
    );
    expect(result.passed).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.ruleCounts.EXCLUDED_ROLE).toBe(2);
  });

  it('records a human-readable reason for every rejection', () => {
    const result = applyFilters([job({ title: 'Sales Executive' })], testProfile);
    expect(result.rejected[0]?.decision.reason).toContain('Sales');
  });
});
