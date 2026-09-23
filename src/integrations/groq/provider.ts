import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { prompts } from '../../generated/prompts';
import { aiDecisionJsonSchema, aiDecisionSchema, type AIDecision } from '../openai/schemas';
import type { AIProvider } from '../openai/provider';

interface GroqContext {
  message: string;
  requestId: string;
  memory?: {
    summary: string | null;
    facts_json: string | null;
    open_loops_json: string | null;
    current_intent: string | null;
  };
  recent?: Array<{ direction: string; content: string | null }>;
  image?: {
    url: string;
    mimeType: string;
  };
}

interface GroqCompletion {
  status: number;
  model: string;
  content?: string;
  finishReason?: string;
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
  usageTotalTokens?: number;
  retryAfter?: string;
  remainingRequests?: string;
  remainingTokens?: string;
}

export class GroqProvider implements AIProvider {
  constructor(private readonly config: AppConfig) {}

  async generateReply(context: unknown): Promise<AIDecision> {
    const parsedContext = parseContext(context);
    if (!this.config.GROQ_API_KEY) {
      throw new AppError({
        code: 'GROQ_CONFIGURATION_ERROR',
        httpStatus: 503,
        safeMessage: 'Groq API key is not configured'
      });
    }

    const logger = createLogger(this.config, parsedContext.requestId);
    const startedAt = Date.now();
    logger.info('ai.request.started', {
      provider: 'groq',
      requested_model: requestedModel(this.config, parsedContext)
    });

    try {
      const completion = await createCompletion(this.config, parsedContext);
      logger.info('ai.response.shape', {
        provider: 'groq',
        requested_model: requestedModel(this.config, parsedContext),
        resolved_model: completion.model,
        finish_reason: completion.finishReason ?? null,
        content_present: Boolean(completion.content),
        usage_prompt_tokens: completion.usagePromptTokens ?? null,
        usage_completion_tokens: completion.usageCompletionTokens ?? null,
        usage_total_tokens: completion.usageTotalTokens ?? null
      });
      const decision = parseDecision(completion);
      Object.assign(decision, { resolved_model: completion.model });
      logger.info('ai.request.completed', {
        provider: 'groq',
        requested_model: requestedModel(this.config, parsedContext),
        resolved_model: completion.model,
        status: completion.status,
        duration_ms: Date.now() - startedAt,
        usage_prompt_tokens: completion.usagePromptTokens ?? null,
        usage_completion_tokens: completion.usageCompletionTokens ?? null,
        usage_total_tokens: completion.usageTotalTokens ?? null
      });
      return decision;
    } catch (cause) {
      const error =
        cause instanceof AppError
          ? cause
          : new AppError({
              code: 'GROQ_INVALID_RESPONSE',
              httpStatus: 502,
              safeMessage: 'Groq response failed validation',
              cause
            });
      logger.error('ai.request.failed', {
        provider: 'groq',
        requested_model: requestedModel(this.config, parsedContext),
        error_code: error.code,
        http_status: numberMetadata(error.metadata, 'http_status', 'status'),
        groq_error_type: stringMetadata(error.metadata, 'groq_error_type'),
        groq_error_code: stringMetadata(error.metadata, 'groq_error_code'),
        provider_request_id: stringMetadata(error.metadata, 'provider_request_id'),
        duration_ms: Date.now() - startedAt
      });
      throw error;
    }
  }
}

