import { AppError } from '../../lib/errors';
import type { SendImageInput, SendTextInput } from './types';

export class UazapiProvider {
  async sendText(input: SendTextInput): Promise<never> {
    void input;
    throw notConfigured();
  }

  async sendImage(input: SendImageInput): Promise<never> {
    void input;
    throw notConfigured();
  }

  async markAsRead(providerMessageId: string): Promise<never> {
    void providerMessageId;
    throw notConfigured();
  }

  async getInstanceStatus(): Promise<never> {
    throw notConfigured();
  }
}

function notConfigured(): AppError {
  return new AppError({
    code: 'UAZAPI_NOT_CONFIGURED',
    httpStatus: 503,
    safeMessage: 'UAZAPI integration is pending official documentation'
  });
}
