import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { prompts } from '../../generated/prompts';
import { aiDecisionJsonSchema, aiDecisionSchema, type AIDecision } from '../../schemas/ai.schemas';
import type { AIProvider } from '../openai/provider';
import { OpenRouterClient, type OpenRouterChatCompletionResult } from './client';

export interface OpenRouterProviderContext {
  message: string;
  requestId: string;
  memory?: {
    summary: string | null;
    facts_json: string | null;
    open_loops_json: string | null;
    current_intent: string | null;
  };
  recent?: Array<{ direction: string; content: string | null }>;
}

export class OpenRouterProvider implements AIProvider {
  private readonly client: OpenRouterClient;

  constructor(
    private readonly config: AppConfig,
    client = new OpenRouterClient()
  ) {
    this.client = client;
  }

  async generateReply(context: unknown): Promise<AIDecision> {
    const parsedContext = parseContext(context);
    if (!this.config.OPENROUTER_API_KEY) {
      throw new AppError({
        code: 'OPENROUTER_NOT_CONFIGURED',
        httpStatus: 503,
        safeMessage: 'OpenRouter API key is not configured'
      });
    }

    const logger = createLogger(
      {
        LOG_LEVEL: this.config.LOG_LEVEL,
        LOG_MESSAGE_CONTENT: String(this.config.LOG_MESSAGE_CONTENT)
      },
      parsedContext.requestId
    );
    const startedAt = Date.now();

    logger.info('ai.request.started', {
      provider: 'openrouter',
      model: this.config.OPENROUTER_MODEL
    });

    try {
      const message = buildConversationInput(parsedContext);
      const { completion, decision } = await this.createDecision(message, logger);
      Object.assign(decision, { resolved_model: completion.model });

      logger.info('ai.request.completed', {
        provider: 'openrouter',
        requested_model: this.config.OPENROUTER_MODEL,
        resolved_model: completion.model,
        status: completion.status,
        duration_ms: Date.now() - startedAt
      });

      return decision;
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError({
              code: 'AI_INVALID_RESPONSE',
              httpStatus: 502,
              safeMessage: 'AI response failed validation',
              cause: error
            });
      logger.error('ai.request.failed', {
        provider: 'openrouter',
        requested_model: this.config.OPENROUTER_MODEL,
        error_code: appError.code,
        duration_ms: Date.now() - startedAt
      });
      throw appError;
    }
  }

  private async createDecision(
    message: string,
    logger: ReturnType<typeof createLogger>
  ): Promise<{ completion: OpenRouterChatCompletionResult; decision: AIDecision }> {
    try {
      return await this.createAndParse(message, 'structured', logger);
    } catch (error) {
      if (!shouldUseCompatibleFallback(error)) throw error;
      logger.warn('ai.response.fallback', {
        provider: 'openrouter',
        requested_model: this.config.OPENROUTER_MODEL,
        reason: fallbackReason(error)
      });
      return this.createAndParse(message, 'compatible', logger);
    }
  }

  private async createAndParse(
    message: string,
    strategy: 'structured' | 'compatible',
    logger: ReturnType<typeof createLogger>
  ): Promise<{ completion: OpenRouterChatCompletionResult; decision: AIDecision }> {
    const completion = await this.createCompletion(message, strategy);
    this.logResponseShape(logger, completion, strategy);
    return { completion, decision: this.parseAIDecision(completion) };
  }

  private async createCompletion(message: string, strategy: 'structured' | 'compatible') {
    const baseInput = {
      apiKey: this.config.OPENROUTER_API_KEY as string,
      baseUrl: this.config.OPENROUTER_BASE_URL,
      model: this.config.OPENROUTER_MODEL,
      maxTokens: this.config.OPENAI_MAX_OUTPUT_TOKENS,
      temperature: this.config.AI_TEMPERATURE,
      timeoutMs: this.config.AI_REQUEST_TIMEOUT_MS,
      messages: [
        { role: 'system' as const, content: buildSystemPrompt() },
        { role: 'user' as const, content: buildUserPrompt(message) }
      ]
    };

    return this.client.createChatCompletion({
      ...baseInput,
      responseFormat:
        strategy === 'structured'
          ? {
              type: 'json_schema',
              json_schema: {
                name: 'aty_ai_decision',
                strict: true,
                schema: aiDecisionJsonSchema
              }
            }
          : { type: 'json_object' },
      ...(strategy === 'structured'
        ? {
            provider: { require_parameters: true },
            plugins: [{ id: 'response-healing' }]
          }
        : {})
    });
  }

