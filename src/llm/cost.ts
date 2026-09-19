import type { TokenUsage } from './provider.js';

export interface CostConfig {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
}

export interface UsageSummary {
  localRequests: number;
  cloudRequests: number;
  localInputTokens: number;
  localOutputTokens: number;
  cloudInputTokens: number;
  cloudOutputTokens: number;
  estimatedCloudCost: number;
}

/** Accumulates per-run token usage. Local tokens are free but still worth seeing. */
export class UsageTracker {
  private local = { requests: 0, input: 0, output: 0 };
  private cloud = { requests: 0, input: 0, output: 0 };

  constructor(private readonly config: CostConfig) {}

  record(kind: 'local' | 'cloud', usage: TokenUsage): void {
    const bucket = kind === 'local' ? this.local : this.cloud;
    bucket.requests += 1;
    bucket.input += usage.inputTokens;
    bucket.output += usage.outputTokens;
  }

  get cloudRequests(): number {
    return this.cloud.requests;
  }

  estimatedCloudCost(): number {
    const input = (this.cloud.input / 1_000_000) * this.config.inputCostPerMTok;
    const output = (this.cloud.output / 1_000_000) * this.config.outputCostPerMTok;
    return Number((input + output).toFixed(6));
  }

  summary(): UsageSummary {
    return {
      localRequests: this.local.requests,
      cloudRequests: this.cloud.requests,
      localInputTokens: this.local.input,
      localOutputTokens: this.local.output,
      cloudInputTokens: this.cloud.input,
      cloudOutputTokens: this.cloud.output,
      estimatedCloudCost: this.estimatedCloudCost(),
    };
  }
}
