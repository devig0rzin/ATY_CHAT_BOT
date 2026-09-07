import { z } from 'zod';

export const aiDecisionSchema = z.object({
  should_reply: z.boolean(),
  reply: z.string(),
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  handoff_requested: z.boolean(),
  handoff_reason: z.string().nullable(),
  lead_patch: z.object({
    name: z.string().nullable(),
    company: z.string().nullable(),
    segment: z.string().nullable(),
    service_interest: z.string().nullable(),
    budget_status: z.string().nullable(),
    urgency: z.string().nullable()
  }),
  memory_patch: z.object({
    summary: z.string().nullable(),
    facts_to_add: z.array(z.string()),
    open_loops: z.array(z.string())
  })
});

export type AIDecision = z.infer<typeof aiDecisionSchema>;

const nullableString = { type: ['string', 'null'] };

export const aiDecisionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'should_reply',
    'reply',
    'intent',
    'confidence',
    'handoff_requested',
    'handoff_reason',
    'lead_patch',
    'memory_patch'
  ],
  properties: {
    should_reply: { type: 'boolean' },
    reply: { type: 'string' },
    intent: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    handoff_requested: { type: 'boolean' },
    handoff_reason: nullableString,
    lead_patch: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'company', 'segment', 'service_interest', 'budget_status', 'urgency'],
      properties: {
        name: nullableString,
        company: nullableString,
        segment: nullableString,
        service_interest: nullableString,
        budget_status: nullableString,
        urgency: nullableString
      }
    },
    memory_patch: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'facts_to_add', 'open_loops'],
      properties: {
        summary: nullableString,
        facts_to_add: { type: 'array', items: { type: 'string' } },
        open_loops: { type: 'array', items: { type: 'string' } }
      }
    }
  }
} as const;
