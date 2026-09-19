import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RankedJob } from './types.js';
import { outputFileName } from './csv.js';

export interface JsonExportMeta {
  generatedAt: string;
  totalJobs: number;
  newJobs: number;
  localModel: string;
  cloudModel: string | null;
  cloudRequests: number;
  estimatedCloudCost: number;
}

export function buildJsonExport(items: RankedJob[], meta: JsonExportMeta) {
  return {
    meta,
    jobs: items.map((item) => ({
      score: item.evaluation.score,
      confidence: Number(item.evaluation.confidence.toFixed(2)),
      recommendation: item.evaluation.recommendation,
      providerUsed: item.evaluation.providerUsed,
      escalated: item.evaluation.escalated,
      escalationReasons: item.evaluation.escalationReasons,
      degraded: item.evaluation.degraded,
      isNew: item.isNew,
      matchingSkills: item.evaluation.matchingSkills,
      missingSkills: item.evaluation.missingSkills,
      reasons: item.evaluation.reasons,
      concerns: item.evaluation.concerns,
      job: {
        source: item.job.source,
        externalId: item.job.externalId,
        company: item.job.company,
        title: item.job.title,
        location: item.job.location,
        remote: item.job.remote,
        salary: item.job.salary,
        experienceRequired: item.job.experienceRequired,
        skills: item.job.skills,
        url: item.job.url,
        applicationUrl: item.job.applicationUrl,
        postedAt: item.job.postedAt?.toISOString() ?? null,
        firstSeenAt: item.job.firstSeenAt.toISOString(),
      },
    })),
  };
}

export async function writeJson(
  items: RankedJob[],
  meta: JsonExportMeta,
  outputDir: string,
  date = new Date(),
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, outputFileName('jobs', 'json', date));
  await writeFile(filePath, `${JSON.stringify(buildJsonExport(items, meta), null, 2)}\n`, 'utf8');
  return filePath;
}
