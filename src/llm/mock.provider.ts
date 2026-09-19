import { estimateTokens, type LLMProvider, type LLMRequest, type LLMResponse } from './provider.js';

export interface MockScriptEntry {
  /** Raw text the model should return. Use to simulate malformed output. */
  text: string;
}

export interface MockProviderOptions {
  name?: string;
  kind?: 'local' | 'cloud';
  model?: string;
  /** Consumed in order; the last entry repeats once exhausted. */
  script?: MockScriptEntry[];
  /** Full control: ignore the script and compute a response per request. */
  respond?: (request: LLMRequest, callIndex: number) => string;
  healthy?: boolean;
  /** Simulate a transport failure on the Nth call (0-based). */
  throwOnCall?: number[];
}

/**
 * Deterministic provider for tests. Records every request so escalation
 * behaviour can be asserted on call counts, not on wall-clock behaviour.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name: string;
  readonly kind: 'local' | 'cloud';
  readonly model: string;

  readonly requests: LLMRequest[] = [];
  private callIndex = 0;

  constructor(private readonly options: MockProviderOptions = {}) {
    this.name = options.name ?? 'mock';
    this.kind = options.kind ?? 'local';
    this.model = options.model ?? 'mock-model';
  }

  get callCount(): number {
    return this.requests.length;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const index = this.callIndex;
    this.callIndex += 1;
    this.requests.push(request);

    if (this.options.throwOnCall?.includes(index)) {
      throw new Error(`mock transport failure on call ${index}`);
    }

    let text: string;
    if (this.options.respond) {
      text = this.options.respond(request, index);
    } else if (this.options.script && this.options.script.length > 0) {
      const entry = this.options.script[Math.min(index, this.options.script.length - 1)];
      text = entry?.text ?? '{}';
    } else {
      text = '{}';
    }

    return {
      text,
      usage: {
        inputTokens: estimateTokens(request.system + request.user),
        outputTokens: estimateTokens(text),
      },
      provider: this.name,
      model: this.model,
    };
  }

  async healthCheck(): Promise<boolean> {
    return this.options.healthy ?? true;
  }
}

/** Convenience builder for a well-formed evaluation payload. */
export function mockEvaluationJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jobId: 'job-1',
    score: 85,
    confidence: 0.9,
    recommendation: 'APPLY',
    matchingSkills: ['TypeScript'],
    missingSkills: [],
    reasons: ['Role matches target'],
    concerns: [],
    needsCloud: false,
    escalationReason: null,
    uncertainties: {
      seniority: false,
      experience: false,
      salary: false,
      requirements: false,
      conflicting: false,
    },
    ...overrides,
  });
}
