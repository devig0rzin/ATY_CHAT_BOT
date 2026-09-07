import type { Env } from '../../types/env';
import { getConfig } from '../../config/env';
import { UazapiProvider } from './provider';

export function createUazapiProvider(env: Env, requestId?: string): UazapiProvider {
  return new UazapiProvider(getConfig(env), requestId);
}
