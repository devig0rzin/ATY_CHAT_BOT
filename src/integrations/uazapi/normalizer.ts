import type { NormalizedUazapiInboundMessage } from './types';

export function normalizeUazapiEvent(payload: unknown): NormalizedUazapiInboundMessage | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  const fromMe = findBoolean(payload, ['fromMe', 'from_me', 'from_me_bool', 'isFromMe']) ?? false;
  if (fromMe) return undefined;

  const text = firstNonEmptyString([
    findString(payload, ['message.text']),
    findString(payload, ['message.conversation']),
    findString(payload, ['message.body']),
    findString(payload, ['text']),
    findString(payload, ['body']),
    findString(payload, ['content']),
    findString(payload, ['message.extendedTextMessage.text']),
    findString(payload, ['data.message.text']),
    findString(payload, ['data.text']),
    findString(payload, ['data.body'])
  ]);

  const number = normalizePhone(
    firstNonEmptyString([
      findString(payload, ['sender.phone']),
      findString(payload, ['sender']),
      findString(payload, ['from']),
      findString(payload, ['phone']),
      findString(payload, ['number']),
      findString(payload, ['jid']),
      findString(payload, ['remoteJid']),
      findString(payload, ['key.remoteJid']),
      findString(payload, ['message.from']),
      findString(payload, ['data.from']),
      findString(payload, ['data.sender']),
      findString(payload, ['data.key.remoteJid'])
    ])
  );

  if (!text || !number) return undefined;

  return {
    providerMessageId: firstNonEmptyString([
      findString(payload, ['message.id']),
      findString(payload, ['messageId']),
      findString(payload, ['message_id']),
      findString(payload, ['id']),
      findString(payload, ['key.id']),
      findString(payload, ['data.key.id'])
    ]),
    number,
    text,
    fromMe
  };
}

function findString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const found = getPath(value, path);
    if (typeof found === 'string' && found.trim()) return found.trim();
  }
  return undefined;
}

function findBoolean(value: unknown, paths: string[]): boolean | undefined {
  for (const path of paths) {
    const found = getPath(value, path);
    if (typeof found === 'boolean') return found;
  }
  return undefined;
}

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function firstNonEmptyString(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== '');
}

function normalizePhone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutJid = value.split('@')[0];
  const digits = withoutJid.replace(/\D/g, '');
  return digits || undefined;
}
