/*
 * The candidate profile form.
 *
 * Mirrors CandidateProfileSchema in src/domain/profile.schema.ts, which is
 * .strict() — so an extra key here becomes a clean 400 rather than data that
 * silently vanishes. The server remains the only validator; these descriptors
 * carry the labels, the help text and the input types.
 */

export const PROFILE_GROUPS = [
  {
    id: 'wanted',
    title: 'What you are looking for',
    blurb:
      'These drive the deterministic filter that runs before any model sees a job. Too narrow ' +
      'and good postings never reach the evaluation step at all.',
  },
  {
    id: 'experience',
    title: 'Experience and pay',
    blurb:
      'Missing information never rejects a job. A posting that does not state a salary is not ' +
      'treated as low-paying, and one with no stated location is not treated as incompatible.',
  },
  {
    id: 'skills',
    title: 'Skills',
    blurb: 'Used for matching and shown per job as matching or missing.',
  },
  {
    id: 'exclusions',
    title: 'Hard vetoes',
    blurb: 'Anything matching these is dropped before a single model call is made.',
  },
  {
    id: 'context',
    title: 'Context for the model',
    blurb: 'Free text the model is asked to weigh when it scores a job.',
  },
];

export const PROFILE_FIELDS = [
  {
    key: 'targetRoles',
    group: 'wanted',
    type: 'list',
    label: 'Target roles',
    help: 'Job titles you actually want. At least one is required.',
    placeholder: 'Backend Engineer',
  },
  {
    key: 'preferredLocations',
    group: 'wanted',
    type: 'list',
    label: 'Locations',
    help:
      'Cities you would work in. Leave empty to accept anywhere. A job with a stated location ' +
      'that does not match is dropped; an unstated one never is.',
    placeholder: 'Remote',
  },
  {
    key: 'remotePreference',
    group: 'wanted',
    type: 'enum',
    label: 'Remote preference',
    options: [
      { value: 'REMOTE_ONLY', label: 'Remote only' },
      { value: 'REMOTE_PREFERRED', label: 'Prefer remote' },
      { value: 'HYBRID', label: 'Hybrid' },
      { value: 'ONSITE', label: 'On site' },
      { value: 'ANY', label: 'No preference' },
    ],
    help: '"Remote only" drops roles explicitly advertised as on-site or hybrid.',
  },
  {
    key: 'yearsOfExperience',
    group: 'experience',
    type: 'number',
    label: 'Years of experience',
    help: 'Postings demanding far more, or capped far below this, are dropped.',
    min: 0,
    max: 60,
    step: 1,
  },
  {
    key: 'maximumExperienceAccepted',
    group: 'experience',
    type: 'number',
    label: 'Most experience you would accept',
    help: 'Optional. Postings asking for more than this are penalised, not rejected outright.',
    min: 0,
    max: 60,
    step: 1,
  },
  {
    key: 'salary.currency',
    group: 'experience',
    type: 'string',
    label: 'Currency',
    help: 'The currency the figures below are in.',
    placeholder: 'INR',
  },
  {
    key: 'salary.minimum',
    group: 'experience',
    type: 'number',
    label: 'Minimum salary',
    help:
      'Annual, in whole units — 2500000 means 25 LPA, not 25. A job whose stated ceiling is ' +
      'below this is dropped; an undisclosed salary never is. Leave empty to ignore pay.',
    min: 0,
    step: 50000,
  },
  {
    key: 'salary.preferred',
    group: 'experience',
    type: 'number',
    label: 'Preferred salary',
    help: 'What you are aiming for. Used for ranking, never for rejection.',
    min: 0,
    step: 50000,
  },
  {
    key: 'requiredSkills',
    group: 'skills',
    type: 'list',
    label: 'Required skills',
    help: 'Skills you have and want to keep using.',
    placeholder: 'TypeScript',
  },
  {
    key: 'preferredSkills',
    group: 'skills',
    type: 'list',
    label: 'Nice-to-have skills',
    help: 'Counted in favour of a job, but never required.',
    placeholder: 'Docker',
  },
  {
    key: 'excludedRoles',
    group: 'exclusions',
    type: 'list',
    label: 'Excluded roles',
    help: 'Titles that should never reach the model.',
    placeholder: 'Sales',
  },
  {
    key: 'excludedIndustries',
    group: 'exclusions',
    type: 'list',
    label: 'Excluded industries',
    help: 'Industries you will not work in.',
    placeholder: 'Gambling',
  },
  {
    key: 'excludedKeywords',
    group: 'exclusions',
    type: 'list',
    label: 'Excluded keywords',
    help: 'Any posting mentioning one of these is dropped before evaluation.',
    placeholder: 'unpaid',
  },
  {
    key: 'education',
    group: 'context',
    type: 'string',
    label: 'Education',
    help: 'Optional.',
    placeholder: 'B.Tech, Computer Science',
  },
  {
    key: 'workAuthorization',
    group: 'context',
    type: 'string',
    label: 'Work authorisation',
    help: 'Optional. Helps the model reason about sponsorship requirements.',
    placeholder: 'Indian citizen; no sponsorship required for India',
  },
  {
    key: 'noticePeriod',
    group: 'context',
    type: 'string',
    label: 'Notice period',
    help: 'Optional.',
    placeholder: '60 days',
  },
  {
    key: 'additionalPreferences',
    group: 'context',
    type: 'list',
    label: 'Other preferences',
    help: 'Anything else the model should weigh, one per entry.',
    placeholder: 'Prefer product companies over consultancies',
  },
];
