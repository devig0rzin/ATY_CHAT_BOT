import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config/env';
import { UazapiMediaResolver } from '../src/integrations/uazapi/media-resolver';

afterEach(() => vi.unstubAllGlobals());

describe('UazapiMediaResolver image handling', () => {
  it('materializa uma imagem UAZAPI autenticada em data URL validada', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fileURL: 'https://media.example.test/image.jpg',
            mimetype: 'image/jpeg'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' }
        })
      );
    vi.stubGlobal('fetch', fetch);

    const result = await new UazapiMediaResolver(
      getConfig({
        AI_MODE: 'mock',
        WEBHOOK_AUTH_MODE: 'off',
        UAZAPI_BASE_URL: 'https://uazapi.example.test',
        UAZAPI_TOKEN: 'secret'
      }),
      'image-request'
    ).resolveImage('message-id');

    expect(result).toEqual({ dataUrl: 'data:image/jpeg;base64,/9j/4A==', mimeType: 'image/jpeg' });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ headers: { token: 'secret' } });
  });

  it('rejeita conteúdo que não corresponde ao MIME declarado', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fileURL: 'https://media.example.test/image.jpg',
            mimetype: 'image/jpeg'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([60, 104, 116, 109, 108, 62]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' }
        })
      );
    vi.stubGlobal('fetch', fetch);

    await expect(
      new UazapiMediaResolver(
        getConfig({
          AI_MODE: 'mock',
          WEBHOOK_AUTH_MODE: 'off',
          UAZAPI_BASE_URL: 'https://uazapi.example.test',
          UAZAPI_TOKEN: 'secret'
        }),
        'image-request'
      ).resolveImage('message-id')
    ).rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED_FORMAT' });
  });
});
