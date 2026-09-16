export interface WhatsAppReplyChunkingOptions {
  softLimit: number;
  maxChunks: number;
}

export function splitWhatsAppReply(
  reply: string,
  { softLimit, maxChunks }: WhatsAppReplyChunkingOptions
): string[] {
  const text = reply.trim();
  if (!text || text.length <= softLimit || maxChunks <= 1) return text ? [text] : [];

  const boundary = findNaturalBoundary(text, softLimit);
  if (!boundary) return [text];

  const first = text.slice(0, boundary).trimEnd();
  const remainder = text.slice(boundary).trimStart();
  return first && remainder ? [first, remainder] : [text];
}

function findNaturalBoundary(text: string, softLimit: number): number | undefined {
  const beforeLimit = text.slice(0, softLimit + 1);
  const paragraph = beforeLimit.lastIndexOf('\n\n');
  if (paragraph > 0) return paragraph;

  const sentence = lastSentenceBoundary(beforeLimit);
  if (sentence) return sentence;

  const whitespace = lastWhitespaceBoundary(beforeLimit);
  if (whitespace) return whitespace;

  const afterLimit = text.slice(softLimit);
  const forward = firstWhitespaceBoundary(afterLimit);
  return forward ? softLimit + forward : undefined;
}

function lastSentenceBoundary(text: string): number | undefined {
  const matches = [...text.matchAll(/[.!?](?=\s|$)/g)];
  const match = matches.at(-1);
  return match?.index === undefined ? undefined : match.index + 1;
}

function lastWhitespaceBoundary(text: string): number | undefined {
  for (let index = text.length - 1; index > 0; index -= 1) {
    if (/\s/.test(text[index])) return index;
  }
  return undefined;
}

function firstWhitespaceBoundary(text: string): number | undefined {
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) return index;
  }
  return undefined;
}
