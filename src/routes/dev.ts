import { Hono } from 'hono';
import { z } from 'zod';
import { getConfig } from '../config/env';
import { AppError } from '../lib/errors';
import { successResponse } from '../lib/response';
import { createAIProvider } from '../integrations/openai/client';
import { createUazapiProvider } from '../integrations/uazapi/client';
import type { AppVariables } from '../types/api';
import type { Env } from '../types/env';

export const devRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const aiTestInputSchema = z.object({
  message: z.string().trim().min(1)
});

const uazapiSendTestInputSchema = z.object({
  number: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1)
});

const chatTestInputSchema = z.object({
  message: z.string().trim().min(1),
  number: z.string().trim().min(1).optional(),
  send_to_whatsapp: z.boolean().default(false)
});

devRoutes.post('/ai-test', async (c) => {
  const config = getConfig(c.env);
  if (!isLocalDevRouteEnabled(config)) {
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
    model:
      config.AI_MODE === 'openrouter' && 'resolved_model' in decision
        ? (decision as { resolved_model?: string }).resolved_model
        : config.AI_MODE === 'openrouter'
          ? config.OPENROUTER_MODEL
          : 'mock',
    decision
  });
});

devRoutes.post('/uazapi-send-test', async (c) => {
  const config = getConfig(c.env);
  if (!isLocalDevRouteEnabled(config)) {
    return c.notFound();
  }

  let input: z.infer<typeof uazapiSendTestInputSchema>;
  try {
    input = uazapiSendTestInputSchema.parse(await c.req.json());
  } catch (cause) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      safeMessage: 'Invalid UAZAPI send test request body',
      cause
    });
  }

  const number = input.number ?? config.TEST_WHATSAPP_NUMBER;
  if (!number) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      safeMessage: 'WhatsApp test number is required'
    });
  }

  const result = await createUazapiProvider(c.env, c.get('requestId')).sendText({
    number,
    text: input.text
  });

  return successResponse(c, {
    sent: true,
    result
  });
});

devRoutes.post('/chat-test', async (c) => {
  const config = getConfig(c.env);
  if (!isLocalDevRouteEnabled(config)) {
    return c.notFound();
  }

  let input: z.infer<typeof chatTestInputSchema>;
  try {
    input = chatTestInputSchema.parse(await c.req.json());
  } catch (cause) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      safeMessage: 'Invalid chat test request body',
      cause
    });
  }

  const decision = await createAIProvider(c.env).generateReply({
    message: input.message,
    requestId: c.get('requestId')
  });

  let outbound: { sent: false } | { sent: true; result: unknown } = { sent: false };
  if (input.send_to_whatsapp) {
    const number = input.number ?? config.TEST_WHATSAPP_NUMBER;
    if (!number) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        httpStatus: 400,
        safeMessage: 'WhatsApp test number is required'
      });
    }

    const result = await createUazapiProvider(c.env, c.get('requestId')).sendText({
      number,
      text: decision.reply
    });
    outbound = { sent: true, result };
  }

  return successResponse(c, {
    provider: config.AI_MODE,
    model:
      config.AI_MODE === 'openrouter' && 'resolved_model' in decision
        ? (decision as { resolved_model?: string }).resolved_model
        : config.AI_MODE === 'openrouter'
          ? config.OPENROUTER_MODEL
          : 'mock',
    decision,
    outbound
  });
});

function isLocalDevRouteEnabled(config: ReturnType<typeof getConfig>): boolean {
  return config.APP_ENV === 'local' && config.LOCAL_DEV_ROUTES_ENABLED;
}
