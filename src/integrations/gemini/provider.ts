import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { aiDecisionJsonSchema, aiDecisionSchema, type AIDecision } from '../openai/schemas';
import type { AIProvider } from '../openai/provider';

export interface GeminiClient {
  generate(input: {
    apiKey: string;
    model: string;
    prompt: string;
    timeoutMs: number;
    maxOutputTokens: number;
  }): Promise<GeminiResult>;
}

export interface GeminiResult {
  status: number;
  model: string;
  text?: string;
  finishReason?: string;
  retryAfter?: string;
}

export class GeminiProvider implements AIProvider {
  constructor(
    private readonly config: AppConfig,
    private readonly client: GeminiClient = new HttpGeminiClient()
  ) {}

  async generateReply(context: unknown): Promise<AIDecision> {
    if (!this.config.GEMINI_API_KEY) {
      throw new AppError({
        code: 'GEMINI_NOT_CONFIGURED',
        httpStatus: 503,
        safeMessage: 'Gemini API key is not configured'
      });
    }
    const requestId =
      context &&
      typeof context === 'object' &&
      typeof (context as { requestId?: unknown }).requestId === 'string'
        ? (context as { requestId: string }).requestId
        : crypto.randomUUID();
    const logger = createLogger(this.config, requestId);
    const startedAt = Date.now();
    logger.info('ai.request.started', { provider: 'gemini', model: this.config.GEMINI_MODEL });
    try {
      const result = await this.client.generate({
        apiKey: this.config.GEMINI_API_KEY,
        model: this.config.GEMINI_MODEL,
        prompt: buildPrompt(context),
        timeoutMs: this.config.AI_REQUEST_TIMEOUT_MS,
        maxOutputTokens: 1600
      });
      if (!result.text) {
        throw new AppError({
          code: 'GEMINI_INVALID_RESPONSE',
          httpStatus: 502,
          safeMessage: 'Gemini response was invalid',
          metadata: {
            status: result.status,
            model: result.model,
            finish_reason: result.finishReason
          }
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripFence(result.text));
      } catch (cause) {
        throw new AppError({
          code: 'GEMINI_INVALID_RESPONSE',
          httpStatus: 502,
          safeMessage: 'Gemini response was not valid JSON',
          cause,
          metadata: { status: result.status, model: result.model }
        });
      }
      const decision = aiDecisionSchema.safeParse(parsed);
      if (!decision.success)
        throw new AppError({
          code: 'GEMINI_INVALID_RESPONSE',
          httpStatus: 502,
          safeMessage: 'Gemini response failed schema validation',
          metadata: { status: result.status, model: result.model }
        });
      Object.assign(decision.data, { resolved_model: result.model });
      logger.info('ai.request.completed', {
        provider: 'gemini',
        model: result.model,
        status: result.status,
        duration_ms: Date.now() - startedAt
      });
      return decision.data;
    } catch (cause) {
      const error =
        cause instanceof AppError
          ? cause
          : new AppError({
              code: 'GEMINI_INVALID_RESPONSE',
              httpStatus: 502,
              safeMessage: 'Gemini request failed',
              cause
            });
      logger.error('ai.request.failed', {
        provider: 'gemini',
        model: this.config.GEMINI_MODEL,
        error_code: error.code,
        duration_ms: Date.now() - startedAt
      });
      throw error;
    }
  }
}

class HttpGeminiClient implements GeminiClient {
  async generate(input: {
    apiKey: string;
    model: string;
    prompt: string;
    timeoutMs: number;
    maxOutputTokens: number;
  }): Promise<GeminiResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: input.prompt }] }],
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: input.maxOutputTokens,
              responseMimeType: 'application/json'
            }
          })
        }
      );
      const retryAfter = response.headers.get('retry-after') ?? undefined;
      if (response.status === 429)
        throw new AppError({
          code: 'GEMINI_RATE_LIMIT',
          httpStatus: 429,
          safeMessage: 'Gemini rate limit reached',
          metadata: { status: 429, retry_after: retryAfter }
        });
      if (response.status >= 500)
        throw new AppError({
          code: 'GEMINI_UPSTREAM_ERROR',
          httpStatus: 502,
          safeMessage: 'Gemini upstream error',
          metadata: { status: response.status }
        });
      if (!response.ok)
        throw new AppError({
          code: 'GEMINI_INVALID_RESPONSE',
          httpStatus: 502,
          safeMessage: 'Gemini request failed',
          metadata: { status: response.status }
        });
      const payload = (await response.json()) as any;
      const candidate = payload?.candidates?.[0];
      return {
        status: response.status,
        model: input.model,
        text: candidate?.content?.parts
          ?.map((part: any) => part?.text)
          .filter(Boolean)
          .join('\n'),
        finishReason: candidate?.finishReason,
        retryAfter
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (cause instanceof Error && cause.name === 'AbortError')
        throw new AppError({
          code: 'GEMINI_TIMEOUT',
          httpStatus: 504,
          safeMessage: 'Gemini request timed out',
          cause
        });
      throw new AppError({
        code: 'GEMINI_UPSTREAM_ERROR',
        httpStatus: 502,
        safeMessage: 'Gemini network request failed',
        cause
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildPrompt(context: unknown): string {
  return [
    'Return only the JSON object matching this schema:',
    JSON.stringify(aiDecisionJsonSchema),
    'Respond in Brazilian Portuguese.',
    `Context: ${JSON.stringify(context)}`
  ].join('\n');
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}
