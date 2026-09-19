import path from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { createConfigStore, type ConfigStore } from '../../src/dashboard/config-store.js';
import { startDashboard, type RunningDashboard } from '../../src/dashboard/server.js';
import type { RunController } from '../../src/dashboard/run-controller.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { createTempWorkspace, type TempWorkspace } from './workspace.js';

export interface TestDashboard {
  dashboard: RunningDashboard;
  config: ConfigStore;
  workspace: TempWorkspace;
  api(route: string): string;
  close(): Promise<void>;
}

/**
 * A dashboard whose every file lives in a throwaway directory.
 *
 * Settings and profile edits write to disk, so tests must never be pointed at
 * the real .env, config/ or output/. The base environment is empty for the same
 * reason: whatever the developer has exported must not change assertions.
 */
export async function startTestDashboard(
  options: {
    env?: string;
    profile?: string;
    sources?: string;
    /** Substitute the runner so tests never start the real pipeline. */
    runner?: RunController;
  } = {},
): Promise<TestDashboard> {
  const workspace = await createTempWorkspace(options);
  const logger = createSilentLogger();

  const config = await createConfigStore({
    envPath: workspace.envPath,
    fallback: loadEnv({} as NodeJS.ProcessEnv),
    logger,
    // Port 1 refuses instantly. Without this the suite would quietly talk to
    // whatever Ollama the developer happens to be running, which makes results
    // depend on their machine and adds real network latency to every probe.
    // A test that wants a different address sets it in the workspace .env.
    baseEnv: { OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
  });
  await config.reload();

  const dashboard = await startDashboard({
    port: 0, // ephemeral
    logger,
    config,
    publicDir: path.resolve('src/dashboard/public'),
    runner: options.runner,
    paths: {
      dataDir: path.join(workspace.root, 'data'),
      profileFile: workspace.profilePath,
      sourcesFile: workspace.sourcesPath,
      outputDir: workspace.outputDir,
      profileExampleFile: path.resolve('config/profile.example.yaml'),
      sourcesExampleFile: path.resolve('config/sources.example.yaml'),
    },
  });

  return {
    dashboard,
    config,
    workspace,
    api: (route) => `${dashboard.url}${route}`,
    close: async () => {
      await dashboard.close();
      await workspace.cleanup();
    },
  };
}
