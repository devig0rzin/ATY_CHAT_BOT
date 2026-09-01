import { z } from 'zod';

export const apiSuccessSchema = z.object({
  ok: z.literal(true),
  request_id: z.string().uuid(),
  data: z.unknown()
});

export const apiErrorSchema = z.object({
  ok: z.literal(false),
  request_id: z.string().uuid(),
  error: z.object({
    code: z.string(),
    message: z.string()
  })
});
