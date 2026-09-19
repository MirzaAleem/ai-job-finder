import {
  LLMError,
  estimateTokens,
  fetchWithTimeout,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from './provider.js';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Reasoning tokens. Billed as output, and often larger than the answer. */
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

/**
 * Google Generative Language API. Present because an OpenRouter key and a Gemini
 * key are not interchangeable, and the escalation path should work with whichever
 * the user actually holds. Selected via CLOUD_PROVIDER=gemini.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly kind = 'cloud' as const;
  readonly model: string;

  constructor(private readonly options: GeminiOptions) {
    if (!options.apiKey) {
      throw new LLMError('GEMINI_API_KEY is not set', this.name);
    }
    this.model = options.model;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: request.temperature ?? 0,
        ...(request.json ? { responseMimeType: 'application/json' } : {}),
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      },
    };

    // The key travels in a header, not the URL, so it cannot leak via logs.
    const response = await fetchWithTimeout(
      `${this.options.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.options.apiKey,
        },
        body: JSON.stringify(body),
      },
      this.options.timeoutMs ?? 90_000,
    ).catch((err) => {
      throw new LLMError('Gemini request failed', this.name, err);
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LLMError(`Gemini returned ${response.status}: ${detail.slice(0, 200)}`, this.name);
    }

    const data = (await response.json()) as GeminiResponse;
    if (data.error) throw new LLMError(`Gemini error: ${data.error.message}`, this.name);

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    const usage = data.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? estimateTokens(request.system + request.user);

    // Thinking models report thoughtsTokenCount separately from the answer, and
    // both are billed. Prefer the total minus the prompt so nothing is missed;
    // undercounting here would make the cost summary quietly wrong.
    const billedOutput =
      usage?.totalTokenCount !== undefined
        ? Math.max(0, usage.totalTokenCount - inputTokens)
        : (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);

    return {
      text,
      usage: {
        inputTokens,
        outputTokens: billedOutput > 0 ? billedOutput : estimateTokens(text),
      },
      provider: this.name,
      model: this.model,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${this.options.baseUrl}/models`,
        { headers: { 'x-goog-api-key': this.options.apiKey } },
        10_000,
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
