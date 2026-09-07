import { describe, expect, it } from 'vitest';
import realMessage from './fixtures/uazapi.real-message.json';
import {
  getUazapiAutoreplySkipReason,
  normalizeUazapiEvent
} from '../src/integrations/uazapi/normalizer';

type Payload = Record<string, any>;

describe('UAZAPI real inbound normalizer', () => {
  it('normalizes a valid inbound text message', () => {
    expect(normalizeUazapiEvent(realMessage)).toMatchObject({
      provider: 'uazapi',
      event: 'messages',
      messageId: '3EB069931B25E773D0B3BC',
      phone: '5511999999999',
      senderName: 'Contato Teste',
      text: 'oi',
      fromMe: false,
      wasSentByApi: false,
      isGroup: false,
      messageType: 'text',
      timestamp: 1788795063000,
      instanceName: 'TEST_INSTANCE',
      owner: '5511000000000'
    });
  });

  it('prefers message.text', () => {
    expect(normalizeUazapiEvent(realMessage)?.text).toBe('oi');
  });

  it('falls back to message.content', () => {
    const payload = clone(realMessage);
    delete payload.message.text;
    expect(normalizeUazapiEvent(payload)?.text).toBe('oi');
  });

  it('uses sender_pn as the preferred phone', () => {
    expect(normalizeUazapiEvent(realMessage)?.phone).toBe('5511999999999');
  });

  it('removes the @s.whatsapp.net suffix', () => {
    const payload = clone(realMessage);
    payload.message.sender_pn = '5511888888888@s.whatsapp.net';
    expect(normalizeUazapiEvent(payload)?.phone).toBe('5511888888888');
  });

  it('falls back to message.chatid for the phone', () => {
    const payload = clone(realMessage);
    delete payload.message.sender_pn;
    expect(normalizeUazapiEvent(payload)?.phone).toBe('5511999999999');
  });

  it('prefers message.messageid and falls back to message.id', () => {
    expect(normalizeUazapiEvent(realMessage)?.messageId).toBe('3EB069931B25E773D0B3BC');
    const payload = clone(realMessage);
    delete payload.message.messageid;
    expect(normalizeUazapiEvent(payload)?.messageId).toBe('5511000000000:3EB069931B25E773D0B3BC');
  });

  it('resolves senderName with chat fallbacks', () => {
    const payload = clone(realMessage);
    delete payload.message.senderName;
    expect(normalizeUazapiEvent(payload)?.senderName).toBe('Contato Teste');
    delete payload.chat.wa_contactName;
    payload.chat.name = 'Nome do Chat';
    expect(normalizeUazapiEvent(payload)?.senderName).toBe('Nome do Chat');
  });

  it('skips messages sent by this instance', () => {
    const payload = clone(realMessage);
    payload.message.fromMe = true;
    expect(normalizeUazapiEvent(payload)).toBeUndefined();
    expect(getUazapiAutoreplySkipReason(payload)).toBe('from_me');
  });

  it('skips messages sent by the API', () => {
    const payload = clone(realMessage);
    payload.message.wasSentByApi = true;
    expect(normalizeUazapiEvent(payload)).toBeUndefined();
    expect(getUazapiAutoreplySkipReason(payload)).toBe('sent_by_api');
  });

  it('skips group messages', () => {
    const payload = clone(realMessage);
    payload.message.isGroup = true;
    expect(normalizeUazapiEvent(payload)).toBeUndefined();
    expect(getUazapiAutoreplySkipReason(payload)).toBe('group_message');
  });

  it('skips events other than messages', () => {
    const payload = clone(realMessage);
    payload.EventType = 'messages_update';
    expect(normalizeUazapiEvent(payload)).toBeUndefined();
    expect(getUazapiAutoreplySkipReason(payload)).toBe('event_not_messages');
  });

  it('skips empty or unsupported text', () => {
    const payload = clone(realMessage);
    payload.message.text = '  ';
    payload.message.content = '';
    expect(normalizeUazapiEvent(payload)).toBeUndefined();
    expect(getUazapiAutoreplySkipReason(payload)).toBe('unsupported_or_empty_message');
  });

  it('uses chat.wa_chatid when sender_pn and chatid are absent', () => {
    const payload = clone(realMessage);
    delete payload.message.sender_pn;
    delete payload.message.chatid;
    expect(normalizeUazapiEvent(payload)?.phone).toBe('5511999999999');
  });

  it('does not use a WhatsApp LID as the phone', () => {
    const payload = clone(realMessage);
    payload.message.sender_pn = '123456789@lid';
    delete payload.message.chatid;
    payload.chat.wa_chatid = '123456789@lid';
    expect(normalizeUazapiEvent(payload)).toBeUndefined();
    expect(getUazapiAutoreplySkipReason(payload)).toBe('message_not_normalized');
  });

  it('does not crash on invalid payloads', () => {
    expect(normalizeUazapiEvent(null)).toBeUndefined();
    expect(normalizeUazapiEvent('invalid')).toBeUndefined();
    expect(normalizeUazapiEvent({ EventType: 'messages' })).toBeUndefined();
  });
});

function clone(payload: unknown): Payload {
  return structuredClone(payload) as Payload;
}
