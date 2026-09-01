import { getConfig } from '../../config/env';
import { MockAIProvider, OpenAIProvider, type AIProvider } from './provider';
import type { Env } from '../../types/env';

export function createAIProvider(env: Env): AIProvider {
  const config = getConfig(env);
  if (config.AI_MODE === 'openai') return new OpenAIProvider(config);
  return new MockAIProvider();
}
