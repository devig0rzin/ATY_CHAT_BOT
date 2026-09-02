import { Hono } from 'hono';
import { z } from 'zod';
import { getConfig } from '../config/env';
import { AppError } from '../lib/errors';
import { successResponse } from '../lib/response';
import { createAIProvider } from '../integrations/openai/client';
import type { AppVariables } from '../types/api';
import type { Env } from '../types/env';

export const devRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const aiTestInputSchema = z.object({
  message: z.string().trim().min(1)
});

devRoutes.post('/ai-test', async (c) => {
  const config = getConfig(c.env);
  if (config.APP_ENV !== 'local' || !config.LOCAL_DEV_ROUTES_ENABLED) {
    return c.notFound();
  }

  let input: z.infer<typeof aiTestInputSchema>;
  try {
    input = aiTestInputSchema.parse(await c.req.json());
  } catch (cause) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      safeMessage: 'Invalid AI test request body',
      cause
    });
  }

  const provider = createAIProvider(c.env);
  const decision = await provider.generateReply({
    message: input.message,
    requestId: c.get('requestId')
  });

  return successResponse(c, {
    provider: config.AI_MODE,
    model: config.AI_MODE === 'openrouter' ? config.OPENROUTER_MODEL : 'mock',
    decision
  });
});
