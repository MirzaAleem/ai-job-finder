import {
  LLMError,
  estimateTokens,
  fetchWithTimeout,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from './provider.js';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  numCtx: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string; size?: number; details?: { parameter_size?: string } }>;
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number | null;
  parameterSize: string | null;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly kind = 'local' as const;
  readonly model: string;

  constructor(private readonly options: OllamaOptions) {
    this.model = options.model;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = {
      model: this.model,
      stream: false,
      format: request.json ? 'json' : undefined,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      options: {
        temperature: request.temperature ?? 0,
        num_ctx: this.options.numCtx,
        ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {}),
      },
    };

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.options.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        this.options.timeoutMs,
      );
    } catch (err) {
      // An abort is a timeout, not an unreachable daemon. Saying "is ollama
      // running?" when it is running and merely slow sends you the wrong way.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError(
          `Ollama timed out after ${this.options.timeoutMs}ms with model "${this.model}". ` +
            'Raise OLLAMA_TIMEOUT_MS, lower LLM_BATCH_SIZE, or use a smaller model.',
          this.name,
          err,
        );
      }
      throw new LLMError(
        `Could not reach Ollama at ${this.options.baseUrl}. Is \`ollama serve\` running?`,
        this.name,
        err,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LLMError(`Ollama returned ${response.status}: ${detail.slice(0, 300)}`, this.name);
    }

    const data = (await response.json()) as OllamaChatResponse;
    if (data.error) throw new LLMError(`Ollama error: ${data.error}`, this.name);

    const text = data.message?.content ?? '';
    return {
      text,
      usage: {
        inputTokens: data.prompt_eval_count ?? estimateTokens(request.system + request.user),
        outputTokens: data.eval_count ?? estimateTokens(text),
      },
      provider: this.name,
      model: this.model,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.some((m) => m.name === this.model);
    } catch {
      return false;
    }
  }

  /** Backs the interactive model picker in the CLI. */
  async listModels(): Promise<OllamaModelInfo[]> {
    const response = await fetchWithTimeout(
      `${this.options.baseUrl}/api/tags`,
      { method: 'GET' },
      10_000,
    ).catch((err) => {
      throw new LLMError(
        `Could not reach Ollama at ${this.options.baseUrl}. Is \`ollama serve\` running?`,
        this.name,
        err,
      );
    });

    if (!response.ok) {
      throw new LLMError(`Ollama returned ${response.status} listing models`, this.name);
    }
    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? null,
      parameterSize: m.details?.parameter_size ?? null,
    }));
  }
}
