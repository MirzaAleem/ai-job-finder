import {
  LLMError,
  estimateTokens,
  fetchWithTimeout,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from './provider.js';

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
}

interface OpenAIStyleResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  readonly kind = 'cloud' as const;
  readonly model: string;

  constructor(private readonly options: OpenRouterOptions) {
    if (!options.apiKey) {
      throw new LLMError('OPENROUTER_API_KEY is not set', this.name);
    }
    this.model = options.model;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = {
      model: this.model,
      temperature: request.temperature ?? 0,
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    };

    const response = await fetchWithTimeout(
      `${this.options.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
          'X-Title': 'ai-job-finder',
        },
        body: JSON.stringify(body),
      },
      this.options.timeoutMs ?? 90_000,
    ).catch((err) => {
      throw new LLMError('OpenRouter request failed', this.name, err);
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Never echo the body wholesale — it can contain the request headers.
      throw new LLMError(
        `OpenRouter returned ${response.status}: ${detail.slice(0, 200)}`,
        this.name,
      );
    }

    const data = (await response.json()) as OpenAIStyleResponse;
    if (data.error) throw new LLMError(`OpenRouter error: ${data.error.message}`, this.name);

    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? estimateTokens(request.system + request.user),
        outputTokens: data.usage?.completion_tokens ?? estimateTokens(text),
      },
      provider: this.name,
      model: this.model,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${this.options.baseUrl}/models`,
        { headers: { Authorization: `Bearer ${this.options.apiKey}` } },
        10_000,
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
