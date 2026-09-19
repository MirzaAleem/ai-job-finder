import { createInterface } from 'node:readline/promises';
import { updateEnvFile } from '../config/env-file.js';
import type { Env } from '../config/env.js';
import type { Logger } from '../util/logger.js';
import { createLocalProvider } from '../llm/factory.js';
import type { OllamaModelInfo } from '../llm/ollama.provider.js';

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1_000_000).toFixed(0)} MB`;
}

function renderTable(models: OllamaModelInfo[], current: string, logger: Logger): void {
  logger.plain();
  logger.plain('Models installed in Ollama:');
  logger.plain();
  models.forEach((model, index) => {
    const marker = model.name === current ? '*' : ' ';
    const params = model.parameterSize ? ` (${model.parameterSize})` : '';
    logger.plain(
      `  ${marker} ${String(index + 1).padStart(2)}. ${model.name.padEnd(28)}${formatSize(model.sizeBytes).padStart(8)}${params}`,
    );
  });
  logger.plain();
  logger.plain(`  * = current OLLAMA_MODEL (${current})`);
  logger.plain();
}

/**
 * Lists the models actually installed in Ollama and, interactively, writes the
 * chosen one to .env. Nothing here hardcodes a model name — the list comes from
 * the daemon, so pulling a new model makes it selectable immediately.
 */
export async function runModelsCommand(
  env: Env,
  logger: Logger,
  options: { select: boolean },
): Promise<number> {
  const provider = createLocalProvider(env);

  let models: OllamaModelInfo[];
  try {
    models = await provider.listModels();
  } catch (err) {
    logger.error('LOCAL-LLM', err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (models.length === 0) {
    logger.plain();
    logger.plain('No models installed. Pull one first, for example:');
    logger.plain('  ollama pull qwen3:8b');
    logger.plain('  ollama pull llama3.1:8b');
    logger.plain();
    return 1;
  }

  renderTable(models, env.OLLAMA_MODEL, logger);

  if (!options.select) {
    logger.plain('Run `pnpm jobs:models --select` to choose one and save it to .env.');
    logger.plain();
    return 0;
  }

  if (!process.stdin.isTTY) {
    logger.plain('Not an interactive terminal — cannot prompt for a selection.');
    return 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Select a model [1-${models.length}] (blank to cancel): `);
    const index = Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= models.length) {
      logger.plain('Cancelled — nothing changed.');
      return 0;
    }

    const chosen = models[index];
    if (!chosen) return 0;

    await persistModelChoice(chosen.name);
    logger.plain();
    logger.plain(`OLLAMA_MODEL set to "${chosen.name}" in .env`);
    logger.plain();
    return 0;
  } finally {
    rl.close();
  }
}

/** Rewrites only the OLLAMA_MODEL line, leaving every other .env line untouched. */
async function persistModelChoice(model: string, envPath = '.env'): Promise<void> {
  await updateEnvFile(envPath, { OLLAMA_MODEL: model });
}
