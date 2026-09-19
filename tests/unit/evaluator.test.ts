import { describe, expect, it } from 'vitest';
import { Evaluator, type EvaluationInput } from '../../src/llm/evaluator.js';
import { MockLLMProvider, mockEvaluationJson } from '../../src/llm/mock.provider.js';
import { InMemoryEvaluationCache, NoopEvaluationCache } from '../../src/llm/cache.js';
import { UsageTracker } from '../../src/llm/cost.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { toPromptJob } from '../../src/llm/prompts/local-eval.js';
import { job, testProfile } from '../helpers/fixtures.js';

const thresholds = { highPriority: 90, apply: 80, consider: 65 };

function input(jobId = 'job-1', contentHash = 'a'.repeat(64)): EvaluationInput {
  return { job: toPromptJob(job(), jobId, 4000), contentHash };
}

interface HarnessOptions {
  localScript?: string[];
  cloudScript?: string[];
  cloudProvider?: MockLLMProvider | null;
  confidenceThreshold?: number;
  escalationEnabled?: boolean;
  batchSize?: number;
  maxRetries?: number;
  maxCloudRequests?: number;
  cache?: InMemoryEvaluationCache | NoopEvaluationCache;
}

function harness(options: HarnessOptions = {}) {
  const local = new MockLLMProvider({
    kind: 'local',
    model: 'local-test',
    script: (options.localScript ?? [mockEvaluationJson()]).map((text) => ({ text })),
  });

  const cloud =
    options.cloudProvider === null
      ? null
      : (options.cloudProvider ??
        new MockLLMProvider({
          kind: 'cloud',
          name: 'mock-cloud',
          model: 'cloud-test',
          script: (
            options.cloudScript ?? [mockEvaluationJson({ score: 70, confidence: 0.95 })]
          ).map((text) => ({ text })),
        }));

  const usage = new UsageTracker({ inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 });
  const cache = options.cache ?? new NoopEvaluationCache();

  const evaluator = new Evaluator({
    local,
    cloud,
    cache,
    usage,
    logger: createSilentLogger(),
    escalation: {
      confidenceThreshold: options.confidenceThreshold ?? 0.8,
      enabled: options.escalationEnabled ?? true,
    },
    thresholds,
    batchSize: options.batchSize ?? 1,
    maxRetries: options.maxRetries ?? 1,
    maxCloudRequests: options.maxCloudRequests ?? 25,
  });

  return { evaluator, local, cloud, usage, cache };
}

describe('Scenario 1 — high confidence makes no cloud call', () => {
  it('accepts the local result and never touches the cloud', async () => {
    const { evaluator, local, cloud, usage } = harness({
      localScript: [mockEvaluationJson({ confidence: 0.95, needsCloud: false, score: 92 })],
    });

    const [result] = await evaluator.evaluateAll(testProfile, [input()]);

    expect(local.callCount).toBe(1);
    expect((cloud as MockLLMProvider).callCount).toBe(0);
    expect(result?.providerUsed).toBe('LOCAL');
    expect(result?.escalated).toBe(false);
    expect(result?.degraded).toBe(false);
    expect(result?.recommendation).toBe('HIGH_PRIORITY');
    expect(usage.summary().cloudRequests).toBe(0);
    expect(usage.estimatedCloudCost()).toBe(0);
  });
});

describe('Scenario 2 — low confidence escalates to the cloud', () => {
  it('calls the cloud once and uses its verdict', async () => {
    const { evaluator, local, cloud, usage } = harness({
      localScript: [mockEvaluationJson({ confidence: 0.62, needsCloud: true, score: 88 })],
      cloudScript: [mockEvaluationJson({ confidence: 0.96, score: 72 })],
    });

    const [result] = await evaluator.evaluateAll(testProfile, [input()]);

    expect(local.callCount).toBe(1);
    expect((cloud as MockLLMProvider).callCount).toBe(1);
    expect(result?.providerUsed).toBe('CLOUD');
    expect(result?.escalated).toBe(true);
    expect(result?.score).toBe(72);
    expect(result?.recommendation).toBe('CONSIDER');
    expect(result?.escalationReasons).toEqual(
      expect.arrayContaining(['LOW_CONFIDENCE', 'MODEL_REQUESTED']),
    );
    expect(usage.summary().cloudRequests).toBe(1);
    expect(result?.localEvaluation?.score).toBe(88);
    expect(result?.cloudEvaluation?.score).toBe(72);
  });

  it('sends the local evaluation and the reason to the cloud model', async () => {
    const { evaluator, cloud } = harness({
      localScript: [mockEvaluationJson({ confidence: 0.5, score: 88 })],
    });

    await evaluator.evaluateAll(testProfile, [input()]);

    const prompt = (cloud as MockLLMProvider).requests[0]?.user ?? '';
    expect(prompt).toContain('LOCAL MODEL EVALUATION');
    expect(prompt).toContain('WHY THIS WAS ESCALATED');
    expect(prompt).toContain('low confidence');
  });
});

