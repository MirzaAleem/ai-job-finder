import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write a file without ever leaving a half-written one behind.
 *
 * The dashboard rewrites configuration the pipeline depends on. A crash or a
 * full disk partway through a plain writeFile would leave .env or profile.yaml
 * truncated, which breaks every later run. Writing to a temp file in the same
 * directory and renaming makes the swap atomic on any single volume.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, absolute);
}
