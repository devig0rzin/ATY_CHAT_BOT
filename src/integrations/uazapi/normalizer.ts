import type { NormalizedUazapiInboundMessage } from './types';

export type UazapiAutoreplySkipReason =
  | 'event_not_messages'
  | 'from_me'
  | 'sent_by_api'
  | 'group_message'
  | 'unsupported_or_empty_message'
  | 'message_not_normalized';

export function normalizeUazapiEvent(payload: unknown): NormalizedUazapiInboundMessage | undefined {
  if (!isRecord(payload) || payload.EventType !== 'messages') return undefined;

  const message = asRecord(payload.message);
  const chat = asRecord(payload.chat);
  if (!message) return undefined;

  const fromMe = findBoolean(message, ['fromMe']) ?? false;
  const wasSentByApi = findBoolean(message, ['wasSentByApi']) ?? false;
  const isGroup = findBoolean(message, ['isGroup']) ?? findBoolean(chat, ['wa_isGroup']) ?? false;
  if (fromMe || wasSentByApi || isGroup) return undefined;

  const text = firstNonEmptyString([message.text, message.content]);
  const phone = normalizePhone(
    firstNonEmptyString([message.sender_pn, message.chatid, chat?.wa_chatid])
  );
  if (!text || !phone) return undefined;

  const messageId = firstNonEmptyString([message.messageid, message.id]);
  return {
    provider: 'uazapi',
    event: 'messages',
    messageId,
    phone,
    senderName: firstNonEmptyString([message.senderName, chat?.wa_contactName, chat?.name]),
    text,
    fromMe,
    wasSentByApi,
    isGroup,
    messageType: firstNonEmptyString([message.type, message.messageType]),
    timestamp: typeof message.messageTimestamp === 'number' ? message.messageTimestamp : undefined,
    instanceName: stringValue(payload.instanceName),
    owner: stringValue(payload.owner)
  };
}

export function getUazapiAutoreplySkipReason(
  payload: unknown
): UazapiAutoreplySkipReason | undefined {
  if (!isRecord(payload) || payload.EventType !== 'messages') return 'event_not_messages';

  const message = asRecord(payload.message);
  const chat = asRecord(payload.chat);
  if (!message) return 'message_not_normalized';
  if (message.fromMe === true) return 'from_me';
  if (message.wasSentByApi === true) return 'sent_by_api';
  if (message.isGroup === true || chat?.wa_isGroup === true) return 'group_message';
  if (!firstNonEmptyString([message.text, message.content])) {
    return 'unsupported_or_empty_message';
  }
  if (!normalizePhone(firstNonEmptyString([message.sender_pn, message.chatid, chat?.wa_chatid]))) {
    return 'message_not_normalized';
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function findBoolean(value: Record<string, unknown> | undefined, keys: string[]) {
  if (!value) return undefined;
  for (const key of keys) {
    if (typeof value[key] === 'boolean') return value[key];
  }
  return undefined;
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePhone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/@lid$/i.test(value.trim())) return undefined;
  const withoutJid = value.trim().replace(/@s\.whatsapp\.net$/i, '');
  const digits = withoutJid.replace(/\D/g, '');
  return digits || undefined;
}
