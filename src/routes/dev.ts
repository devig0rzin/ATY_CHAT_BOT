import { Hono } from 'hono';
import { z } from 'zod';
import { getConfig } from '../config/env';
import { AppError } from '../lib/errors';
import { successResponse } from '../lib/response';
import { createAIProvider } from '../integrations/openai/client';
import { createUazapiProvider } from '../integrations/uazapi/client';
import { WebhookService } from '../services/webhook.service';
import type { AIDecision } from '../schemas/ai.schemas';
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

const coordinatorTestInputSchema = z.object({
  message: z.string().trim().min(1),
  phone: z
    .string()
    .trim()
    .regex(/^\d{10,15}$/),
  run_id: z.string().trim().min(1).max(80)
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
      (config.AI_MODE === 'openrouter' || config.AI_MODE === 'groq') && 'resolved_model' in decision
        ? (decision as { resolved_model?: string }).resolved_model
        : config.AI_MODE === 'openrouter'
          ? config.OPENROUTER_MODEL
          : config.AI_MODE === 'groq'
            ? config.GROQ_MODEL
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
      (config.AI_MODE === 'openrouter' || config.AI_MODE === 'groq') && 'resolved_model' in decision
        ? (decision as { resolved_model?: string }).resolved_model
        : config.AI_MODE === 'openrouter'
          ? config.OPENROUTER_MODEL
          : config.AI_MODE === 'groq'
            ? config.GROQ_MODEL
            : 'mock',
    decision,
    outbound
  });
});

devRoutes.post('/coordinator-test', async (c) => {
  const config = getConfig(c.env);
  if (!isLocalDevRouteEnabled(config)) {
    return c.notFound();
  }

  let input: z.infer<typeof coordinatorTestInputSchema>;
  try {
    input = coordinatorTestInputSchema.parse(await c.req.json());
  } catch (cause) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      safeMessage: 'Invalid coordinator test request body',
      cause
    });
  }

  let observedDecision: AIDecision | undefined;
  let outboundCalls = 0;
  const outboundSender = {
    sendText: async () => {
      outboundCalls += 1;
      return {
        status: 200,
        provider: 'uazapi' as const,
        providerMessageId: `local-${crypto.randomUUID()}`
      };
    }
  };
  const alertSender = { sendText: async () => ({ status: 200 }) };
  const service = new WebhookService(c.env, {
    outboundSender,
    alertSender,
    decisionObserver: (decision) => {
      observedDecision = decision;
    }
  });
  const messageId = `local-${crypto.randomUUID()}`;
  const instanceName = `LOCAL_COORDINATOR_TEST_${input.run_id}`;
  const payload = {
    EventType: 'messages',
    instanceName,
    owner: 'local-coordinator-test',
    message: {
      fromMe: false,
      isGroup: false,
      wasSentByApi: false,
      chatid: `${input.phone}@s.whatsapp.net`,
      sender_pn: input.phone,
      senderName: `Local Coordinator Test ${input.run_id}`,
      content: input.message,
      text: input.message,
      messageid: messageId,
      type: 'text',
      messageType: 'Conversation',
      messageTimestamp: Date.now()
    },
    chat: {
      wa_isGroup: false,
      wa_chatid: `${input.phone}@s.whatsapp.net`,
      wa_contactName: `Local Coordinator Test ${input.run_id}`
    }
  };
  const result = await service.captureUazapiEvent(
    new Request('http://local.test/webhooks/uazapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }),
    { requestId: c.get('requestId'), startedAt: Date.now() }
  );

  return successResponse(c, {
    run_id: input.run_id,
    result,
    outbound_calls: outboundCalls,
    decision_valid: Boolean(observedDecision),
    reply_mentions_lucas: /\blucas\b/i.test(observedDecision?.reply ?? ''),
    reply_mentions_clinica: /cl[ií]nica/i.test(observedDecision?.reply ?? '')
  });
});

function isLocalDevRouteEnabled(config: ReturnType<typeof getConfig>): boolean {
  return config.APP_ENV === 'local' && config.LOCAL_DEV_ROUTES_ENABLED;
}
