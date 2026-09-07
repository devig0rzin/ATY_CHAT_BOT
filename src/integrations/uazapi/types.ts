export interface SendTextInput {
  number: string;
  text: string;
  replyId?: string;
}

export interface NormalizedUazapiInboundMessage {
  providerMessageId?: string;
  number: string;
  text: string;
  fromMe: boolean;
}

export interface SendImageInput {
  to: string;
  imageUrl: string;
  caption?: string;
}
