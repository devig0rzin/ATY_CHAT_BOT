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