describe('Scenario 3 — malformed local output retries, then escalates', () => {
  it('retries the local model before escalating', async () => {
    const { evaluator, local, cloud } = harness({
      localScript: ['this is not json at all', 'still not json'],
      maxRetries: 1,
    });

    const [result] = await evaluator.evaluateAll(testProfile, [input()]);

    expect(local.callCount).toBe(2);
    expect((cloud as MockLLMProvider).callCount).toBe(1);
    expect(result?.escalationReasons).toContain('MALFORMED_RESPONSE');
    expect(result?.providerUsed).toBe('CLOUD');
  });

  it('uses the repair prompt on the retry', async () => {
    const { evaluator, local } = harness({ localScript: ['garbage', 'garbage'], maxRetries: 1 });
    await evaluator.evaluateAll(testProfile, [input()]);
    expect(local.requests[1]?.system).toContain('YOUR PREVIOUS RESPONSE WAS REJECTED');
  });

  it('does not escalate if the retry succeeds', async () => {
    const { evaluator, local, cloud } = harness({
      localScript: ['not json', mockEvaluationJson({ confidence: 0.95 })],
      maxRetries: 1,
    });

    const [result] = await evaluator.evaluateAll(testProfile, [input()]);

    expect(local.callCount).toBe(2);
    expect((cloud as MockLLMProvider).callCount).toBe(0);
    expect(result?.providerUsed).toBe('LOCAL');
  });

  it('recovers JSON wrapped in fences and prose without a retry', async () => {
    const { evaluator, local } = harness({
      localScript: ['Sure!\n```json\n' + mockEvaluationJson({ confidence: 0.95 }) + '\n```'],
    });
    const [result] = await evaluator.evaluateAll(testProfile, [input()]);
    expect(local.callCount).toBe(1);
    expect(result?.providerUsed).toBe('LOCAL');
  });

  it('returns a zero-confidence result when both local and cloud fail', async () => {
    const { evaluator } = harness({
      localScript: ['garbage', 'garbage'],
      cloudScript: ['also garbage'],
    });

    const [result] = await evaluator.evaluateAll(testProfile, [input()]);

    expect(result?.score).toBe(0);
    expect(result?.confidence).toBe(0);
    expect(result?.recommendation).toBe('SKIP');
    expect(result?.degraded).toBe(true);
    expect(result?.concerns.join(' ')).toContain('manually');
  });

  it('survives a transport failure and escalates', async () => {
    const local = new MockLLMProvider({ kind: 'local', throwOnCall: [0, 1] });
    const cloud = new MockLLMProvider({
      kind: 'cloud',
      script: [{ text: mockEvaluationJson({ confidence: 0.9 }) }],
    });
    const evaluator = new Evaluator({
      local,
      cloud,
      cache: new NoopEvaluationCache(),
      usage: new UsageTracker({ inputCostPerMTok: 0, outputCostPerMTok: 0 }),
      logger: createSilentLogger(),
      escalation: { confidenceThreshold: 0.8, enabled: true },
      thresholds,
      batchSize: 1,
      maxRetries: 1,
      maxCloudRequests: 5,
    });

    const [result] = await evaluator.evaluateAll(testProfile, [input()]);
    expect(result?.providerUsed).toBe('CLOUD');
  });
});

