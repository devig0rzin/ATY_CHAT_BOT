import { describe, expect, it } from 'vitest';
import { aiDecisionJsonSchema, aiDecisionSchema } from '../src/schemas/ai.schemas';

describe('Groq strict sales decision schema', () => {
  it('exige recursivamente todas as propriedades e bloqueia propriedades adicionais', () => {
    const auditedObjects: string[] = [];

    auditStrictSchema(aiDecisionJsonSchema, '$', auditedObjects);

    expect(auditedObjects).toEqual(['$', '$.lead_patch', '$.memory_patch']);
  });

  it('mantém JSON Schema strict e Zod alinhados com todos os campos comerciais', () => {
    const decision = {
      should_reply: true,
      reply: 'Entendi. Como vocês organizam esse atendimento hoje?',
      intent: 'lead_qualification',
      confidence: 0.95,
      handoff_requested: false,
      handoff_reason: null,
      lead_patch: {
        name: null,
        company: null,
        segment: 'clínica',
        service_interest: null,
        budget_status: null,
        urgency: null,
        email: null,
        role: null,
        current_process: null,
        main_pain: 'demora no atendimento',
        desired_outcome: null,
        volume: null,
        meeting_interest: null,
        preferred_meeting_date: null,
        preferred_meeting_time: null
      },
      memory_patch: {
        summary: null,
        facts_to_add: ['O negócio é uma clínica'],
        open_loops: ['Entender o processo atual de atendimento']
      }
    };

    expect(aiDecisionSchema.safeParse(decision).success).toBe(true);
    expect(Object.keys(decision.lead_patch).sort()).toEqual(
      [...aiDecisionJsonSchema.properties.lead_patch.required].sort()
    );
  });
});

function auditStrictSchema(schema: unknown, path: string, auditedObjects: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  const record = schema as Record<string, unknown>;
  const types = Array.isArray(record.type) ? record.type : [record.type];

  if (types.includes('object')) {
    const properties = asRecord(record.properties);
    const required = Array.isArray(record.required) ? record.required : [];
    auditedObjects.push(path);
    expect(record.additionalProperties, path).toBe(false);
    expect([...required].sort(), path).toEqual(Object.keys(properties).sort());
    for (const [key, child] of Object.entries(properties)) {
      auditStrictSchema(child, `${path}.${key}`, auditedObjects);
    }
  }

  if (types.includes('array')) auditStrictSchema(record.items, `${path}[]`, auditedObjects);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
