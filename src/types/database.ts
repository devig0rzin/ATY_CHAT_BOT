export interface WebhookEventRecord {
  id: string;
  requestId: string;
  provider: 'uazapi';
  payloadSha256: string;
  payloadJson: string;
  receivedAt: string;
}
