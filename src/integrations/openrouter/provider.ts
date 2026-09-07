import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { prompts } from '../../generated/prompts';
import { z } from 'zod';
import { aiDecisionJsonSchema, aiDecisionSchema, type AIDecision } from '../../schemas/ai.schemas';
import type { AIProvider } from '../openai/provider';
import { OpenRouterClient } from './client';

export interface OpenRouterProviderContext {
  message: string;
  requestId: string;
}

interface CompletionForParsing {
  status: number;
  model: string;
  content: string;
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
      const decision = this.parseAIDecision(completion, logger);
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
        },
        provider: {
          require_parameters: true
        },
        plugins: [
          {
            id: 'response-healing'
          }
        ]
      });
    } catch (error) {
      if (!isStructuredOutputUnsupported(error)) {
        throw error;
      }

      return this.client.createChatCompletion({
        ...baseInput,
        responseFormat: {
          type: 'json_object'
        }
      });
    }
  }

  private parseAIDecision(
    completion: CompletionForParsing,
    logger: ReturnType<typeof createLogger>
  ) {
    const parseResult = parseJsonFromModelContent(completion.content);
    if (!parseResult.ok) {
      this.logInvalidResponse(logger, completion, {
        json_parse_status: 'failed',
        zod_errors: [],
        parse_error: parseResult.error
      });
      throw invalidResponse(parseResult.error);
    }

    const validated = aiDecisionSchema.safeParse(parseResult.value);
    if (!validated.success) {
      this.logInvalidResponse(logger, completion, {
        json_parse_status: 'ok',
        parsed: parseResult.value,
        zod_errors: summarizeZodErrors(validated.error)
      });
      throw invalidResponse(validated.error);
    }

    return validated.data;
  }

  private logInvalidResponse(
    logger: ReturnType<typeof createLogger>,
    completion: CompletionForParsing,
    diagnostics: Record<string, unknown>
  ) {
    if (this.config.APP_ENV !== 'local' || !this.config.AI_DEBUG_RESPONSE) return;

    logger.warn('ai.debug.invalid_response', {
      provider: 'openrouter',
      requested_model: this.config.OPENROUTER_MODEL,
      resolved_model: completion.model,
      raw_model_output: completion.content,
      ...diagnostics
    });
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
  return [
    'Return only one JSON object that matches the AIDecision contract.',
    'Do not wrap the JSON in markdown.',
    'Use null for unknown nullable fields and include every required field.',
    'Keep reply concise, preferably under 320 characters.',
    'Start from this exact key skeleton and replace only the values:',
    JSON.stringify({
      should_reply: true,
      reply: '',
      intent: '',
      confidence: 0.9,
      handoff_requested: false,
      handoff_reason: null,
      lead_patch: {
        name: null,
        company: null,
        segment: null,
        service_interest: null,
        budget_status: null,
        urgency: null
      },
      memory_patch: {
        summary: null,
        facts_to_add: [],
        open_loops: []
      }
    }),
    'Required JSON shape:',
    JSON.stringify(aiDecisionJsonSchema),
    `User message: ${message}`
  ].join('\n');
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

function summarizeZodErrors(error: z.ZodError): Array<{
  path: string;
  code: string;
  expected?: string;
  received?: string;
}> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    ...('expected' in issue ? { expected: String(issue.expected) } : {}),
    ...('received' in issue ? { received: String(issue.received) } : {})
  }));
}

function invalidResponse(cause: unknown): AppError {
  return new AppError({
    code: 'AI_INVALID_RESPONSE',
    httpStatus: 502,
    safeMessage: 'AI response failed schema validation',
    cause
  });
}

function isStructuredOutputUnsupported(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'OPENROUTER_INVALID_RESPONSE') return false;
  return (
    error.metadata?.status === 400 ||
    error.metadata?.status === 404 ||
    (error.metadata?.status === 200 && error.metadata?.finish_reason === 'length')
  );
}
