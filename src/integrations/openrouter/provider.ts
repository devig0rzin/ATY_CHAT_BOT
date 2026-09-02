import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { prompts } from '../../generated/prompts';
import { aiDecisionJsonSchema, aiDecisionSchema, type AIDecision } from '../../schemas/ai.schemas';
import type { AIProvider } from '../openai/provider';
import { OpenRouterClient } from './client';

export interface OpenRouterProviderContext {
  message: string;
  requestId: string;
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
      const completion = await this.createCompatibleCompletion(parsedContext.message);
      const decision = parseAIDecision(completion.content);

      logger.info('ai.request.completed', {
        provider: 'openrouter',
        model: completion.model,
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
        model: this.config.OPENROUTER_MODEL,
        error_code: appError.code,
        duration_ms: Date.now() - startedAt
      });
      throw appError;
    }
  }

  private async createCompatibleCompletion(message: string) {
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

    try {
      return await this.client.createChatCompletion({
        ...baseInput,
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'aty_ai_decision',
            strict: true,
            schema: aiDecisionJsonSchema
          }
        }
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'OPENROUTER_INVALID_RESPONSE') {
        throw error;
      }

      return this.client.createChatCompletion(baseInput);
    }
  }
}

function buildSystemPrompt(): string {
  return [
    prompts.system,
    prompts.company,
    prompts.sales,
    prompts.qualification,
    prompts.memory,
    prompts.handoff,
    prompts.safety
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
  return `Return only a JSON object that matches the required schema. User message: ${message}`;
}

function parseAIDecision(content: string): AIDecision {
  try {
    return aiDecisionSchema.parse(JSON.parse(content));
  } catch (cause) {
    throw new AppError({
      code: 'AI_INVALID_RESPONSE',
      httpStatus: 502,
      safeMessage: 'AI response failed schema validation',
      cause
    });
  }
}
