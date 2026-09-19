import { describe, expect, it } from 'vitest';
import { decideEscalation, escalationWarranted } from '../../src/llm/escalation.js';
import { LLMEvaluationSchema, type LLMEvaluation } from '../../src/domain/evaluation.schema.js';

const config = { confidenceThreshold: 0.8, enabled: true };

function evaluation(overrides: Partial<LLMEvaluation> = {}): LLMEvaluation {
  return LLMEvaluationSchema.parse({
    score: 85,
    confidence: 0.92,
    recommendation: 'APPLY',
    ...overrides,
  });
}

describe('escalation rules', () => {
  it('does not escalate a confident, unflagged evaluation', () => {
    const decision = decideEscalation(evaluation(), config);
    expect(decision.shouldEscalate).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it('escalates below the confidence threshold', () => {
    const decision = decideEscalation(evaluation({ confidence: 0.62 }), config);
    expect(decision.shouldEscalate).toBe(true);
    expect(decision.reasons).toContain('LOW_CONFIDENCE');
  });

  it('treats the threshold as exclusive at the boundary', () => {
    expect(decideEscalation(evaluation({ confidence: 0.8 }), config).shouldEscalate).toBe(false);
    expect(decideEscalation(evaluation({ confidence: 0.79 }), config).shouldEscalate).toBe(true);
  });

  it('respects a configurable threshold', () => {
    const strict = { confidenceThreshold: 0.95, enabled: true };
    expect(decideEscalation(evaluation({ confidence: 0.92 }), strict).shouldEscalate).toBe(true);
  });

  it('escalates when the model asks for it', () => {
    const decision = decideEscalation(evaluation({ needsCloud: true }), config);
    expect(decision.shouldEscalate).toBe(true);
    expect(decision.reasons).toContain('MODEL_REQUESTED');
  });

  it('escalates on a malformed response with no evaluation at all', () => {
    const decision = decideEscalation(null, config, true);
    expect(decision.shouldEscalate).toBe(true);
    expect(decision.reasons).toEqual(['MALFORMED_RESPONSE']);
  });

  function withFlags(flags: Partial<LLMEvaluation['uncertainties']>, confidence = 0.92) {
    return evaluation({
      confidence,
      uncertainties: {
        seniority: false,
        experience: false,
        salary: false,
        requirements: false,
        conflicting: false,
        ...flags,
      },
    });
  }

  it('escalates on contradictory requirements alone — that needs a better model', () => {
    const decision = decideEscalation(withFlags({ conflicting: true }), config);
    expect(decision.shouldEscalate).toBe(true);
    expect(decision.reasons).toContain('CONFLICTING_REQUIREMENTS');
  });

  it.each([['requirements'], ['seniority'], ['experience'], ['salary']])(
    'does NOT escalate on a single soft %s flag when confidence is high',
    (flag) => {
      const decision = decideEscalation(
        withFlags({ [flag]: true } as Partial<LLMEvaluation['uncertainties']>),
        config,
      );
      expect(decision.shouldEscalate).toBe(false);
    },
  );

  it('escalates once two soft flags are set together', () => {
    const decision = decideEscalation(withFlags({ salary: true, seniority: true }), config);
    expect(decision.shouldEscalate).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(['UNCLEAR_SALARY', 'UNCLEAR_SENIORITY']),
    );
  });

  it('escalates on a single soft flag when confidence is also low', () => {
    const decision = decideEscalation(withFlags({ salary: true }, 0.5), config);
    expect(decision.shouldEscalate).toBe(true);
    expect(decision.reasons).toEqual(expect.arrayContaining(['LOW_CONFIDENCE', 'UNCLEAR_SALARY']));
  });

  it('honours a configurable soft-flag threshold', () => {
    const eager = { ...config, softFlagThreshold: 1 };
    expect(decideEscalation(withFlags({ salary: true }), eager).shouldEscalate).toBe(true);

    const reluctant = { ...config, softFlagThreshold: 3 };
    expect(
      decideEscalation(withFlags({ salary: true, seniority: true }), reluctant).shouldEscalate,
    ).toBe(false);
  });

  it('maps free-text escalation reasons onto the enum', () => {
    const decision = decideEscalation(
      evaluation({ escalationReason: 'The requirements contradict each other' }),
      config,
    );
    expect(decision.reasons).toContain('CONFLICTING_REQUIREMENTS');
  });

  it('collects every applicable reason, not just the first', () => {
    const decision = decideEscalation(
      evaluation({
        confidence: 0.4,
        needsCloud: true,
        uncertainties: {
          seniority: true,
          experience: true,
          salary: false,
          requirements: false,
          conflicting: false,
        },
      }),
      config,
    );
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'LOW_CONFIDENCE',
        'MODEL_REQUESTED',
        'UNCLEAR_SENIORITY',
        'UNCLEAR_EXPERIENCE',
      ]),
    );
  });

  it('does not escalate when escalation is globally disabled', () => {
    const decision = decideEscalation(evaluation({ confidence: 0.1 }), {
      ...config,
      enabled: false,
    });
    expect(decision.shouldEscalate).toBe(false);
    // The reasons are still reported, so the result can be marked degraded.
    expect(decision.reasons).toContain('LOW_CONFIDENCE');
  });

  it('still reports escalation as warranted when it is disabled', () => {
    expect(
      escalationWarranted(evaluation({ confidence: 0.1 }), { ...config, enabled: false }),
    ).toBe(true);
    expect(escalationWarranted(evaluation(), { ...config, enabled: false })).toBe(false);
  });
});
