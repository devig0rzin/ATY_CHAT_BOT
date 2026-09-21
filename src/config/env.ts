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
    AI_MODE: z.enum(['mock', 'openai', 'openrouter', 'gemini', 'groq']).default('mock'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default('gemini-3.7-flash'),
    GROQ_API_KEY: z.string().optional(),
    GROQ_MODEL: z.string().default('openai/gpt-oss-20b'),
    GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
    GROQ_TRANSCRIPTION_ENABLED: booleanStringSchema,
    GROQ_TRANSCRIPTION_MODEL: z.string().default('whisper-large-v3-turbo'),
    GROQ_TRANSCRIPTION_LANGUAGE: z.string().default('pt'),
    GROQ_TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    GROQ_TRANSCRIPTION_MAX_BYTES: z.coerce.number().int().positive().default(24000000),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(600),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().default('openrouter/free'),
    OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
    AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    AI_RATE_LIMIT_GUARD_ENABLED: booleanStringSchema,
    AI_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().nonnegative().default(8000),
    AI_RATE_LIMIT_MAX_RETRIES: z.coerce.number().int().min(0).max(1).default(1),
    WHATSAPP_INBOUND_BUFFER_MS: z.coerce.number().int().nonnegative().default(0),
    AI_DEBUG_RESPONSE: booleanStringSchema,
    LOCAL_DEV_ROUTES_ENABLED: booleanStringSchema,
    LOCAL_INBOUND_AUTOREPLY_ENABLED: booleanStringSchema,
    INBOUND_AUTOREPLY_ENABLED: booleanStringSchema,
    UAZAPI_BASE_URL: z.string().optional(),
    UAZAPI_TOKEN: z.string().optional(),
    UAZAPI_INSTANCE_ID: z.string().optional(),
    UAZAPI_OUTBOUND_ENABLED: booleanStringSchema,
    UAZAPI_DEBUG_PAYLOAD: booleanStringSchema,
    UAZAPI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    TEST_WHATSAPP_NUMBER: z.string().optional(),
    WEBHOOK_AUTH_MODE: z.enum(['off', 'header']).default('header'),
    WEBHOOK_SECRET: z.string().optional(),
    ADMIN_API_KEY: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_MESSAGE_CONTENT: booleanStringSchema,
    AI_RECENT_MESSAGE_LIMIT: z.coerce.number().int().positive().default(12),
    WHATSAPP_REPLY_SOFT_LIMIT: z.coerce.number().int().positive().default(280),
    WHATSAPP_REPLY_MAX_CHUNKS: z.coerce.number().int().min(1).max(2).default(2),
    TEST_ERROR_ALERT_ENABLED: booleanStringSchema,
    TEST_ERROR_ALERT_NUMBER: z.string().default('5511976388220'),
    TEST_ERROR_ALERT_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60)
  })
  .superRefine((env, ctx) => {
    if (env.AI_MODE === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'Required when AI_MODE=openai'
      });
    }
    if (env.AI_MODE === 'gemini' && !env.GEMINI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'Required when AI_MODE=gemini'
      });
    }
    if (env.AI_MODE === 'groq' && !env.GROQ_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GROQ_API_KEY'],
        message: 'Required when AI_MODE=groq'
      });
    }
    if (env.TEST_ERROR_ALERT_NUMBER !== '5511976388220') {
      ctx.addIssue({
        code: 'custom',
        path: ['TEST_ERROR_ALERT_NUMBER'],
        message: 'Technical alert number is fixed'
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
