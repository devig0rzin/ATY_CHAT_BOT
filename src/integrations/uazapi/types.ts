export interface SendTextInput {
  number: string;
  text: string;
  replyId?: string;
}

export interface NormalizedUazapiInboundMessage {
  provider: 'uazapi';
  event: 'messages';
  messageId?: string;
  mediaDownloadId?: string;
  phone: string;
  senderName?: string;
  text: string;
  isAudio: boolean;
  audioMedia?: {
    url?: string;
    base64?: string;
    mimeType?: string;
    fileName?: string;
    sizeBytes?: number;
  };
  audioMediaStatus?: 'not_applicable' | 'unconfirmed' | 'resolved';
  fromMe: boolean;
  wasSentByApi: boolean;
  isGroup: boolean;
  messageType?: string;
  timestamp?: number;
  instanceName?: string;
  owner?: string;
}

export interface SendImageInput {
  to: string;
  imageUrl: string;
  caption?: string;
}
