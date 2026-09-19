import type { EscalationReason, LLMEvaluation } from '../domain/evaluation.schema.js';

export interface EscalationConfig {
  confidenceThreshold: number;
  enabled: boolean;
  /**
   * How many SOFT uncertainty flags must be set before they alone justify a
   * cloud call. Small local models flag "the posting didn't state a salary"
   * constantly, and that is normal, not a reason to spend money — the model's
   * own `confidence` is where vagueness is supposed to show up. Defaults to 2.
   */
  softFlagThreshold?: number;
}

export interface EscalationDecision {
  shouldEscalate: boolean;
  reasons: EscalationReason[];
}

/** Free-text escalationReason strings the local model may emit, mapped to our enum. */
const TEXT_HINTS: Array<[RegExp, EscalationReason]> = [
  [/conflict|contradict|inconsisten/i, 'CONFLICTING_REQUIREMENTS'],
  [/ambigu|vague|unclear requirement/i, 'AMBIGUOUS_REQUIREMENTS'],
  [/senior|level|junior|grade/i, 'UNCLEAR_SENIORITY'],
  [/experience|years/i, 'UNCLEAR_EXPERIENCE'],
  [/salary|compensation|pay|ctc/i, 'UNCLEAR_SALARY'],
  [/unusual|strange|odd|malformed description|gibberish/i, 'UNUSUAL_DESCRIPTION'],
];

/**
 * Pure decision function: given a parsed local evaluation, should this job go to
 * the cloud, and why? Kept free of I/O so the rules are directly testable.
 *
 * `parseFailed` covers both malformed JSON and a schema mismatch — in that case
 * there is no evaluation to inspect and escalation is automatic.
 */
export function decideEscalation(
  evaluation: LLMEvaluation | null,
  config: EscalationConfig,
  parseFailed = false,
): EscalationDecision {
  const reasons = new Set<EscalationReason>();

  if (parseFailed || evaluation === null) {
    reasons.add('MALFORMED_RESPONSE');
    return finalise(reasons, config);
  }

  // --- Hard triggers: each one alone justifies a cloud call. ---
  const lowConfidence = evaluation.confidence < config.confidenceThreshold;
  if (lowConfidence) reasons.add('LOW_CONFIDENCE');
  if (evaluation.needsCloud) reasons.add('MODEL_REQUESTED');

  const u = evaluation.uncertainties;
  // A self-contradictory posting is exactly what a stronger model is for.
  if (u.conflicting) reasons.add('CONFLICTING_REQUIREMENTS');

  // --- Soft triggers: "the posting did not say". Common and usually cheap to
  // live with, so these escalate only in bulk, or alongside low confidence. ---
  const softFlags: Array<[boolean, EscalationReason]> = [
    [u.requirements, 'AMBIGUOUS_REQUIREMENTS'],
    [u.seniority, 'UNCLEAR_SENIORITY'],
    [u.experience, 'UNCLEAR_EXPERIENCE'],
    [u.salary, 'UNCLEAR_SALARY'],
  ];
  const setSoftFlags = softFlags.filter(([isSet]) => isSet);
  const softThreshold = config.softFlagThreshold ?? 2;

  if (setSoftFlags.length >= softThreshold || (lowConfidence && setSoftFlags.length > 0)) {
    for (const [, reason] of setSoftFlags) reasons.add(reason);
  }

  // The model may explain itself in prose rather than via the flags.
  if (evaluation.escalationReason) {
    for (const [pattern, reason] of TEXT_HINTS) {
      if (pattern.test(evaluation.escalationReason)) {
        reasons.add(reason);
        break;
      }
    }
    if (reasons.size === 0) reasons.add('MODEL_REQUESTED');
  }

  return finalise(reasons, config);
}

function finalise(reasons: Set<EscalationReason>, config: EscalationConfig): EscalationDecision {
  const list = [...reasons];
  return { shouldEscalate: config.enabled && list.length > 0, reasons: list };
}

/**
 * Whether escalation was *warranted* regardless of whether it was possible.
 * Used to mark a result degraded when the cloud path is off or unavailable.
 */
export function escalationWarranted(
  evaluation: LLMEvaluation | null,
  config: EscalationConfig,
  parseFailed = false,
): boolean {
  return decideEscalation(evaluation, { ...config, enabled: true }, parseFailed).reasons.length > 0;
}
