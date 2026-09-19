import { z } from 'zod';
import { loadEnv, type Env } from '../../config/env.js';
import {
  EXCLUDED_KEYS,
  READ_ONLY_KEYS,
  RESTART_REQUIRED_KEYS,
  SETTINGS_KEYS,
  SETTING_FIELDS,
  SETTING_GROUPS,
} from '../../config/settings.catalog.js';
import { createLocalProvider, createCloudProvider } from '../../llm/factory.js';
import { SettingsValidationError } from '../config-store.js';
import type { DashboardContext } from '../context.js';
import { handleJson, issuesToFields, issuesToStrings, sendJson } from '../http.js';
import type { Route } from '../router.js';

/** Env values become strings at the API boundary, because that is what .env holds. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

/** The values you would get with an empty .env, for the "default" badge. */
let defaultsCache: Env | null = null;
function schemaDefaults(): Env {
  defaultsCache ??= loadEnv({} as NodeJS.ProcessEnv);
  return defaultsCache;
}

const UpdateSchema = z.object({
  values: z.record(z.string(), z.string()),
});

export function createSettingsRoutes(ctx: DashboardContext): Route[] {
  const { config, logger } = ctx;

  function snapshot(): unknown {
    const current = config.current() as unknown as Record<string, unknown>;
    const defaults = schemaDefaults() as unknown as Record<string, unknown>;
    const fromFile = config.raw();
    const boot = config.boot() as unknown as Record<string, unknown>;

    const values: Record<string, { value: string; default: string; isDefault: boolean }> = {};
    for (const key of SETTINGS_KEYS) {
      values[key] = {
        value: asText(current[key]),
        default: asText(defaults[key]),
        // "Untouched" means the file does not mention it at all, which is a
        // more useful signal than the value merely happening to match.
        isDefault: !(key in fromFile),
      };
    }

    const restartPending = [...RESTART_REQUIRED_KEYS].filter(
      (key) => asText(current[key]) !== asText(boot[key]),
    );

    return {
      groups: SETTING_GROUPS,
      fields: SETTING_FIELDS,
      values,
      envPath: config.envPath,
      restartPending,
      excluded: EXCLUDED_KEYS,
    };
  }

  return [
    {
      method: 'GET',
      path: '/api/settings',
      handle: async ({ res }) => sendJson(res, 200, snapshot()),
    },

    {
      method: 'PUT',
      path: '/api/settings',
      handle: handleJson(
        UpdateSchema,
        async ({ values }, { res }) => {
          const rejected = Object.keys(values).filter(
            (key) => !SETTINGS_KEYS.has(key) || READ_ONLY_KEYS.has(key),
          );
          if (rejected.length > 0) {
            sendJson(res, 400, {
              error: 'unknown setting',
              issues: rejected.map((key) =>
                READ_ONLY_KEYS.has(key)
                  ? `${key}: managed in Sources, not here`
                  : `${key}: not an editable setting`,
              ),
              fields: rejected.map((key) => ({ path: key, message: 'not editable here' })),
            });
            return undefined;
          }

          try {
            await config.apply(values);
          } catch (err) {
            if (err instanceof SettingsValidationError) {
              sendJson(res, 400, {
                error: 'invalid settings',
                issues: issuesToStrings(err.issues),
                fields: issuesToFields(err.issues),
              });
              return undefined;
            }
            throw err;
          }

          logger.info('DB', 'settings updated', { keys: Object.keys(values) });
          const restartRequired = Object.keys(values).filter((key) =>
            RESTART_REQUIRED_KEYS.has(key),
          );
          sendJson(res, 200, { ok: true, restartRequired, ...(snapshot() as object) });
          return undefined;
        },
        { errorLabel: 'settings' },
      ),
    },

    {
      method: 'GET',
      path: '/api/models',
      handle: async ({ res }) => {
        const provider = createLocalProvider(config.current());
        try {
          sendJson(res, 200, { models: await provider.listModels() });
        } catch (err) {
          // Ollama being down is an expected state to report, not a 500.
          sendJson(res, 200, {
            models: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },

    {
      method: 'POST',
      path: '/api/settings/test-providers',
      handle: async ({ res }) => {
        const env = config.current();
        const local = createLocalProvider(env);

        let localStatus: unknown;
        try {
          const models = await local.listModels();
          const installed = models.some((m) => m.name === env.OLLAMA_MODEL);
          localStatus = {
            ok: installed,
            model: env.OLLAMA_MODEL,
            installed,
            modelCount: models.length,
            message: installed
              ? `ready — ${models.length} model${models.length === 1 ? '' : 's'} installed`
              : `"${env.OLLAMA_MODEL}" is not installed. Run: ollama pull ${env.OLLAMA_MODEL}`,
          };
        } catch (err) {
          localStatus = {
            ok: false,
            model: env.OLLAMA_MODEL,
            installed: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }

        const cloud = createCloudProvider(env, logger);
        const cloudStatus = cloud
          ? { ok: true, provider: cloud.name, model: cloud.model, message: 'configured' }
          : {
              ok: false,
              provider: env.CLOUD_PROVIDER,
              model: null,
              message:
                env.CLOUD_ESCALATION_ENABLED && env.CLOUD_PROVIDER !== 'none'
                  ? 'no API key set — runs will stay local-only'
                  : 'escalation is switched off — runs stay local-only',
            };

        sendJson(res, 200, { local: localStatus, cloud: cloudStatus });
      },
    },
  ];
}
