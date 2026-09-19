import type { Env } from '../config/env.js';
import type { Logger } from '../util/logger.js';
import { OllamaProvider } from './ollama.provider.js';
import { OpenRouterProvider } from './openrouter.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import type { LLMProvider } from './provider.js';

export function createLocalProvider(env: Env): OllamaProvider {
  return new OllamaProvider({
    baseUrl: env.OLLAMA_BASE_URL,
    model: env.OLLAMA_MODEL,
    timeoutMs: env.OLLAMA_TIMEOUT_MS,
    numCtx: env.OLLAMA_NUM_CTX,
  });
}

/**
 * Returns null — not an error — when no cloud provider is configured.
 * A missing cloud key must degrade the run, never abort it: local-first means
 * the pipeline has to work with the cloud path entirely absent.
 */
export function createCloudProvider(env: Env, logger: Logger): LLMProvider | null {
  if (!env.CLOUD_ESCALATION_ENABLED || env.CLOUD_PROVIDER === 'none') {
    logger.debug('CLOUD-LLM', 'cloud escalation disabled by configuration');
    return null;
  }

  try {
    if (env.CLOUD_PROVIDER === 'openrouter') {
      if (!env.OPENROUTER_API_KEY) {
        logger.warn('CLOUD-LLM', 'OPENROUTER_API_KEY not set — escalation unavailable');
        return null;
      }
      return new OpenRouterProvider({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
        baseUrl: env.OPENROUTER_BASE_URL,
      });
    }

    if (env.CLOUD_PROVIDER === 'gemini') {
      if (!env.GEMINI_API_KEY) {
        logger.warn('CLOUD-LLM', 'GEMINI_API_KEY not set — escalation unavailable');
        return null;
      }
      return new GeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        baseUrl: env.GEMINI_BASE_URL,
      });
    }
  } catch (err) {
    logger.warn('CLOUD-LLM', 'could not construct cloud provider', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}
