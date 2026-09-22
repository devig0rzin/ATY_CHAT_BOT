import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';

const supportedExtensions = new Set([
  'ogg',
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'wav',
  'webm',
  'flac'
]);

export interface AudioMediaInput {
  url?: string;
  base64?: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
}

export interface AudioTranscriptionResult {
  text: string;
  provider: 'groq';
  model: string;
  language: string;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
}

export class AudioTranscriptionService {
  constructor(private readonly config: AppConfig) {}

  async transcribe(input: {
    media: AudioMediaInput;
    requestId: string;
  }): Promise<AudioTranscriptionResult> {
    const logger = createLogger(this.config, input.requestId);
    const startedAt = Date.now();
    if (!this.config.GROQ_TRANSCRIPTION_ENABLED) {
      throw new AppError({
        code: 'GROQ_TRANSCRIPTION_UPSTREAM_ERROR',
        httpStatus: 503,
        safeMessage: 'Groq audio transcription is disabled'
      });
    }
    if (!this.config.GROQ_API_KEY) {
      throw new AppError({
        code: 'GROQ_CONFIGURATION_ERROR',
        httpStatus: 503,
        safeMessage: 'Groq API key is not configured'
      });
    }

    const media = validateMedia(input.media, this.config.GROQ_TRANSCRIPTION_MAX_BYTES);
    logger.info('audio.transcription.started', {
      provider: 'groq',
      model: this.config.GROQ_TRANSCRIPTION_MODEL,
      audio_size_bytes: media.sizeBytes,
      mime_type: media.mimeType
    });

    try {
      const downloadStartedAt = Date.now();
      logger.info('audio.file.download.started', {
        provider: 'uazapi',
        mime_type: media.mimeType
      });
      const bytes = await loadMedia(media, this.config);
      logger.info('audio.file.download.completed', {
        provider: 'uazapi',
        mime_type: media.mimeType,
        audio_size_bytes: bytes.byteLength,
        download_duration_ms: Date.now() - downloadStartedAt
      });
      if (bytes.byteLength > this.config.GROQ_TRANSCRIPTION_MAX_BYTES) {
        throw new AppError({
          code: 'AUDIO_TOO_LARGE',
          httpStatus: 413,
          safeMessage: 'Audio file is too large',
          metadata: { size_bytes: bytes.byteLength }
        });
      }
      const form = new FormData();
      form.append(
        'file',
        new File([bytes.buffer as ArrayBuffer], media.fileName, { type: media.mimeType }),
        media.fileName
      );
      form.append('model', this.config.GROQ_TRANSCRIPTION_MODEL);
      form.append('language', this.config.GROQ_TRANSCRIPTION_LANGUAGE);
      form.append('response_format', 'json');
      form.append('temperature', '0');

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.GROQ_TRANSCRIPTION_TIMEOUT_MS
      );
      try {
        const response = await fetch(
          `${this.config.GROQ_BASE_URL.replace(/\/+$/, '')}/audio/transcriptions`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: { Authorization: `Bearer ${this.config.GROQ_API_KEY}` },
            body: form
          }
        );
        if (response.status === 429) {
          throw new AppError({
            code: 'GROQ_TRANSCRIPTION_RATE_LIMIT',
            httpStatus: 429,
            safeMessage: 'Groq transcription rate limit reached',
            metadata: {
              status: response.status,
              retry_after: response.headers.get('retry-after') ?? undefined
            }
          });
        }
        if (response.status >= 500) {
          throw new AppError({
            code: 'GROQ_TRANSCRIPTION_UPSTREAM_ERROR',
            httpStatus: 502,
            safeMessage: 'Groq transcription upstream error',
            metadata: { status: response.status, model: this.config.GROQ_TRANSCRIPTION_MODEL }
          });
        }
        if (!response.ok) {
          throw new AppError({
            code: 'GROQ_TRANSCRIPTION_INVALID_RESPONSE',
            httpStatus: 502,
            safeMessage: 'Groq transcription request failed',
            metadata: { status: response.status, model: this.config.GROQ_TRANSCRIPTION_MODEL }
          });
        }
        const payload = (await response.json().catch((cause) => {
          throw new AppError({
            code: 'GROQ_TRANSCRIPTION_INVALID_RESPONSE',
            httpStatus: 502,
            safeMessage: 'Groq transcription returned malformed JSON',
            cause
          });
        })) as { text?: unknown };
        const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
        if (!text) {
          throw new AppError({
            code: 'GROQ_TRANSCRIPTION_INVALID_RESPONSE',
            httpStatus: 502,
            safeMessage: 'Groq transcription returned empty text'
          });
        }
        const result = {
          text,
          provider: 'groq' as const,
          model: this.config.GROQ_TRANSCRIPTION_MODEL,
          language: this.config.GROQ_TRANSCRIPTION_LANGUAGE,
          durationMs: Date.now() - startedAt,
          sizeBytes: bytes.byteLength,
          mimeType: media.mimeType
        };
        logger.info('audio.transcription.completed', {
          provider: result.provider,
          model: result.model,
          duration_ms: result.durationMs,
          audio_size_bytes: result.sizeBytes,
          mime_type: result.mimeType,
          transcript_length: result.text.length
        });
        return result;
      } finally {
        clearTimeout(timeout);
      }
    } catch (cause) {
      const error = mapTranscriptionError(cause, media);
      logger.error('audio.transcription.failed', {
        provider: 'groq',
        model: this.config.GROQ_TRANSCRIPTION_MODEL,
        duration_ms: Date.now() - startedAt,
        audio_size_bytes: media.sizeBytes ?? null,
        mime_type: media.mimeType,
        error_code: error.code
      });
      throw error;
    }
  }
}

