import type { RunSummary } from '../pipeline/run.js';
import type { Logger } from '../util/logger.js';

function pad(label: string, width = 22): string {
  return label.padEnd(width, ' ');
}

/** The human-facing report. Deliberately plain text, not log lines. */
export function printSummary(summary: RunSummary, logger: Logger): void {
  const p = logger.plain;

  p();
  p('Fetching jobs...');
  p();
  const sourceNames = Object.keys(summary.sourceCounts);
  if (sourceNames.length === 0) {
    p('  (no sources enabled)');
  } else {
    for (const name of sourceNames) {
      p(`  ${pad(`${name}:`, 16)}${String(summary.sourceCounts[name] ?? 0).padStart(6)}`);
    }
  }
  p();
  p(`  ${pad('Total fetched:', 16)}${String(summary.jobsFetched).padStart(6)}`);
  p();
  p(`After deduplication:            ${summary.jobsDeduplicated}`);
  p(`After deterministic filtering:  ${summary.jobsFiltered}`);

  const ruleEntries = Object.entries(summary.filterRuleCounts);
  if (ruleEntries.length > 0) {
    p();
    p('Filtered out by rule:');
    for (const [rule, count] of ruleEntries.sort((a, b) => b[1] - a[1])) {
      p(`  - ${pad(rule.toLowerCase().replace(/_/g, ' '), 24)} ${count}`);
    }
  }

  p();
  p('Local LLM:');
  p(`  model:              ${summary.localModel}`);
  p(`  jobs evaluated:     ${summary.jobsEvaluated - summary.jobsFromCache}`);
  p(`  served from cache:  ${summary.jobsFromCache}`);
  p(`  batches:            ${summary.batches}`);
  p(`  requests:           ${summary.usage.localRequests}`);
  p(`  cloud escalations:  ${summary.usage.cloudRequests}`);

  const escalations = Object.entries(summary.escalationReasonCounts);
  if (escalations.length > 0) {
    p();
    p('Escalation reasons:');
    for (const [reason, count] of escalations.sort((a, b) => b[1] - a[1])) {
      p(`  - ${reason}: ${count}`);
    }
  }

  p();
  p('Results:');
  p(`  HIGH_PRIORITY: ${String(summary.counts.HIGH_PRIORITY).padStart(4)}`);
  p(`  APPLY:         ${String(summary.counts.APPLY).padStart(4)}`);
  p(`  CONSIDER:      ${String(summary.counts.CONSIDER).padStart(4)}`);
  p(`  SKIP:          ${String(summary.counts.SKIP).padStart(4)}`);
  p(`  (newly discovered: ${summary.jobsNew})`);

  p();
  p('Cloud API:');
  p(`  model:            ${summary.cloudModel ?? 'not configured'}`);
  p(`  requests:         ${summary.usage.cloudRequests}`);
  p(`  input tokens:     ${summary.usage.cloudInputTokens}`);
  p(`  output tokens:    ${summary.usage.cloudOutputTokens}`);
  p(`  estimated cost:   $${summary.usage.estimatedCloudCost.toFixed(4)}`);

  if (summary.outputFiles.length > 0) {
    p();
    p('Output:');
    for (const file of summary.outputFiles) p(`  ${file}`);
  }

  if (summary.errors.length > 0) {
    p();
    p('Warnings and errors:');
    for (const error of summary.errors) p(`  - ${error}`);
  }

  const top = summary.ranked.filter((r) => r.evaluation.recommendation !== 'SKIP').slice(0, 5);
  if (top.length > 0) {
    p();
    p('Top matches:');
    for (const item of top) {
      p(
        `  ${String(item.evaluation.score).padStart(3)}  ${item.evaluation.recommendation.padEnd(14)} ${item.job.company} — ${item.job.title}`,
      );
    }
  }
  p();
}
