export interface SendTextInput {
  number: string;
  text: string;
  replyId?: string;
}

export interface NormalizedUazapiInboundMessage {
  provider: 'uazapi';
  event: 'messages';
  messageId?: string;
  phone: string;
  senderName?: string;
  text: string;
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