  private parseAIDecision(completion: OpenRouterChatCompletionResult): AIDecision {
    if (completion.refusalPresent) {
      throw responseFailure(completion, 'refusal', 'OpenRouter declined the request');
    }
    if (completion.finishReason === 'length') {
      throw responseFailure(completion, 'truncated_response', 'OpenRouter response was truncated');
    }
    if (!completion.content) {
      throw responseFailure(
        completion,
        'missing_content',
        'OpenRouter response did not include message content'
      );
    }

    const parseResult = parseJsonFromModelContent(completion.content);
    if (!parseResult.ok) {
      throw responseFailure(completion, 'invalid_json', 'OpenRouter response was not valid JSON');
    }

    const validated = aiDecisionSchema.safeParse(parseResult.value);
    if (!validated.success) {
      throw responseFailure(
        completion,
        'schema_validation_failed',
        'OpenRouter response failed AIDecision validation'
      );
    }

    return validated.data;
  }

  private logResponseShape(
    logger: ReturnType<typeof createLogger>,
    completion: OpenRouterChatCompletionResult,
    strategy: 'structured' | 'compatible'
  ) {
    logger.info('ai.response.shape', {
      provider: 'openrouter',
      requested_model: this.config.OPENROUTER_MODEL,
      resolved_model: completion.model,
      strategy,
      status: completion.status,
      finish_reason: completion.finishReason ?? null,
      content_present: Boolean(completion.content),
      content_type: completion.contentType,
      choices_length: completion.choicesLength,
      refusal_present: completion.refusalPresent,
      reasoning_present: completion.reasoningPresent,
      tool_calls_present: completion.toolCallsPresent,
      fallback_attempt: strategy === 'compatible' ? 1 : 0,
      usage_prompt_tokens: completion.usagePromptTokens ?? null,
      usage_completion_tokens: completion.usageCompletionTokens ?? null,
      usage_total_tokens: completion.usageTotalTokens ?? null
    });
  }
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

function parseContext(context: unknown): OpenRouterProviderContext {
  if (
    context &&
    typeof context === 'object' &&
    typeof (context as OpenRouterProviderContext).message === 'string' &&
    typeof (context as OpenRouterProviderContext).requestId === 'string'
  ) {
    return context as OpenRouterProviderContext;
  }

  throw new AppError({
    code: 'VALIDATION_ERROR',
    httpStatus: 400,
    safeMessage: 'AI provider context is invalid'
  });
}

function buildUserPrompt(message: string): string {
  return [
    'Return only the AIDecision JSON object required by the response format.',
    'Do not add markdown, prose, reasoning, or text before or after the JSON.',
    'Keep reply short, natural, direct, and normally one to three sentences or about 300 characters.',
    'Include every required field. Use null for unknown nullable fields.',
    'Keep lead_patch and memory_patch complete with all required fields.',
    `User message: ${message}`
  ].join('\n');
}

function buildConversationInput(context: OpenRouterProviderContext): string {
  const memory = context.memory
    ? `Long-term memory: ${JSON.stringify({ summary: context.memory.summary, facts: safeArray(context.memory.facts_json), open_loops: safeArray(context.memory.open_loops_json), current_intent: context.memory.current_intent })}`
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

function parseJsonFromModelContent(
  content: string
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  const candidates = [content, stripMarkdownJsonFence(content), removeTrailingJsonCommas(content)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Try the next syntactic repair candidate.
    }
  }

  try {
    return {
      ok: true,
      value: JSON.parse(removeTrailingJsonCommas(stripMarkdownJsonFence(content)))
    };
  } catch (error) {
    return { ok: false, error };
  }
}

function stripMarkdownJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function removeTrailingJsonCommas(content: string): string {
  return content.replace(/,\s*([}\]])/g, '$1');
}

function responseFailure(
  completion: OpenRouterChatCompletionResult,
  reason:
    | 'missing_content'
    | 'invalid_json'
    | 'schema_validation_failed'
    | 'truncated_response'
    | 'refusal',
  safeMessage: string
): AppError {
  return new AppError({
    code: 'OPENROUTER_INVALID_RESPONSE',
    httpStatus: 502,
    safeMessage,
    metadata: {
      status: completion.status,
      reason,
      resolved_model: completion.model,
      finish_reason: completion.finishReason ?? null,
      content_type: completion.contentType
    }
  });
}

function shouldUseCompatibleFallback(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'OPENROUTER_INVALID_RESPONSE') return false;
  if (error.metadata?.reason === 'refusal') return false;
  if (typeof error.metadata?.reason === 'string') return true;
  return error.metadata?.status === 400 || error.metadata?.status === 404;
}

function fallbackReason(error: unknown): string {
  return error instanceof AppError && typeof error.metadata?.reason === 'string'
    ? error.metadata.reason
    : 'structured_output_unsupported';
}
