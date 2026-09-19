import { describe, expect, it } from 'vitest';
import { parseProfile, ProfileValidationError } from '../../src/config/profile.js';
import { CandidateProfileSchema, toPromptProfile } from '../../src/domain/profile.schema.js';
import { testProfile } from '../helpers/fixtures.js';

describe('profile validation', () => {
  it('accepts a minimal profile and applies defaults', () => {
    const profile = parseProfile({ targetRoles: ['Backend Engineer'], yearsOfExperience: 3 });
    expect(profile.remotePreference).toBe('ANY');
    expect(profile.preferredLocations).toEqual([]);
    expect(profile.excludedKeywords).toEqual([]);
    expect(profile.salary.currency).toBe('INR');
  });

  it('rejects a profile with no target roles', () => {
    expect(() => parseProfile({ targetRoles: [], yearsOfExperience: 3 })).toThrow(
      ProfileValidationError,
    );
  });

  it('rejects a profile missing yearsOfExperience', () => {
    expect(() => parseProfile({ targetRoles: ['Backend Engineer'] })).toThrow(
      ProfileValidationError,
    );
  });

  it('rejects unknown keys rather than silently ignoring a typo', () => {
    expect(() =>
      parseProfile({ targetRoles: ['Backend'], yearsOfExperience: 3, targetRole: 'oops' }),
    ).toThrow(ProfileValidationError);
  });

  it('rejects an invalid remotePreference', () => {
    expect(() =>
      parseProfile({ targetRoles: ['Backend'], yearsOfExperience: 3, remotePreference: 'MAYBE' }),
    ).toThrow(ProfileValidationError);
  });

  it('rejects a negative or absurd experience value', () => {
    expect(() => parseProfile({ targetRoles: ['Backend'], yearsOfExperience: -1 })).toThrow();
    expect(() => parseProfile({ targetRoles: ['Backend'], yearsOfExperience: 99 })).toThrow();
  });

  it('reports the offending field in the error message', () => {
    try {
      parseProfile({ targetRoles: [], yearsOfExperience: 3 }, 'config/profile.yaml');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(String(err)).toContain('targetRoles');
      expect(String(err)).toContain('config/profile.yaml');
    }
  });

  it('turns unknown optional fields into explicit "unknown" for the prompt', () => {
    const sparse = CandidateProfileSchema.parse({
      targetRoles: ['Backend Engineer'],
      yearsOfExperience: 4,
    });
    const prompt = toPromptProfile(sparse);
    expect(prompt.education).toBe('unknown');
    expect(prompt.workAuthorization).toBe('unknown');
    expect(prompt.noticePeriod).toBe('unknown');
  });

  it('round-trips the full test profile', () => {
    expect(CandidateProfileSchema.parse(testProfile)).toEqual(testProfile);
  });
});
