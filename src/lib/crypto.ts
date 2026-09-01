export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
  const left = await sha256Hex(a);
  const right = await sha256Hex(b);
  return left === right && a.length === b.length;
}
