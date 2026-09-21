import { describe, expect, it } from 'vitest';
import { aiDecisionSchema } from '../src/schemas/ai.schemas';

describe('Sales qualification contract', () => {
  it('mantém o contrato antigo e inicializa campos comerciais novos', () => {
    const decision = aiDecisionSchema.parse({
      should_reply: true,
      reply: 'Entendi. Qual é o maior gargalo hoje?',
      intent: 'lead_qualification',
      confidence: 0.9,
      handoff_requested: false,
      handoff_reason: null,
      lead_patch: {
        name: 'Lucas',
        company: 'Clínica',
        segment: 'saúde',
        service_interest: null,
        budget_status: null,
        urgency: null
      },
      memory_patch: { summary: null, facts_to_add: [], open_loops: [] }
    });
    expect(decision.lead_patch.email).toBeNull();
    expect(decision.lead_patch.main_pain).toBeNull();
    expect(decision.lead_patch.meeting_interest).toBeNull();
  });

  it('aceita qualificação progressiva sem confirmar reunião inexistente', () => {
    const decision = aiDecisionSchema.parse({
      should_reply: true,
      reply: 'Entendi o gargalo. Qual é o melhor e-mail para contato?',
      intent: 'lead_qualification',
      confidence: 0.96,
      handoff_requested: false,
      handoff_reason: null,
      lead_patch: {
        name: 'Lucas Ferreira',
        company: 'Clínica Odontológica',
        segment: 'saúde',
        service_interest: 'automação de atendimento',
        budget_status: null,
        urgency: 'média',
        email: 'lucas@example.com',
        role: 'sócio',
        current_process: 'atendimento manual no WhatsApp',
        main_pain: 'demora para responder',
        desired_outcome: 'responder mais rápido',
        volume: '80 conversas por dia',
        meeting_interest: true,
        preferred_meeting_date: 'sexta-feira',
        preferred_meeting_time: '15:00'
      },
      memory_patch: {
        summary: 'Lead de clínica com demora no atendimento',
        facts_to_add: ['Lucas é sócio de uma clínica odontológica'],
        open_loops: ['Confirmar reunião com Igor']
      }
    });
    expect(decision.lead_patch.main_pain).toContain('demora');
    expect(decision.handoff_requested).toBe(false);
    expect(decision.reply).not.toMatch(/reunião marcada|confirmada/i);
  });
});
