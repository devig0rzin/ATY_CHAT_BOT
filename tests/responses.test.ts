import { describe, expect, it } from 'vitest';
import { apiErrorSchema, apiSuccessSchema } from '../src/schemas/api.schemas';
import { request } from './helpers';

describe('standard API responses', () => {
  it('validates success envelope', async () => {
    const body = await (await request('/health')).json();
    expect(apiSuccessSchema.safeParse(body).success).toBe(true);
  });

  it('validates error envelope', async () => {
    const body = await (await request('/missing')).json();
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });
});
