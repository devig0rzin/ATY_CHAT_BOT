import { describe, expect, it } from 'vitest';
import { splitWhatsAppReply } from '../src/lib/whatsapp-reply';

const options = { softLimit: 280, maxChunks: 2 };

describe('WhatsApp reply chunking', () => {
  it('keeps a short reply in one outbound message', () => {
    expect(splitWhatsAppReply('Seu nome e Lucas.', options)).toEqual(['Seu nome e Lucas.']);
  });

  it('splits a roughly 500-character reply into two natural chunks', () => {
    const reply = [
      'Para uma clinica odontologica, o bot pode atender pacientes no WhatsApp e responder duvidas frequentes.',
      'Ele tambem faz uma triagem inicial, entende o assunto e encaminha cada pessoa para a equipe certa.',
      'Quando necessario, ajuda com o agendamento e reduz bastante o trabalho manual da recepcao.',
      'Assim a equipe ganha tempo para cuidar dos atendimentos que realmente precisam de uma pessoa.'
    ].join(' ');

    const chunks = splitWhatsAppReply(reply, options);

    expect(reply.length).toBeGreaterThan(280);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/[.!?]$/);
    expect(chunks.join(' ')).toBe(reply);
  });

  it('never creates a third chunk or breaks a word for a very long reply', () => {
    const reply = `${'Automacao conversacional reduz trabalho manual. '.repeat(18)}Fim.`.trim();

    const chunks = splitWhatsAppReply(reply, options);

    expect(chunks).toHaveLength(2);
    expect(chunks.join(' ')).toBe(reply);
  });

  it('prefers a paragraph boundary when one is available near the soft limit', () => {
    const reply = `${'Primeiro paragrafo com contexto relevante. '.repeat(6)}\n\nSegundo paragrafo com a continuidade da resposta.`;

    const chunks = splitWhatsAppReply(reply, options);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('contexto relevante.');
    expect(chunks[1]).toBe('Segundo paragrafo com a continuidade da resposta.');
  });
});