async function createCompletion(config: AppConfig, context: GroqContext): Promise<GroqCompletion> {
  const model = requestedModel(config, context);
  if (context.image && !config.GROQ_VISION_ENABLED) {
    throw new AppError({
      code: 'GROQ_VISION_DISABLED',
      httpStatus: 503,
      safeMessage: 'Groq image understanding is disabled'
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.GROQ_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: context.image
              ? [
                  { type: 'text', text: buildConversationInput(context) },
                  {
                    type: 'image_url',
                    image_url: { url: context.image.url }
                  }
                ]
              : buildConversationInput(context)
          }
        ],
        max_tokens: config.OPENAI_MAX_OUTPUT_TOKENS,
        temperature: config.AI_TEMPERATURE,
        stream: false,
        ...(context.image
          ? { response_format: { type: 'json_object' } }
          : {
              reasoning_effort: 'low',
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'aty_ai_decision',
                  strict: true,
                  schema: aiDecisionJsonSchema
                }
              }
            })
      })
    });

    const metadata: Record<string, unknown> = {
      model,
      status: response.status,
      http_status: response.status,
      provider_request_id: maskProviderRequestId(
        response.headers.get('x-request-id') ?? response.headers.get('request-id')
      ),
      retry_after: response.headers.get('retry-after') ?? undefined,
      limit_requests: response.headers.get('x-ratelimit-limit-requests') ?? undefined,
      remaining_requests: response.headers.get('x-ratelimit-remaining-requests') ?? undefined,
      reset_requests: response.headers.get('x-ratelimit-reset-requests') ?? undefined,
      limit_tokens: response.headers.get('x-ratelimit-limit-tokens') ?? undefined,
      remaining_tokens: response.headers.get('x-ratelimit-remaining-tokens') ?? undefined,
      reset_tokens: response.headers.get('x-ratelimit-reset-tokens') ?? undefined
    };
    if (!response.ok) Object.assign(metadata, await readGroqErrorMetadata(response));
    if (response.status === 429) {
      throw new AppError({
        code: 'GROQ_RATE_LIMIT',
        httpStatus: 429,
        safeMessage: 'Groq rate limit reached',
        metadata
      });
    }
    if (response.status >= 500) {
      throw new AppError({
        code: 'GROQ_UPSTREAM_ERROR',
        httpStatus: 502,
        safeMessage: 'Groq upstream error',
        metadata
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError({
        code: 'GROQ_AUTH_ERROR',
        httpStatus: 502,
        safeMessage: 'Groq authentication or permission failed',
        metadata
      });
    }
    if (response.status === 404) {
      throw new AppError({
        code: 'GROQ_MODEL_OR_ENDPOINT_ERROR',
        httpStatus: 502,
        safeMessage: 'Groq model or endpoint was not found',
        metadata
      });
    }
    if (response.status === 400 || response.status === 422) {
      throw new AppError({
        code: 'GROQ_BAD_REQUEST',
        httpStatus: 502,
        safeMessage: 'Groq rejected the request',
        metadata
      });
    }
    if (!response.ok) {
      throw new AppError({
        code: 'GROQ_BAD_REQUEST',
        httpStatus: 502,
        safeMessage: 'Groq rejected the request',
        metadata
      });
    }

    let payload: any;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new AppError({
        code: 'GROQ_INVALID_RESPONSE',
        httpStatus: 502,
        safeMessage: 'Groq returned malformed JSON',
        cause,
        metadata: { model, status: response.status }
      });
    }

    const choice = payload?.choices?.[0];
    const content =
      typeof choice?.message?.content === 'string' ? choice.message.content : undefined;
    const usage = payload?.usage;
    return {
      status: response.status,
      model: typeof payload?.model === 'string' ? payload.model : model,
      content,
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
      usagePromptTokens: tokenCount(usage?.prompt_tokens),
      usageCompletionTokens: tokenCount(usage?.completion_tokens),
      usageTotalTokens: tokenCount(usage?.total_tokens),
      retryAfter: stringMetadata(metadata, 'retry_after'),
      remainingRequests: stringMetadata(metadata, 'remaining_requests'),
      remainingTokens: stringMetadata(metadata, 'remaining_tokens')
    };
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new AppError({
        code: 'GROQ_TIMEOUT',
        httpStatus: 504,
        safeMessage: 'Groq request timed out',
        cause,
        metadata: { model }
      });
    }
    throw new AppError({
      code: 'GROQ_UPSTREAM_ERROR',
      httpStatus: 502,
      safeMessage: 'Groq network request failed',
      cause,
      metadata: { model }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function requestedModel(config: AppConfig, context: GroqContext): string {
  return context.image ? config.GROQ_VISION_MODEL : config.GROQ_MODEL;
}

function parseDecision(completion: GroqCompletion): AIDecision {
  if (!completion.content || completion.finishReason === 'length') {
    throw new AppError({
      code: 'GROQ_INVALID_RESPONSE',
      httpStatus: 502,
      safeMessage: 'Groq response did not include complete structured output',
      metadata: { status: completion.status, finish_reason: completion.finishReason ?? null }
    });
  }
  try {
    return aiDecisionSchema.parse(JSON.parse(completion.content));
  } catch (cause) {
    throw new AppError({
      code: 'GROQ_INVALID_RESPONSE',
      httpStatus: 502,
      safeMessage: 'Groq response failed AIDecision validation',
      cause,
      metadata: { status: completion.status, finish_reason: completion.finishReason ?? null }
    });
  }
}

function parseContext(context: unknown): GroqContext {
  if (
    context &&
    typeof context === 'object' &&
    typeof (context as GroqContext).message === 'string' &&
    typeof (context as GroqContext).requestId === 'string'
  ) {
    return context as GroqContext;
  }
  throw new AppError({
    code: 'VALIDATION_ERROR',
    httpStatus: 400,
    safeMessage: 'AI provider context is invalid'
  });
}

function buildSystemPrompt(): string {
  return [
    prompts.system,
    prompts.safety,
    prompts.memory,
    prompts.company,
    prompts.sales,
    prompts.qualification,
    prompts.handoff
  ].join('\n\n');
}

function buildConversationInput(context: GroqContext): string {
  const memory = context.memory
    ? `Long-term memory: ${JSON.stringify({
        summary: context.memory.summary,
        facts: safeArray(context.memory.facts_json),
        open_loops: safeArray(context.memory.open_loops_json),
        current_intent: context.memory.current_intent
      })}`
    : 'Long-term memory: none';
  const recent = context.recent?.length
    ? `Recent conversation: ${context.recent.map((item) => `${item.direction}: ${item.content ?? ''}`).join('\n')}`
    : 'Recent conversation: none';
  return [
    `CURRENT USER MESSAGE (respond to this first): ${context.message}`,
    'The context below may help answer the current message, but must not change its topic.',
    memory,
    recent
  ].join('\n');
}

function safeArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function readGroqErrorMetadata(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = (await response.clone().json()) as unknown;
    if (!payload || typeof payload !== 'object') return {};
    const error = (payload as Record<string, unknown>).error;
    if (!error || typeof error !== 'object') return {};
    const record = error as Record<string, unknown>;
    return {
      groq_error_type: safeDiagnosticValue(record.type),
      groq_error_code: safeDiagnosticValue(record.code)
    };
  } catch {
    return {};
  }
}

function safeDiagnosticValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  return /^[a-zA-Z0-9_.:-]{1,100}$/.test(normalized) ? normalized : undefined;
}

function maskProviderRequestId(value: string | null): string | undefined {
  if (!value) return undefined;
  return value.length <= 8 ? '[MASKED]' : `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberMetadata(
  metadata: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}
