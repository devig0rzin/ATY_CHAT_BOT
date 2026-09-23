import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import type { AudioMediaInput } from '../groq/audio-transcription.service';

export interface ImageMediaInput {
  dataUrl: string;
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
      const declaredMimeType = normalizeImageMimeType(
        typeof payload.mimetype === 'string' ? payload.mimetype : ''
      );
      if (!fileUrl || !isHttpUrl(fileUrl) || !declaredMimeType) {
        throw new AppError({
          code: 'IMAGE_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 502,
          safeMessage: 'UAZAPI did not return a valid image media URL'
        });
      }
      const mediaResponse = await fetch(fileUrl, { headers: { token: this.config.UAZAPI_TOKEN } });
      if (!mediaResponse.ok) {
        throw new AppError({
          code: 'IMAGE_MEDIA_DOWNLOAD_ERROR',
          httpStatus: 502,
          safeMessage: 'UAZAPI image media download failed',
          metadata: { status: mediaResponse.status }
        });
      }
      const mimeType =
        normalizeImageMimeType(mediaResponse.headers.get('content-type') ?? '') ?? declaredMimeType;
      const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > this.config.GROQ_VISION_MAX_BYTES) {
        throw new AppError({
          code: 'IMAGE_TOO_LARGE',
          httpStatus: 413,
          safeMessage: 'Image file is too large',
          metadata: { size_bytes: bytes.byteLength }
        });
      }
      if (!matchesImageSignature(bytes, mimeType)) {
        throw new AppError({
          code: 'IMAGE_UNSUPPORTED_FORMAT',
          httpStatus: 415,
          safeMessage: 'Image content does not match its declared format',
          metadata: { mime_type: mimeType }
        });
      }
      logger.info('image.media.resolve.completed', {
        provider: 'uazapi',
        masked_message_id: maskedMessageId,
        mime_type: mimeType,
        size_bytes: bytes.byteLength,
        duration_ms: Date.now() - startedAt
      });
      return { dataUrl: toDataUrl(bytes, mimeType), mimeType };
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

function normalizeImageMimeType(
  value: string
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | undefined {
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase();
  if (mimeType === 'image/jpg') return 'image/jpeg';
  return mimeType === 'image/jpeg' ||
    mimeType === 'image/png' ||
    mimeType === 'image/webp' ||
    mimeType === 'image/gif'
    ? mimeType
    : undefined;
}

function matchesImageSignature(bytes: Uint8Array, mimeType: ImageMediaInput['mimeType']): boolean {
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return (
      bytes.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    );
  }
  if (mimeType === 'image/gif') {
    const signature = String.fromCharCode(...bytes.slice(0, 6));
    return bytes.length >= 6 && (signature === 'GIF87a' || signature === 'GIF89a');
  }
  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  );
}

function toDataUrl(bytes: Uint8Array, mimeType: ImageMediaInput['mimeType']): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
