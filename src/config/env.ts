import { z } from 'zod';
import { AppError } from '../lib/errors';
import type { Env } from '../types/env';

const booleanStringSchema = z
  .string()
  .optional()
  .transform((value) => parseBooleanEnv(value));

const envSchema = z
  .object({
    APP_ENV: z.enum(['local', 'production']).default('production'),
    AI_MODE: z.enum(['mock', 'openai', 'openrouter']).default('mock'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(600),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().default('openrouter/free'),
    OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
    AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    LOCAL_DEV_ROUTES_ENABLED: booleanStringSchema,
    UAZAPI_BASE_URL: z.string().optional(),
    UAZAPI_TOKEN: z.string().optional(),
    UAZAPI_INSTANCE_ID: z.string().optional(),
    UAZAPI_DEBUG_PAYLOAD: booleanStringSchema,
    WEBHOOK_AUTH_MODE: z.enum(['off', 'header']).default('header'),
    WEBHOOK_SECRET: z.string().optional(),
    ADMIN_API_KEY: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_MESSAGE_CONTENT: booleanStringSchema,
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

export function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return false;
}

export function isEnvConfigured(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}