describe('Scenario 4 — an unchanged job makes no LLM call', () => {
  it('serves a cached evaluation without calling any model', async () => {
    const cache = new InMemoryEvaluationCache();
    const contentHash = 'c'.repeat(64);
    await cache.set(contentHash, 'local-test', {
      score: 88,
      confidence: 0.93,
      recommendation: 'APPLY',
      matchingSkills: ['TypeScript'],
      missingSkills: [],
      reasons: ['cached'],
      concerns: [],
      providerUsed: 'LOCAL',
      provider: 'ollama',
      model: 'local-test',
    });

    const { evaluator, local, cloud } = harness({ cache });
    const [result] = await evaluator.evaluateAll(testProfile, [input('job-1', contentHash)]);

    expect(local.callCount).toBe(0);
    expect((cloud as MockLLMProvider).callCount).toBe(0);
    expect(result?.fromCache).toBe(true);
    expect(result?.score).toBe(88);
  });

  it('does not reuse a cache entry written by a different model', async () => {
    const cache = new InMemoryEvaluationCache();
    const contentHash = 'd'.repeat(64);
    await cache.set(contentHash, 'some-other-model', {
      score: 88,
      confidence: 0.93,
      recommendation: 'APPLY',
      matchingSkills: [],
      missingSkills: [],
      reasons: [],
      concerns: [],
      providerUsed: 'LOCAL',
      provider: 'ollama',
      model: 'some-other-model',
    });

    const { evaluator, local } = harness({ cache });
    await evaluator.evaluateAll(testProfile, [input('job-1', contentHash)]);
    expect(local.callCount).toBe(1);
  });
});

describe('Scenario 5 — a changed description is re-evaluated', () => {
  it('misses the cache when the content hash changes', async () => {
    const cache = new InMemoryEvaluationCache();
    const originalHash = 'e'.repeat(64);

    const first = harness({ cache, localScript: [mockEvaluationJson({ confidence: 0.95 })] });
    await first.evaluator.evaluateAll(testProfile, [input('job-1', originalHash)]);
    expect(first.local.callCount).toBe(1);

    // Simulate the pipeline persisting that result.
    await cache.set(originalHash, 'local-test', {
      score: 85,
      confidence: 0.9,
      recommendation: 'APPLY',
      matchingSkills: [],
      missingSkills: [],
      reasons: [],
      concerns: [],
      providerUsed: 'LOCAL',
      provider: 'ollama',
      model: 'local-test',
    });

    // Unchanged content: no call.
    const second = harness({ cache });
    await second.evaluator.evaluateAll(testProfile, [input('job-1', originalHash)]);
    expect(second.local.callCount).toBe(0);

    // Changed content: a fresh evaluation.
    const third = harness({ cache });
    await third.evaluator.evaluateAll(testProfile, [input('job-1', 'f'.repeat(64))]);
    expect(third.local.callCount).toBe(1);
  });
});

describe('batching', () => {
  it('evaluates several jobs in one local request', async () => {
    const batchResponse = JSON.stringify({
      evaluations: [
        JSON.parse(mockEvaluationJson({ jobId: 'job-1', confidence: 0.95 })),
        JSON.parse(mockEvaluationJson({ jobId: 'job-2', confidence: 0.95 })),
        JSON.parse(mockEvaluationJson({ jobId: 'job-3', confidence: 0.95 })),
      ],
    });

    const { evaluator, local } = harness({ localScript: [batchResponse], batchSize: 3 });
    const results = await evaluator.evaluateAll(testProfile, [
      input('job-1', 'a'.repeat(64)),
      input('job-2', 'b'.repeat(64)),
      input('job-3', 'c'.repeat(64)),
    ]);

    expect(local.callCount).toBe(1);
    expect(results).toHaveLength(3);
  });

  it('falls back to per-job calls when the batch returns the wrong count', async () => {
    const shortBatch = JSON.stringify({
      evaluations: [JSON.parse(mockEvaluationJson({ jobId: 'job-1', confidence: 0.95 }))],
    });

    const { evaluator, local } = harness({
      localScript: [shortBatch, mockEvaluationJson({ confidence: 0.95 })],
      batchSize: 3,
    });

    const results = await evaluator.evaluateAll(testProfile, [
      input('job-1', 'a'.repeat(64)),
      input('job-2', 'b'.repeat(64)),
      input('job-3', 'c'.repeat(64)),
    ]);

    // 1 failed batch + 3 individual retries.
    expect(local.callCount).toBe(4);
    expect(results).toHaveLength(3);
  });

  it('falls back to per-job calls when the batch is unparseable', async () => {
    const { evaluator, local } = harness({
      localScript: ['not json', mockEvaluationJson({ confidence: 0.95 })],
      batchSize: 2,
    });

    const results = await evaluator.evaluateAll(testProfile, [
      input('job-1', 'a'.repeat(64)),
      input('job-2', 'b'.repeat(64)),
    ]);

    expect(results).toHaveLength(2);
    expect(local.callCount).toBeGreaterThan(1);
  });
});

