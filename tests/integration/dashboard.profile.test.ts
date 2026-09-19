import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { startTestDashboard, type TestDashboard } from '../helpers/dashboard.js';

const VALID = `# My profile
targetRoles:
  - Backend Engineer
  - Platform Engineer
preferredLocations:
  - Remote
remotePreference: REMOTE_PREFERRED
yearsOfExperience: 6
requiredSkills:
  - TypeScript
`;

let harness: TestDashboard;
afterEach(() => harness?.close());

async function start(profile?: string): Promise<TestDashboard> {
  harness = await startTestDashboard(profile === undefined ? {} : { profile });
  return harness;
}

const get = () => fetch(harness.api('/api/profile')).then((r) => r.json());

const put = (profile: unknown) =>
  fetch(harness.api('/api/profile'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  });

const putRaw = (yaml: string) =>
  fetch(harness.api('/api/profile/raw'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml }),
  });

describe('GET /api/profile', () => {
  it('reads an existing profile', async () => {
    await start(VALID);
    const body = await get();
    expect(body.exists).toBe(true);
    expect(body.profile.targetRoles).toEqual(['Backend Engineer', 'Platform Engineer']);
    expect(body.profile.yearsOfExperience).toBe(6);
  });

  it('applies the schema defaults for fields the file omits', async () => {
    await start(VALID);
    expect((await get()).profile.excludedRoles).toEqual([]);
    expect((await get()).profile.salary.currency).toBe('INR');
  });

  it('offers the example as a starting point when there is no profile yet', async () => {
    await start();
    const body = await get();
    expect(body.exists).toBe(false);
    expect(body.profile).toBeNull();
    expect(body.example.profile.targetRoles.length).toBeGreaterThan(0);
  });

  it('still opens a profile that does not match the schema', async () => {
    await start('targetRoles: []\nyearsOfExperience: 6\n');
    const res = await fetch(harness.api('/api/profile'));
    // A 400 here would lock the user out of the only editor that can fix it.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.profile).toBeNull();
    expect(body.yaml).toContain('targetRoles');
    expect(body.fields[0].path).toBe('targetRoles');
  });

  it('still opens a profile that is not valid YAML', async () => {
    await start('targetRoles: [unclosed\n');
    const res = await fetch(harness.api('/api/profile'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBeNull();
    expect(body.fields[0].path).toBe('yaml');
  });
});

describe('PUT /api/profile', () => {
  it('saves and round-trips', async () => {
    await start(VALID);
    const next = { ...(await get()).profile, yearsOfExperience: 9 };
    expect((await put(next)).status).toBe(200);
    expect((await get()).profile.yearsOfExperience).toBe(9);
  });

  it('writes YAML the pipeline can load back', async () => {
    await start(VALID);
    await put({ ...(await get()).profile, targetRoles: ['Staff Engineer'] });
    const onDisk = parseYaml(await harness.workspace.read('config/profile.yaml'));
    expect(onDisk.targetRoles).toEqual(['Staff Engineer']);
  });

  it('creates the file when there was none', async () => {
    await start();
    const res = await put({ targetRoles: ['Backend Engineer'], yearsOfExperience: 4 });
    expect(res.status).toBe(200);
    expect(harness.workspace.exists('config/profile.yaml')).toBe(true);
  });

  it('rejects an empty targetRoles with a field-level error', async () => {
    await start(VALID);
    const res = await put({ targetRoles: [], yearsOfExperience: 6 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fields[0].path).toBe('targetRoles');
    expect(body.fields[0].message).toContain('at least one target role');
  });

  it('points at the exact array entry that is wrong', async () => {
    await start(VALID);
    const res = await put({ targetRoles: ['ok', ''], yearsOfExperience: 6 });
    expect(res.status).toBe(400);
    expect((await res.json()).fields[0].path).toBe('targetRoles.1');
  });

  it('points inside a nested object', async () => {
    await start(VALID);
    const res = await put({
      targetRoles: ['Backend Engineer'],
      yearsOfExperience: 6,
      salary: { currency: 'INR', minimum: -5 },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).fields[0].path).toBe('salary.minimum');
  });

  it('rejects an unknown field rather than dropping it silently', async () => {
    await start(VALID);
    const res = await put({
      targetRoles: ['Backend Engineer'],
      yearsOfExperience: 6,
      favouriteColour: 'blue',
    });
    expect(res.status).toBe(400);
  });

  it('leaves the previous profile on disk when a save is rejected', async () => {
    await start(VALID);
    await put({ targetRoles: [], yearsOfExperience: 6 });
    expect(await harness.workspace.read('config/profile.yaml')).toContain('Backend Engineer');
  });
});

describe('PUT /api/profile/raw', () => {
  it('saves hand-written YAML verbatim, comments and all', async () => {
    await start(VALID);
    const edited = VALID.replace('yearsOfExperience: 6', 'yearsOfExperience: 7');
    expect((await putRaw(edited)).status).toBe(200);

    const onDisk = await harness.workspace.read('config/profile.yaml');
    expect(onDisk).toContain('# My profile');
    expect(onDisk).toContain('yearsOfExperience: 7');
  });

  it('rejects YAML that will not parse', async () => {
    await start(VALID);
    const res = await putRaw('targetRoles: [unclosed\n');
    expect(res.status).toBe(400);
    expect((await res.json()).fields[0].path).toBe('yaml');
  });

  it('refuses to save YAML the pipeline would reject at startup', async () => {
    await start(VALID);
    const res = await putRaw('targetRoles: []\nyearsOfExperience: 6\n');
    expect(res.status).toBe(400);
    expect((await res.json()).fields[0].path).toBe('targetRoles');
    expect(await harness.workspace.read('config/profile.yaml')).toContain('Backend Engineer');
  });
});
