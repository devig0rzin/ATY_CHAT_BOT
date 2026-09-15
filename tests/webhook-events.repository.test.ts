import { describe, expect, it } from 'vitest';
import { WebhookEventsRepository } from '../src/repositories/webhook-events.repository';

describe('WebhookEventsRepository claim lifecycle', () => {
  it.each([
    ['received', 'claimed'],
    ['failed', 'claimed'],
    ['processed', 'processed'],
    ['processing', 'processing']
  ] as const)('handles an existing %s event as %s', async (existingStatus, expectedStatus) => {
    const db = createD1(existingStatus);
    const repository = new WebhookEventsRepository(db as unknown as D1Database);

    const result = await repository.claim({
      id: 'new-event',
      requestId: 'request-1',
      provider: 'uazapi',
      providerEventId: 'provider-event-1',
      payloadSha256: 'hash-1',
      payloadJson: '{}',
      receivedAt: '2026-09-16T00:00:00.000Z'
    });

    expect(result.status).toBe(expectedStatus);
    expect(db.event.processing_status).toBe(
      expectedStatus === 'claimed' ? 'processing' : existingStatus
    );
  });
});

function createD1(initialStatus: 'received' | 'processing' | 'processed' | 'failed') {
  const event = {
    id: 'event-1',
    provider: 'uazapi',
    provider_event_id: 'provider-event-1',
    processing_status: initialStatus
  };
  const db = {
    event,
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (sql.includes('INSERT INTO webhook_events')) {
                throw new Error('UNIQUE constraint failed: webhook_events.provider_event_id');
              }
              if (sql.includes("processing_status = 'processing'")) {
                if (
                  event.id === values[0] &&
                  (event.processing_status === 'received' || event.processing_status === 'failed')
                ) {
                  event.processing_status = 'processing';
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 1 } };
            },
            async first() {
              return {
                id: event.id,
                processing_status: event.processing_status
              };
            }
          };
        }
      };
    }
  };
  return db;
}
