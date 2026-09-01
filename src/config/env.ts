import { z } from 'zod';
import { AppError } from '../lib/errors';
import type { Env } from '../types/env';

const envSchema = z
  .object({
    AI_MODE: z.enum(['mock', 'openai']).default('mock'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(600),
    UAZAPI_BASE_URL: z.string().optional(),
    UAZAPI_TOKEN: z.string().optional(),
    UAZAPI_INSTANCE_ID: z.string().optional(),
    UAZAPI_DEBUG_PAYLOAD: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    WEBHOOK_AUTH_MODE: z.enum(['off', 'header']).default('header'),
    WEBHOOK_SECRET: z.string().optional(),
    ADMIN_API_KEY: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_MESSAGE_CONTENT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AI_RECENT_MESSAGE_LIMIT: z.coerce.number().int().positive().default(12)
  })
  .superRefine((env, ctx) => {
    if (env.AI_MODE === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'Required when AI_MODE=openai'
      });
    }
    if (env.WEBHOOK_AUTH_MODE === 'header' && !env.WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_SECRET'],
        message: 'Required when WEBHOOK_AUTH_MODE=header'
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function getConfig(env: Env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      httpStatus: 500,
      safeMessage: 'Environment configuration is invalid',
      metadata: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) }
    });
  }
  return parsed.data;
}
