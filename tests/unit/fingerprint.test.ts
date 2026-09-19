import { describe, expect, it } from 'vitest';
import { computeContentHash, computeFingerprint } from '../../src/pipeline/fingerprint.js';
import { normalizeCompany, normalizeTitle, normalizeUrl } from '../../src/util/text.js';

describe('fingerprinting', () => {
  const base = {
    company: 'Meridian Labs',
    title: 'Senior Backend Engineer',
    location: 'Bengaluru, India',
    url: 'https://jobs.example.com/roles/123',
  };

  it('is deterministic', () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint(base));
  });

  it('ignores case and punctuation differences', () => {
    expect(computeFingerprint({ ...base, company: 'MERIDIAN  LABS!' })).toBe(
      computeFingerprint(base),
    );
  });

  it('ignores company legal suffixes', () => {
    expect(computeFingerprint({ ...base, company: 'Meridian Labs Pvt Ltd' })).toBe(
      computeFingerprint(base),
    );
  });

  it('ignores tracking parameters in the URL', () => {
    expect(
      computeFingerprint({ ...base, url: 'https://jobs.example.com/roles/123?utm_source=email' }),
    ).toBe(computeFingerprint(base));
  });

  it('differs when the job is genuinely different', () => {
    expect(computeFingerprint({ ...base, title: 'Frontend Engineer' })).not.toBe(
      computeFingerprint(base),
    );
    expect(computeFingerprint({ ...base, location: 'Pune, India' })).not.toBe(
      computeFingerprint(base),
    );
  });

  it('handles null fields without throwing', () => {
    expect(
      computeFingerprint({ company: null, title: null, location: null, url: null }),
    ).toHaveLength(64);
  });
});

describe('content hashing', () => {
  const base = {
    title: 'Backend Engineer',
    company: 'Acme',
    description: 'Build services.',
    salaryRaw: '₹30 LPA',
    experienceRaw: '5 years',
    skills: ['Node.js', 'TypeScript'],
  };

  it('is stable for identical content', () => {
    expect(computeContentHash(base)).toBe(computeContentHash(base));
  });

  it('is insensitive to skill ordering', () => {
    expect(computeContentHash({ ...base, skills: ['TypeScript', 'Node.js'] })).toBe(
      computeContentHash(base),
    );
  });

  it('changes when the description changes — this is what triggers re-evaluation', () => {
    expect(
      computeContentHash({ ...base, description: 'Build services. Now with Kafka.' }),
    ).not.toBe(computeContentHash(base));
  });

  it('changes when the salary changes', () => {
    expect(computeContentHash({ ...base, salaryRaw: '₹40 LPA' })).not.toBe(
      computeContentHash(base),
    );
  });
});

describe('normalisation helpers', () => {
  it('strips legal suffixes from company names', () => {
    expect(normalizeCompany('Acme Technologies Pvt. Ltd.')).toBe('acme');
  });

  it('strips recruiter noise from titles', () => {
    expect(normalizeTitle('URGENT!!! Backend Developer - Immediate Joiners')).toContain(
      'backend developer',
    );
    expect(normalizeTitle('URGENT!!! Backend Developer')).not.toContain('urgent');
  });

  it('canonicalises URLs', () => {
    expect(normalizeUrl('HTTP://WWW.Example.com/Jobs/1/?utm_source=x#top')).toBe(
      'https://example.com/jobs/1',
    );
  });

  it('leaves an unparseable URL usable rather than empty', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});
