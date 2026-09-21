import { describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config/env';
import { AudioTranscriptionService } from '../src/integrations/groq/audio-transcription.service';
import {
  normalizeUazapiEvent,
  getUazapiAutoreplySkipReason
} from '../src/integrations/uazapi/normalizer';

const baseEnv = {
  APP_ENV: 'local',
  AI_MODE: 'groq',
  GROQ_API_KEY: 'test-key',
  GROQ_TRANSCRIPTION_ENABLED: 'true',
  GROQ_TRANSCRIPTION_MODEL: 'whisper-large-v3-turbo',
  GROQ_TRANSCRIPTION_LANGUAGE: 'pt',
  GROQ_TRANSCRIPTION_TIMEOUT_MS: '30',
  GROQ_TRANSCRIPTION_MAX_BYTES: '24',
  UAZAPI_TOKEN: 'test-uazapi-token',
  LOG_LEVEL: 'error',
  LOG_MESSAGE_CONTENT: 'false',
  WEBHOOK_AUTH_MODE: 'off'
};

describe('AudioTranscriptionService', () => {
  it('envia multipart com Whisper, idioma pt e resposta JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('whisper-large-v3-turbo');
      expect(form.get('language')).toBe('pt');
      expect(form.get('response_format')).toBe('json');
      expect(form.get('temperature')).toBe('0');
      expect((form.get('file') as File).name).toBe('voice.ogg');
      return new Response(JSON.stringify({ text: 'Meu nome é Lucas.' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new AudioTranscriptionService(getConfig(baseEnv)).transcribe({
      requestId: 'audio-success',
      media: { base64: btoa('audio'), fileName: 'voice.ogg', mimeType: 'audio/ogg' }
    });

    expect(result.text).toBe('Meu nome é Lucas.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifica 429 sem expor conteúdo upstream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('provider detail', { status: 429 }))
    );
    await expect(
      new AudioTranscriptionService(getConfig(baseEnv)).transcribe({
        requestId: 'audio-429',
        media: { base64: btoa('audio'), fileName: 'voice.ogg', mimeType: 'audio/ogg' }
      })
    ).rejects.toMatchObject({ code: 'GROQ_TRANSCRIPTION_RATE_LIMIT', httpStatus: 429 });
  });

  it('classifica timeout de transcrição', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      })
    );
    await expect(
      new AudioTranscriptionService(getConfig(baseEnv)).transcribe({
        requestId: 'audio-timeout',
        media: { base64: btoa('audio'), fileName: 'voice.ogg', mimeType: 'audio/ogg' }
      })
    ).rejects.toMatchObject({ code: 'GROQ_TRANSCRIPTION_TIMEOUT', httpStatus: 504 });
  });

  it('classifica upstream 5xx, tamanho e formato', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 }))
    );
    await expect(
      new AudioTranscriptionService(getConfig(baseEnv)).transcribe({
        requestId: 'audio-503',
        media: { base64: btoa('audio'), fileName: 'voice.ogg', mimeType: 'audio/ogg' }
      })
    ).rejects.toMatchObject({ code: 'GROQ_TRANSCRIPTION_UPSTREAM_ERROR' });

    await expect(
      new AudioTranscriptionService(
        getConfig({ ...baseEnv, GROQ_TRANSCRIPTION_MAX_BYTES: '2' })
      ).transcribe({
        requestId: 'audio-large',
        media: { base64: btoa('audio'), fileName: 'voice.ogg', mimeType: 'audio/ogg' }
      })
    ).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });

    await expect(
      new AudioTranscriptionService(getConfig(baseEnv)).transcribe({
        requestId: 'audio-format',
        media: {
          base64: btoa('audio'),
          fileName: 'voice.exe',
          mimeType: 'application/octet-stream'
        }
      })
    ).rejects.toMatchObject({ code: 'AUDIO_UNSUPPORTED_FORMAT' });
  });
});

describe('UAZAPI audio normalization', () => {
  it('identifica áudio pelo tipo confirmado, sem inventar estrutura de mídia', () => {
    const payload = {
      EventType: 'messages',
      message: {
        fromMe: false,
        isGroup: false,
        wasSentByApi: false,
        chatid: '5511999999999@s.whatsapp.net',
        messageid: 'audio-1',
        type: 'ptt'
      }
    };
    const normalized = normalizeUazapiEvent(payload);
    expect(normalized).toMatchObject({ isAudio: true, text: '', audioMediaStatus: 'unconfirmed' });
    expect(normalized?.audioMedia).toBeUndefined();
    expect(getUazapiAutoreplySkipReason(payload)).toBeUndefined();
  });
});