describe('degraded operation', () => {
  it('keeps the local result and marks it degraded when escalation is disabled', async () => {
    const { evaluator, cloud } = harness({
      localScript: [mockEvaluationJson({ confidence: 0.4, score: 75 })],
      escalationEnabled: false,
    });

    const [result] = await evaluator.evaluateAll(testProfile, [input()]);

    expect((cloud as MockLLMProvider).callCount).toBe(0);
    expect(result?.providerUsed).toBe('LOCAL');
    expect(result?.degraded).toBe(true);
    expect(result?.score).toBe(75);
  });

  it('marks the result degraded when no cloud provider is configured', async () => {
    const { evaluator } = harness({
      localScript: [mockEvaluationJson({ confidence: 0.4 })],
      cloudProvider: null,
    });

    const [result] = await evaluator.evaluateAll(testProfile, [input()]);
    expect(result?.degraded).toBe(true);
    expect(result?.providerUsed).toBe('LOCAL');
  });

  it('stops escalating once the per-run cloud budget is spent', async () => {
    const cloud = new MockLLMProvider({
      kind: 'cloud',
      script: [{ text: mockEvaluationJson({ confidence: 0.95 }) }],
    });
    const { evaluator } = harness({
      localScript: [mockEvaluationJson({ confidence: 0.3 })],
      cloudProvider: cloud,
      maxCloudRequests: 2,
    });

    const results = await evaluator.evaluateAll(
      testProfile,
      ['a', 'b', 'c', 'd'].map((c, i) => input(`job-${i}`, c.repeat(64))),
    );

    expect(cloud.callCount).toBe(2);
    expect(results.filter((r) => r.degraded)).toHaveLength(2);
  });
});

describe('score authority', () => {
  it('derives the recommendation from the score, overruling a contradictory label', async () => {
    const { evaluator } = harness({
      localScript: [mockEvaluationJson({ score: 95, confidence: 0.95, recommendation: 'SKIP' })],
    });
    const [result] = await evaluator.evaluateAll(testProfile, [input()]);
    expect(result?.recommendation).toBe('HIGH_PRIORITY');
  });

  it.each([
    [95, 'HIGH_PRIORITY'],
    [85, 'APPLY'],
    [70, 'CONSIDER'],
    [30, 'SKIP'],
  ])('maps score %i to %s', async (score, expected) => {
    const { evaluator } = harness({
      localScript: [mockEvaluationJson({ score, confidence: 0.95 })],
    });
    const [result] = await evaluator.evaluateAll(testProfile, [input()]);
    expect(result?.recommendation).toBe(expected);
  });
});

describe('prompt hygiene', () => {
  it('never sends raw HTML to the model', async () => {
    const { evaluator, local } = harness();
    const htmlJob: EvaluationInput = {
      job: toPromptJob(job({ description: '<script>x()</script><p>Real text</p>' }), 'job-1', 4000),
      contentHash: 'a'.repeat(64),
    };
    await evaluator.evaluateAll(testProfile, [htmlJob]);
    expect(local.requests[0]?.user).not.toContain('<script>');
    expect(local.requests[0]?.user).toContain('Real text');
  });

  it('truncates very long descriptions', async () => {
    const { evaluator, local } = harness();
    const longJob: EvaluationInput = {
      job: toPromptJob(job({ description: 'word '.repeat(5000) }), 'job-1', 500),
      contentHash: 'a'.repeat(64),
    };
    await evaluator.evaluateAll(testProfile, [longJob]);
    expect(local.requests[0]?.user).toContain('truncated');
  });

  it('instructs the model not to invent information', async () => {
    const { evaluator, local } = harness();
    await evaluator.evaluateAll(testProfile, [input()]);
    const system = local.requests[0]?.system ?? '';
    expect(system).toContain('NEVER invent');
    expect(system).toContain('UNKNOWN IS NOT NEGATIVE');
  });

  it('requests JSON-constrained output', async () => {
    const { evaluator, local } = harness();
    await evaluator.evaluateAll(testProfile, [input()]);
    expect(local.requests[0]?.json).toBe(true);
  });
});
