export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMRequest {
  system: string;
  user: string;
  /** Ask the provider to constrain output to JSON where it supports doing so. */
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LLMResponse {
  text: string;
  usage: TokenUsage;
  provider: string;
  model: string;
}

/**
 * The single seam between the pipeline and any model. Nothing outside src/llm
 * should import a concrete provider.
 */
export interface LLMProvider {
  readonly name: string;
  readonly kind: 'local' | 'cloud';
  readonly model: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  healthCheck(): Promise<boolean>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Rough fallback when a provider reports no usage. ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
