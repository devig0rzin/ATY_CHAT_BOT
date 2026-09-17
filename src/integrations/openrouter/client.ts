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
  content?: string;
  contentType: string;
  choicesLength: number;
  finishReason?: string;
  refusalPresent: boolean;
  reasoningPresent: boolean;
  toolCallsPresent: boolean;
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
  usageTotalTokens?: number;
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

      const choices = Array.isArray(payload?.choices) ? payload.choices : [];
      const choice = asRecord(choices[0]);
      const message = asRecord(choice?.message);
      const rawContent = message?.content;
      const content = extractAssistantContent(rawContent);
      const usage = asRecord(payload?.usage);

      return {
        status: response.status,
        model: typeof payload.model === 'string' ? payload.model : input.model,
        ...(content ? { content } : {}),
        contentType: contentType(rawContent),
        choicesLength: choices.length,
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
        refusalPresent: hasValue(message?.refusal),
        reasoningPresent: hasValue(message?.reasoning) || hasValue(message?.reasoning_details),
        toolCallsPresent: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
        usagePromptTokens: tokenCount(usage?.prompt_tokens),
        usageCompletionTokens: tokenCount(usage?.completion_tokens),
        usageTotalTokens: tokenCount(usage?.total_tokens)
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

export function extractAssistantContent(content: unknown): string | undefined {
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

function contentType(content: unknown): string {
  if (content === null) return 'null';
  if (Array.isArray(content)) return 'array';
  return typeof content;
}

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
      metadata: { status: response.status, reason: 'malformed_provider_json' }
    });
  }
}

async function mapOpenRouterStatus(response: Response): Promise<AppError> {
  const status = response.status;
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
