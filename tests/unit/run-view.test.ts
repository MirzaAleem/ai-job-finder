import { describe, it, expect } from 'vitest';
import { toRunDetailView, toRunSummaryView } from '../../src/dashboard/views/run.view.js';
import type { RunRow } from '../../src/db/rows.js';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');

function row(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 7,
    started_at: '2026-09-18T11:00:00.000Z',
    completed_at: '2026-09-18T11:04:00.000Z',
    status: 'COMPLETED',
    source_counts: '{"mock":25}',
    jobs_fetched: 25,
    jobs_deduplicated: 24,
    jobs_filtered: 12,
    jobs_evaluated: 12,
    jobs_from_cache: 2,
    jobs_new: 10,
    local_llm_requests: 3,
    cloud_llm_requests: 1,
    cloud_input_tokens: 900,
    cloud_output_tokens: 120,
    estimated_cloud_cost: 0.0042,
    escalation_reason_counts: '{"Low confidence":1}',
    high_priority_count: 2,
    apply_count: 3,
    consider_count: 4,
    skip_count: 3,
    output_files: '["output/jobs-2026-09-18.csv"]',
    errors: '[]',
    created_at: '2026-09-18T11:00:00.000Z',
    updated_at: '2026-09-18T11:04:00.000Z',
    ...overrides,
  } as RunRow;
}

describe('toRunSummaryView', () => {
  it('stringifies the id and computes the duration', () => {
    const view = toRunSummaryView(row(), NOW);
    expect(view.id).toBe('7');
    expect(view.durationMs).toBe(4 * 60 * 1000);
  });

  it('decodes the JSON columns', () => {
    expect(toRunSummaryView(row(), NOW).outputFiles).toEqual(['output/jobs-2026-09-18.csv']);
  });

  it('counts errors without exposing the raw column', () => {
    const view = toRunSummaryView(row({ errors: '["a","b"]' }), NOW);
    expect(view.errorCount).toBe(2);
    expect(view).not.toHaveProperty('errors');
  });

  it('survives a corrupt JSON column', () => {
    const view = toRunSummaryView(row({ output_files: 'not json', errors: '{' }), NOW);
    expect(view.outputFiles).toEqual([]);
    expect(view.errorCount).toBe(0);
  });

  it('has no duration while a run is still going', () => {
    const view = toRunSummaryView(row({ completed_at: null, status: 'RUNNING' }), NOW);
    expect(view.durationMs).toBeNull();
    expect(view.completedAt).toBeNull();
  });

  it('does not call a fresh RUNNING row interrupted', () => {
    const view = toRunSummaryView(
      row({ completed_at: null, status: 'RUNNING', started_at: '2026-09-18T11:59:00.000Z' }),
      NOW,
    );
    expect(view.interrupted).toBe(false);
  });

  it('flags a RUNNING row left behind by a killed process', () => {
    // kill -9 leaves the row untouched, so age is the only signal available.
    const view = toRunSummaryView(
      row({ completed_at: null, status: 'RUNNING', started_at: '2026-09-17T11:00:00.000Z' }),
      NOW,
    );
    expect(view.interrupted).toBe(true);
  });

  it('never flags a finished run as interrupted', () => {
    const view = toRunSummaryView(row({ started_at: '2026-01-01T00:00:00.000Z' }), NOW);
    expect(view.interrupted).toBe(false);
  });
});

describe('toRunDetailView', () => {
  it('adds the breakdowns the summary leaves out', () => {
    const view = toRunDetailView(row({ errors: '["mock: boom"]' }), NOW);
    expect(view).toMatchObject({
      jobsDeduplicated: 24,
      jobsFiltered: 12,
      localRequests: 3,
      cloudInputTokens: 900,
      sourceCounts: { mock: 25 },
      escalationReasonCounts: { 'Low confidence': 1 },
      errors: ['mock: boom'],
    });
  });

  it('still carries everything the summary has', () => {
    const view = toRunDetailView(row(), NOW);
    expect(view.counts).toEqual({ HIGH_PRIORITY: 2, APPLY: 3, CONSIDER: 4, SKIP: 3 });
  });
});
