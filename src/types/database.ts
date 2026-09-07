export interface WebhookEventRecord {
  id: string;
  requestId: string;
  provider: 'uazapi';
  providerEventId?: string;
  eventType?: string;
  payloadSha256: string;
  payloadJson: string;
  receivedAt: string;
}
