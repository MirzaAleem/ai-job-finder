import { describe, it, expect } from 'vitest';
import {
  EXCLUDED_KEYS,
  READ_ONLY_KEYS,
  SETTINGS_KEYS,
  SETTING_FIELDS,
  SETTING_GROUPS,
} from '../../src/config/settings.catalog.js';
import { EnvSchema } from '../../src/config/env.js';

const schemaKeys = Object.keys(EnvSchema.shape);

describe('settings catalogue drift', () => {
  it('exposes only keys that exist in EnvSchema', () => {
    const unknown = [...SETTINGS_KEYS].filter((key) => !schemaKeys.includes(key));
    expect(unknown).toEqual([]);
  });

  it('accounts for every EnvSchema key, as exposed or deliberately excluded', () => {
    // A new variable must be classified on purpose. If this fails, add it to
    // SETTING_FIELDS or to EXCLUDED_KEYS with a reason — do not delete the test.
    const unaccounted = schemaKeys.filter(
      (key) => !SETTINGS_KEYS.has(key) && !(key in EXCLUDED_KEYS),
    );
    expect(unaccounted).toEqual([]);
  });

  it('does not both expose and exclude the same key', () => {
    expect([...SETTINGS_KEYS].filter((key) => key in EXCLUDED_KEYS)).toEqual([]);
  });

  it('excludes only keys that exist', () => {
    expect(Object.keys(EXCLUDED_KEYS).filter((key) => !schemaKeys.includes(key))).toEqual([]);
  });
});

describe('settings catalogue shape', () => {
  it('has no duplicate keys', () => {
    expect(SETTING_FIELDS.length).toBe(SETTINGS_KEYS.size);
  });

  it('puts every field in a declared group', () => {
    const groups = new Set(SETTING_GROUPS.map((g) => g.id));
    expect(SETTING_FIELDS.filter((f) => !groups.has(f.group)).map((f) => f.key)).toEqual([]);
  });

  it('leaves no group empty', () => {
    const used = new Set(SETTING_FIELDS.map((f) => f.group));
    expect(SETTING_GROUPS.filter((g) => !used.has(g.id)).map((g) => g.id)).toEqual([]);
  });

  it('gives every field a label and help text', () => {
    const missing = SETTING_FIELDS.filter((f) => !f.label?.trim() || !f.help?.trim());
    expect(missing.map((f) => f.key)).toEqual([]);
  });

  it('gives every enum field its options', () => {
    const missing = SETTING_FIELDS.filter((f) => f.type === 'enum' && !f.options?.length);
    expect(missing.map((f) => f.key)).toEqual([]);
  });

  it('lists enum options that the schema actually accepts', () => {
    for (const field of SETTING_FIELDS) {
      if (field.type !== 'enum' || !field.options) continue;
      const shape = EnvSchema.shape as Record<
        string,
        { safeParse(v: unknown): { success: boolean } }
      >;
      const validator = shape[field.key];
      for (const option of field.options) {
        expect(validator?.safeParse(option).success, `${field.key}=${option}`).toBe(true);
      }
    }
  });

  it('marks the keys the running process has already consumed', () => {
    // Changing these mid-flight would leave the server and the file disagreeing.
    expect(
      [...new Set(SETTING_FIELDS.filter((f) => f.restartRequired).map((f) => f.key))].sort(),
    ).toEqual(['DASHBOARD_PORT', 'LOG_LEVEL', 'SQLITE_PATH']);
  });

  it('hands the source keys to the Sources view', () => {
    expect([...READ_ONLY_KEYS].sort()).toEqual(['IMPORT_FILE', 'SOURCES_ENABLED']);
  });
});
