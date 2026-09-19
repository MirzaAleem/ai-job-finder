import path from 'node:path';
import type { DashboardRepository } from '../db/dashboard.repository.js';
import type { RunRepository } from '../db/run.repository.js';
import type { Logger } from '../util/logger.js';
import type { ConfigStore } from './config-store.js';

/**
 * Where the dashboard reads and writes files.
 *
 * Most of these are functions rather than values because settings can change
 * while the server runs: saving a new OUTPUT_DIR must redirect the very next
 * request, not wait for a restart. envFile and dataDir are fixed at boot
 * because nothing in the UI can move them.
 */
export interface DashboardPaths {
  envFile: string;
  dataDir: string;
  profileFile(): string;
  profileExampleFile(): string;
  sourcesFile(): string;
  sourcesExampleFile(): string;
  outputDir(): string;
}

export interface DashboardContext {
  config: ConfigStore;
  paths: DashboardPaths;
  logger: Logger;
  repository: DashboardRepository;
  runRepository: RunRepository;
}

export interface DashboardPathOverrides {
  envFile?: string;
  dataDir?: string;
  profileFile?: string;
  profileExampleFile?: string;
  sourcesFile?: string;
  sourcesExampleFile?: string;
  outputDir?: string;
}

export function createPaths(
  config: ConfigStore,
  overrides: DashboardPathOverrides = {},
): DashboardPaths {
  const fixed = (value: string | undefined, fallback: string): string =>
    path.resolve(value ?? fallback);

  const live = (value: string | undefined, read: () => string): (() => string) =>
    value === undefined ? () => path.resolve(read()) : () => path.resolve(value);

  return {
    envFile: fixed(overrides.envFile, config.envPath),
    dataDir: fixed(overrides.dataDir, 'data'),
    profileFile: live(overrides.profileFile, () => config.current().PROFILE_PATH),
    profileExampleFile: live(overrides.profileExampleFile, () => 'config/profile.example.yaml'),
    sourcesFile: live(overrides.sourcesFile, () => config.current().SOURCES_CONFIG_PATH),
    sourcesExampleFile: live(overrides.sourcesExampleFile, () => 'config/sources.example.yaml'),
    outputDir: live(overrides.outputDir, () => config.current().OUTPUT_DIR),
  };
}
