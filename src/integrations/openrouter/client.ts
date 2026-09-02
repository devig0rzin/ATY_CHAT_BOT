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
          ...(input.responseFormat ? { response_format: input.responseFormat } : {})
        })
      });

      if (!response.ok) {
        throw mapOpenRouterStatus(response.status);
      }

      const payload = await parseJson(response);

      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new AppError({
          code: 'OPENROUTER_INVALID_RESPONSE',
          httpStatus: 502,
          safeMessage: 'OpenRouter response did not include message content'
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

function mapOpenRouterStatus(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError({
      code: 'OPENROUTER_AUTH_ERROR',
      httpStatus: 401,
      safeMessage: 'OpenRouter authentication failed',
      metadata: { status }
    });
  }
  if (status === 429) {
    return new AppError({
      code: 'OPENROUTER_RATE_LIMITED',
      httpStatus: 429,
      safeMessage: 'OpenRouter rate limit reached',
      metadata: { status }
    });
  }
  if (status >= 500) {
    return new AppError({
      code: 'OPENROUTER_UPSTREAM_ERROR',
      httpStatus: 502,
      safeMessage: 'OpenRouter upstream error',
      metadata: { status }
    });
  }
  return new AppError({
    code: 'OPENROUTER_INVALID_RESPONSE',
    httpStatus: 502,
    safeMessage: 'OpenRouter request failed',
    metadata: { status }
  });
}
