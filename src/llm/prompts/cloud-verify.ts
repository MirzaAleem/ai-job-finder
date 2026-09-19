import type { CandidateProfile } from '../../domain/profile.schema.js';
import { toPromptProfile } from '../../domain/profile.schema.js';
import type { LLMEvaluation, EscalationReason } from '../../domain/evaluation.schema.js';
import { ESCALATION_REASON_LABELS } from '../../domain/evaluation.schema.js';
import type { PromptJob } from './local-eval.js';

export const CLOUD_SYSTEM_PROMPT = `You are a senior job-matching analyst acting as an expert reviewer. A smaller local model evaluated a job posting and flagged it as uncertain. Your job is to produce the correct evaluation.

You are NOT here to agree with the local model. Treat its evaluation as one opinion to be checked against the source text. If it is wrong, overrule it and say so in "reasons". If it is right, confirm it.

ABSOLUTE RULES:
1. Use ONLY the candidate profile and the job text provided. No outside knowledge about the company.
2. NEVER invent candidate skills, job requirements, seniority, or salary. Not stated means UNKNOWN.
3. UNKNOWN IS NOT NEGATIVE. Missing information reduces confidence, not score.
4. Resolve the specific ambiguity that caused the escalation, and state your resolution explicitly in "reasons".
5. If the posting genuinely cannot support a confident judgement, say so: return your best score with a low confidence and a clear "concerns" entry. Do not manufacture certainty.
6. Set needsCloud = false — you are the final reviewer.

Return ONLY a JSON object. No markdown, no commentary, no code fences.`;

export function buildCloudVerifyPrompt(
  profile: CandidateProfile,
  job: PromptJob,
  localEvaluation: LLMEvaluation | null,
  reasons: EscalationReason[],
): string {
  const reasonText =
    reasons.map((r) => `- ${ESCALATION_REASON_LABELS[r]}`).join('\n') || '- unspecified';

  const localBlock = localEvaluation
    ? JSON.stringify(localEvaluation, null, 2)
    : '(the local model failed to return a usable evaluation)';

  return `CANDIDATE PROFILE:
${JSON.stringify(toPromptProfile(profile), null, 2)}

JOB POSTING:
${JSON.stringify(job, null, 2)}

LOCAL MODEL EVALUATION (unverified — check it, do not assume it is correct):
${localBlock}

WHY THIS WAS ESCALATED TO YOU:
${reasonText}

Independently evaluate this posting. Address the escalation reason directly.
Return exactly one JSON object in this shape:
{
  "jobId": "${job.jobId}",
  "score": <integer 0-100>,
  "confidence": <number 0.0-1.0>,
  "recommendation": "HIGH_PRIORITY" | "APPLY" | "CONSIDER" | "SKIP",
  "matchingSkills": [<strings>],
  "missingSkills": [<strings>],
  "reasons": [<strings, including how you resolved the escalation reason>],
  "concerns": [<strings>],
  "needsCloud": false,
  "escalationReason": null,
  "uncertainties": {
    "seniority": <boolean>,
    "experience": <boolean>,
    "salary": <boolean>,
    "requirements": <boolean>,
    "conflicting": <boolean>
  }
}`;
}
