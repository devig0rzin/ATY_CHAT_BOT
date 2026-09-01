export function normalizePhone(value: string): string {
  const normalized = value.replace(/[\s().-]/g, '').trim();
  if (!normalized) {
    throw new Error('Phone number is empty after normalization');
  }
  return normalized;
}

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
