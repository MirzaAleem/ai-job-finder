import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { CandidateProfileSchema } from '../../domain/profile.schema.js';
import {
  ProfileWriteError,
  readProfileResult,
  writeProfile,
  writeProfileRaw,
} from '../../config/profile.writer.js';
import type { DashboardContext } from '../context.js';
import { handleJson, issuesToFields, issuesToStrings, sendJson } from '../http.js';
import type { Route } from '../router.js';

const SaveSchema = z.object({ profile: z.unknown() });
const SaveRawSchema = z.object({ yaml: z.string() });

function writeFailure(res: Parameters<typeof sendJson>[0], err: ProfileWriteError): void {
  sendJson(res, 400, {
    error: err.message,
    issues: err.issues ? issuesToStrings(err.issues) : [err.message],
    fields: err.issues ? issuesToFields(err.issues) : [{ path: 'yaml', message: err.message }],
  });
}

export function createProfileRoutes(ctx: DashboardContext): Route[] {
  const { paths, logger } = ctx;

  /** The example file, parsed, as a starting point for a first-time profile. */
  async function exampleProfile(): Promise<{ profile: unknown; yaml: string } | null> {
    const file = paths.profileExampleFile();
    if (!existsSync(file)) return null;
    const yaml = await readFile(file, 'utf8');
    const parsed = CandidateProfileSchema.safeParse(parseYaml(yaml));
    return { profile: parsed.success ? parsed.data : null, yaml };
  }

  return [
    {
      method: 'GET',
      path: '/api/profile',
      handle: async ({ res }) => {
        const file = paths.profileFile();
        const result = await readProfileResult(file);

        if (result.status === 'missing') {
          sendJson(res, 200, {
            exists: false,
            path: file,
            profile: null,
            yaml: null,
            example: await exampleProfile(),
          });
          return;
        }

        if (result.status === 'invalid') {
          // Deliberately a 200. If the only way to repair a broken profile is
          // this editor, the editor has to be able to open it.
          sendJson(res, 200, {
            exists: true,
            path: file,
            profile: null,
            yaml: result.yaml,
            error: result.message,
            issues: result.issues ? issuesToStrings(result.issues) : [result.message],
            fields: result.issues
              ? issuesToFields(result.issues)
              : [{ path: 'yaml', message: result.message }],
          });
          return;
        }

        sendJson(res, 200, {
          exists: true,
          path: file,
          profile: result.profile,
          yaml: result.yaml,
        });
      },
    },

    {
      method: 'PUT',
      path: '/api/profile',
      handle: handleJson(
        SaveSchema,
        async ({ profile }, { res }) => {
          const file = paths.profileFile();
          try {
            const saved = await writeProfile(file, profile);
            logger.info('DB', 'profile saved', { path: file });
            sendJson(res, 200, { ok: true, exists: true, path: file, ...saved });
          } catch (err) {
            if (err instanceof ProfileWriteError) writeFailure(res, err);
            else throw err;
          }
          return undefined;
        },
        { errorLabel: 'profile' },
      ),
    },

    {
      method: 'PUT',
      path: '/api/profile/raw',
      handle: handleJson(
        SaveRawSchema,
        async ({ yaml }, { res }) => {
          const file = paths.profileFile();
          try {
            const saved = await writeProfileRaw(file, yaml);
            logger.info('DB', 'profile saved from raw YAML', { path: file });
            sendJson(res, 200, { ok: true, exists: true, path: file, ...saved });
          } catch (err) {
            if (err instanceof ProfileWriteError) writeFailure(res, err);
            else throw err;
          }
          return undefined;
        },
        { errorLabel: 'profile' },
      ),
    },
  ];
}