function validateMedia(media: AudioMediaInput, maxBytes: number) {
  const fileName = media.fileName?.trim() || 'audio.ogg';
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  const mimeType = media.mimeType?.trim().toLowerCase() || mimeForExtension(extension);
  if (!supportedExtensions.has(extension) && !supportedMimeTypes.has(mimeType)) {
    throw new AppError({
      code: 'AUDIO_UNSUPPORTED_FORMAT',
      httpStatus: 415,
      safeMessage: 'Audio format is not supported',
      metadata: { extension, mime_type: mimeType }
    });
  }
  if (!media.url && !media.base64) {
    throw new AppError({
      code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
      httpStatus: 502,
      safeMessage: 'Audio media is unavailable'
    });
  }
  if (media.sizeBytes !== undefined && media.sizeBytes > maxBytes) {
    throw new AppError({
      code: 'AUDIO_TOO_LARGE',
      httpStatus: 413,
      safeMessage: 'Audio file is too large',
      metadata: { size_bytes: media.sizeBytes }
    });
  }
  return { ...media, fileName, mimeType };
}

async function loadMedia(
  media: ReturnType<typeof validateMedia>,
  config: AppConfig
): Promise<Uint8Array> {
  if (media.base64) {
    try {
      const binary = atob(media.base64.replace(/^data:[^;]+;base64,/, ''));
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch (cause) {
      throw new AppError({
        code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
        httpStatus: 502,
        safeMessage: 'Audio media could not be decoded',
        cause
      });
    }
  }
  try {
    const response = await fetch(media.url as string, {
      headers: config.UAZAPI_TOKEN ? { token: config.UAZAPI_TOKEN } : undefined
    });
    if (!response.ok) {
      throw new AppError({
        code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
        httpStatus: 502,
        safeMessage: 'Audio media download failed',
        metadata: { status: response.status }
      });
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError({
      code: 'AUDIO_MEDIA_DOWNLOAD_ERROR',
      httpStatus: 502,
      safeMessage: 'Audio media download failed',
      cause
    });
  }
}

function mapTranscriptionError(cause: unknown, media: { mimeType: string }): AppError {
  if (cause instanceof AppError) return cause;
  if (cause instanceof Error && cause.name === 'AbortError') {
    return new AppError({
      code: 'GROQ_TRANSCRIPTION_TIMEOUT',
      httpStatus: 504,
      safeMessage: 'Groq transcription timed out',
      cause,
      metadata: { mime_type: media.mimeType }
    });
  }
  return new AppError({
    code: 'GROQ_TRANSCRIPTION_UPSTREAM_ERROR',
    httpStatus: 502,
    safeMessage: 'Groq transcription failed',
    cause,
    metadata: { mime_type: media.mimeType }
  });
}

const supportedMimeTypes = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
  'video/mp4'
]);

function mimeForExtension(extension: string): string {
  const map: Record<string, string> = {
    ogg: 'audio/ogg',
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    mpeg: 'audio/mpeg',
    mpga: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    webm: 'audio/webm',
    flac: 'audio/flac'
  };
  return map[extension] ?? 'application/octet-stream';
}
