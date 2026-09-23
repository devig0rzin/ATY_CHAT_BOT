import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import type { AudioMediaInput } from '../groq/audio-transcription.service';

export interface ImageMediaInput {
  url: string;
  mimeType: string;
}

export class UazapiMediaResolver {
  constructor(
    private readonly config: AppConfig,
    private readonly requestId: string
  ) {}

  async resolveAudio(messageId: string): Promise<AudioMediaInput> {
    const logger = createLogger(this.config, this.requestId);
    const startedAt = Date.now();
    const maskedMessageId = maskMessageId(messageId);
    logger.info('audio.media.resolve.started', {
      provider: 'uazapi',
      masked_message_id: maskedMessageId
    });

    if (!this.config.UAZAPI_BASE_URL || !this.config.UAZAPI_TOKEN) {
      throw new AppError({
        code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
        httpStatus: 503,
        safeMessage: 'UAZAPI media configuration is missing'
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.UAZAPI_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${this.config.UAZAPI_BASE_URL.replace(/\/+$/, '')}/message/download`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            token: this.config.UAZAPI_TOKEN
          },
          body: JSON.stringify({
            id: messageId,
            generate_mp3: true,
            return_base64: false,
            transcribe: false
          })
        }
      );

      if (!response.ok) {
        throw new AppError({
          code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 502,
          safeMessage: 'UAZAPI audio media resolution failed',
          metadata: { status: response.status }
        });
      }

      const payload = (await response.json().catch((cause) => {
        throw new AppError({
          code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 502,
          safeMessage: 'UAZAPI media response was malformed',
          cause
        });
      })) as Record<string, unknown>;
      const fileUrl = typeof payload.fileURL === 'string' ? payload.fileURL.trim() : '';
      const mimeType = typeof payload.mimetype === 'string' ? payload.mimetype.trim() : '';
      if (!fileUrl || !isHttpUrl(fileUrl) || !mimeType.toLowerCase().startsWith('audio/')) {
        throw new AppError({
          code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 502,
          safeMessage: 'UAZAPI did not return a valid audio media URL'
        });
      }

      logger.info('audio.media.resolve.completed', {
        provider: 'uazapi',
        masked_message_id: maskedMessageId,
        mime_type: mimeType,
        duration_ms: Date.now() - startedAt
      });
      return {
        url: fileUrl,
        mimeType,
        fileName: 'voice.mp3'
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new AppError({
          code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 504,
          safeMessage: 'UAZAPI audio media resolution timed out',
          cause
        });
      }
      throw new AppError({
        code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
        httpStatus: 502,
        safeMessage: 'UAZAPI audio media resolution failed',
        cause
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async resolveImage(messageId: string): Promise<ImageMediaInput> {
    const logger = createLogger(this.config, this.requestId);
    const startedAt = Date.now();
    const maskedMessageId = maskMessageId(messageId);
    logger.info('image.media.resolve.started', {
      provider: 'uazapi',
      masked_message_id: maskedMessageId
    });

    if (!this.config.UAZAPI_BASE_URL || !this.config.UAZAPI_TOKEN) {
      throw new AppError({
        code: 'IMAGE_MEDIA_DOWNLOAD_ERROR',
        httpStatus: 503,
        safeMessage: 'UAZAPI media configuration is missing'
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.UAZAPI_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${this.config.UAZAPI_BASE_URL.replace(/\/+$/, '')}/message/download`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            token: this.config.UAZAPI_TOKEN
          },
          body: JSON.stringify({ id: messageId, return_base64: false, transcribe: false })
        }
      );
      if (!response.ok) {
        throw new AppError({
          code: 'IMAGE_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 502,
          safeMessage: 'UAZAPI image media resolution failed',
          metadata: { status: response.status }
        });
      }
      const payload = (await response.json().catch((cause) => {
        throw new AppError({
          code: 'IMAGE_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 502,
          safeMessage: 'UAZAPI media response was malformed',
          cause
        });
      })) as Record<string, unknown>;
      const fileUrl = typeof payload.fileURL === 'string' ? payload.fileURL.trim() : '';
      const mimeType = typeof payload.mimetype === 'string' ? payload.mimetype.trim() : '';
      if (!fileUrl || !isHttpUrl(fileUrl) || !mimeType.toLowerCase().startsWith('image/')) {
        throw new AppError({
          code: 'IMAGE_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 502,
          safeMessage: 'UAZAPI did not return a valid image media URL'
        });
      }
      logger.info('image.media.resolve.completed', {
        provider: 'uazapi',
        masked_message_id: maskedMessageId,
        mime_type: mimeType,
        duration_ms: Date.now() - startedAt
      });
      return { url: fileUrl, mimeType };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new AppError({
          code: 'IMAGE_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 504,
          safeMessage: 'UAZAPI image media resolution timed out',
          cause
        });
      }
      throw new AppError({
        code: 'IMAGE_MEDIA_DOWNLOAD_ERROR',
        httpStatus: 502,
        safeMessage: 'UAZAPI image media resolution failed',
        cause
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function maskMessageId(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  return normalized.length <= 6
    ? `${normalized.slice(0, 2)}…`
    : `${normalized.slice(0, 3)}…${normalized.slice(-3)}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
