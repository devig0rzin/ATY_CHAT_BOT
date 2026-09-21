import { getConfig } from '../../config/env';
import { MockAIProvider, OpenAIProvider, type AIProvider } from './provider';
import { OpenRouterProvider } from '../openrouter/provider';
import { GeminiProvider } from '../gemini/provider';
import type { Env } from '../../types/env';

export function createAIProvider(env: Env): AIProvider {
  const config = getConfig(env);
  if (config.AI_MODE === 'openai') return new OpenAIProvider(config);
  if (config.AI_MODE === 'openrouter') return new OpenRouterProvider(config);
  if (config.AI_MODE === 'gemini') return new GeminiProvider(config);
  return new MockAIProvider();
}
