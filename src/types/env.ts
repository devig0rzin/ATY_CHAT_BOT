export interface Env {
  DB?: D1Database;
  AI_MODE?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_MAX_OUTPUT_TOKENS?: string;
  UAZAPI_BASE_URL?: string;
  UAZAPI_TOKEN?: string;
  UAZAPI_INSTANCE_ID?: string;
  UAZAPI_DEBUG_PAYLOAD?: string;
  WEBHOOK_AUTH_MODE?: string;
  WEBHOOK_SECRET?: string;
  ADMIN_API_KEY?: string;
  LOG_LEVEL?: string;
  LOG_MESSAGE_CONTENT?: string;
  AI_RECENT_MESSAGE_LIMIT?: string;
}
