import { AppError } from '../../lib/errors';

export interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterChatCompletionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: OpenRouterChatMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  responseFormat?: unknown;
  provider?: unknown;
  plugins?: unknown;
}

export interface OpenRouterChatCompletionResult {
  status: number;
  model: string;
  content: string;
}

export class OpenRouterClient {
  async createChatCompletion(
    input: OpenRouterChatCompletionInput
  ): Promise<OpenRouterChatCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const response = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          max_tokens: input.maxTokens,
          temperature: input.temperature,
          stream: false,
          ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.plugins ? { plugins: input.plugins } : {})
        })
      });

      if (!response.ok) {
        throw await mapOpenRouterStatus(response);
      }

      const payload = await parseJson(response);

      const rawContent = payload?.choices?.[0]?.message?.content;
      const content = extractMessageContent(rawContent);
      if (!content) {
        throw new AppError({
          code: 'OPENROUTER_INVALID_RESPONSE',
          httpStatus: 502,
          safeMessage: 'OpenRouter response did not include message content',
          metadata: {
            status: response.status,
            model: typeof payload?.model === 'string' ? payload.model : input.model,
            output_type: Array.isArray(rawContent) ? 'array' : typeof rawContent,
            finish_reason: payload?.choices?.[0]?.finish_reason
          }
        });
      }

      return {
        status: response.status,
        model: typeof payload.model === 'string' ? payload.model : input.model,
        content
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new AppError({
          code: 'AI_REQUEST_TIMEOUT',
          httpStatus: 504,
          safeMessage: 'AI request timed out',
          cause
        });
      }
      throw new AppError({
        code: 'OPENROUTER_NETWORK_ERROR',
        httpStatus: 502,
        safeMessage: 'OpenRouter network request failed',
        cause
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractMessageContent(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (Object.keys(content).length === 0) return undefined;
    return JSON.stringify(content);
  }
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      return '';
    })
    .join('\n')
    .trim();

  return text || undefined;
}

async function parseJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch (cause) {
    throw new AppError({
      code: 'OPENROUTER_INVALID_RESPONSE',
      httpStatus: 502,
      safeMessage: 'OpenRouter returned malformed JSON',
      cause,
      metadata: { status: response.status }
    });
  }
}

async function mapOpenRouterStatus(response: Response): Promise<AppError> {
  const status = response.status;
  const upstream_error = await readSafeErrorBody(response);
  if (status === 401 || status === 403) {
    return new AppError({
      code: 'OPENROUTER_AUTH_ERROR',
      httpStatus: 401,
      safeMessage: 'OpenRouter authentication failed',
      metadata: { status, upstream_error }
    });
  }
  if (status === 429) {
    return new AppError({
      code: 'OPENROUTER_RATE_LIMITED',
      httpStatus: 429,
      safeMessage: 'OpenRouter rate limit reached',
      metadata: { status, upstream_error }
    });
  }
  if (status >= 500) {
    return new AppError({
      code: 'OPENROUTER_UPSTREAM_ERROR',
      httpStatus: 502,
      safeMessage: 'OpenRouter upstream error',
      metadata: { status, upstream_error }
    });
  }
  return new AppError({
    code: 'OPENROUTER_INVALID_RESPONSE',
    httpStatus: 502,
    safeMessage: 'OpenRouter request failed',
    metadata: { status, upstream_error }
  });
}

async function readSafeErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 1000);
    }
  } catch {
    return undefined;
  }
}
