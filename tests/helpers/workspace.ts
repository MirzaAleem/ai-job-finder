import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A throwaway project directory for tests that write files.
 *
 * Settings, profile, sources and upload handling all rewrite real files on
 * disk. Nothing in the suite may touch the developer's own config/, data/ or
 * output/ directories, so every such test runs against one of these instead.
 */
export interface TempWorkspace {
  root: string;
  envPath: string;
  configDir: string;
  dataDir: string;
  outputDir: string;
  profilePath: string;
  sourcesPath: string;
  /** Absolute path for a workspace-relative file. */
  resolve(relative: string): string;
  write(relative: string, contents: string): Promise<string>;
  read(relative: string): Promise<string>;
  exists(relative: string): boolean;
  cleanup(): Promise<void>;
}

export async function createTempWorkspace(
  options: { env?: string; profile?: string; sources?: string } = {},
): Promise<TempWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jobfinder-test-'));

  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);

  const envPath = path.join(root, '.env');
  const profilePath = path.join(configDir, 'profile.yaml');
  const sourcesPath = path.join(configDir, 'sources.yaml');

  const resolve = (relative: string): string => path.resolve(root, relative);

  const workspace: TempWorkspace = {
    root,
    envPath,
    configDir,
    dataDir,
    outputDir,
    profilePath,
    sourcesPath,
    resolve,
    async write(relative, contents) {
      const target = resolve(relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, 'utf8');
      return target;
    },
    read: (relative) => readFile(resolve(relative), 'utf8'),
    exists: (relative) => existsSync(resolve(relative)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };

  if (options.env !== undefined) await workspace.write('.env', options.env);
  if (options.profile !== undefined) await workspace.write('config/profile.yaml', options.profile);
  if (options.sources !== undefined) await workspace.write('config/sources.yaml', options.sources);

  return workspace;
}
