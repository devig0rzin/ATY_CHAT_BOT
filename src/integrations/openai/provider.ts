import { AppError } from '../../lib/errors';
import { aiDecisionJsonSchema, aiDecisionSchema, type AIDecision } from './schemas';
import type { AppConfig } from '../../config/env';

export interface AIProvider {
  generateReply(context: unknown): Promise<AIDecision>;
}

export class MockAIProvider implements AIProvider {
  async generateReply(context: unknown): Promise<AIDecision> {
    void context;
    return aiDecisionSchema.parse({
      should_reply: false,
      reply: '',
      intent: 'capture_mode',
      confidence: 1,
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
    });
  }
}

export class OpenAIProvider implements AIProvider {
  constructor(private readonly config: AppConfig) {}

  async generateReply(context: unknown): Promise<AIDecision> {
    if (!this.config.OPENAI_API_KEY) {
      throw new AppError({
        code: 'OPENAI_NOT_CONFIGURED',
        httpStatus: 503,
        safeMessage: 'OpenAI API key is not configured'
      });
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.OPENAI_MODEL || 'gpt-5-nano',
        max_output_tokens: this.config.OPENAI_MAX_OUTPUT_TOKENS,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify(context)
              }
            ]
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'aty_ai_decision',
            strict: true,
            schema: aiDecisionJsonSchema
          }
        }
      })
    });

    if (!response.ok) {
      throw new AppError({
        code: 'OPENAI_REQUEST_FAILED',
        httpStatus: 502,
        safeMessage: 'OpenAI request failed',
        metadata: { status: response.status }
      });
    }

    const payload = (await response.json()) as { output_text?: string };
    if (!payload.output_text) {
      throw new AppError({
        code: 'OPENAI_INVALID_RESPONSE',
        httpStatus: 502,
        safeMessage: 'OpenAI response did not include structured output'
      });
    }

    try {
      return aiDecisionSchema.parse(JSON.parse(payload.output_text));
    } catch (cause) {
      throw new AppError({
        code: 'OPENAI_INVALID_RESPONSE',
        httpStatus: 502,
        safeMessage: 'OpenAI response failed schema validation',
        cause
      });
    }
  }
}
