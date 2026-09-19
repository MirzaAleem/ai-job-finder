import type { CandidateProfile } from '../../domain/profile.schema.js';
import { toPromptProfile } from '../../domain/profile.schema.js';
import type { NormalizedJob } from '../../domain/job.schema.js';
import { truncate } from '../../util/text.js';

/** The compact job view actually sent to a model. Everything else is wasted tokens. */
export interface PromptJob {
  jobId: string;
  title: string;
  company: string;
  location: string;
  remote: string;
  salary: string;
  experienceRequired: string;
  skills: string[];
  description: string;
}

export function toPromptJob(job: NormalizedJob, jobId: string, maxChars: number): PromptJob {
  return {
    jobId,
    title: job.title,
    company: job.company,
    location: job.location ?? 'unknown',
    remote: job.remote ?? 'unknown',
    salary: job.salary?.raw ?? formatSalary(job) ?? 'unknown',
    experienceRequired: job.experienceRequired?.raw ?? formatExperience(job) ?? 'unknown',
    skills: job.skills,
    description: truncate(job.description, maxChars),
  };
}

function formatSalary(job: NormalizedJob): string | null {
  if (!job.salary || (job.salary.min === null && job.salary.max === null)) return null;
  const currency = job.salary.currency ?? '';
  const period = job.salary.period ? ` ${job.salary.period.toLowerCase()}` : '';
  if (job.salary.min !== null && job.salary.max !== null) {
    return `${currency} ${job.salary.min}-${job.salary.max}${period}`.trim();
  }
  return `${currency} ${job.salary.min ?? job.salary.max}${period}`.trim();
}

function formatExperience(job: NormalizedJob): string | null {
  const exp = job.experienceRequired;
  if (!exp || (exp.minYears === null && exp.maxYears === null)) return null;
  if (exp.minYears !== null && exp.maxYears !== null)
    return `${exp.minYears}-${exp.maxYears} years`;
  if (exp.minYears !== null) return `${exp.minYears}+ years`;
  return `up to ${exp.maxYears} years`;
}

export const LOCAL_SYSTEM_PROMPT = `You are a precise job-matching analyst. You compare a candidate profile against job postings and return STRICT JSON only.

ABSOLUTE RULES — violating any of these makes your answer useless:
1. Use ONLY the candidate profile and the job text provided. Never use outside knowledge about the company.
2. NEVER invent candidate skills. If a skill is not in the candidate profile, the candidate does not have it.
3. NEVER invent job requirements, responsibilities, seniority, or salary. If the posting does not state it, it is UNKNOWN.
4. UNKNOWN IS NOT NEGATIVE. A posting with no stated salary is not a low-paying job. A posting with no stated location is not incompatible. Missing information lowers your CONFIDENCE; it does not lower the SCORE.
5. Never assume years of experience that are not stated in the posting.
6. Never assume the candidate can work at a location unless the posting's location is compatible with the candidate's stated preferences, or the role is stated to be remote.
7. If the posting is internally contradictory (e.g. "entry level" requiring 10 years), set uncertainties.conflicting = true and lower your confidence.
8. Explain uncertainty in "concerns" rather than hiding it inside a confident score.

SCORING (0-100), weighing in this order:
- Required (dominant): role relevance to target roles, experience fit, location/remote compatibility, work authorization, essential skills.
- Strong preferences (moderate): preferred skills, industry, company type, technology stack, salary versus expectations.
- Negative factors (penalise): experience demand far above or below the candidate, unrelated role, excluded industry, excluded keyword, incompatible location, salary below the stated minimum.

CONFIDENCE (0.0-1.0) is your certainty in your own score, driven by how much the posting actually told you. A detailed posting that clearly matches earns high confidence. A vague two-line posting earns low confidence even if it looks promising.

Set needsCloud = true only when a stronger model would genuinely change the answer: contradictory requirements, unclassifiable seniority, or a posting so vague that scoring is guesswork.

Return ONLY a JSON object. No markdown, no commentary, no code fences.`;

const SCHEMA_HINT = `{
  "jobId": "<the jobId given>",
  "score": <integer 0-100>,
  "confidence": <number 0.0-1.0>,
  "recommendation": "HIGH_PRIORITY" | "APPLY" | "CONSIDER" | "SKIP",
  "matchingSkills": [<skills present in BOTH the candidate profile and the posting>],
  "missingSkills": [<skills the posting requires that the candidate profile does not list>],
  "reasons": [<short factual statements supporting the score>],
  "concerns": [<risks, mismatches, or things the posting did not state>],
  "needsCloud": <boolean>,
  "escalationReason": <string or null>,
  "uncertainties": {
    "seniority": <boolean>,
    "experience": <boolean>,
    "salary": <boolean>,
    "requirements": <boolean>,
    "conflicting": <boolean>
  }
}`;

export function buildSingleEvalPrompt(profile: CandidateProfile, job: PromptJob): string {
  return `CANDIDATE PROFILE:
${JSON.stringify(toPromptProfile(profile), null, 2)}

JOB POSTING:
${JSON.stringify(job, null, 2)}

Evaluate this posting against the candidate profile.
Return exactly one JSON object in this shape:
${SCHEMA_HINT}`;
}

export function buildBatchEvalPrompt(profile: CandidateProfile, jobs: PromptJob[]): string {
  return `CANDIDATE PROFILE:
${JSON.stringify(toPromptProfile(profile), null, 2)}

JOB POSTINGS (${jobs.length}):
${JSON.stringify(jobs, null, 2)}

Evaluate EACH posting independently against the candidate profile.
Do not let one posting influence another.
Return exactly ${jobs.length} evaluations, one per jobId given, in this shape:
{
  "evaluations": [
${SCHEMA_HINT.split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
  ]
}`;
}

export const REPAIR_SYSTEM_PROMPT = `${LOCAL_SYSTEM_PROMPT}

YOUR PREVIOUS RESPONSE WAS REJECTED because it was not valid JSON matching the required schema. Output ONLY the raw JSON object. Start your response with { and end it with }. No prose, no markdown fences, no explanation.`;
