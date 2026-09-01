export interface SendTextInput {
  to: string;
  text: string;
}

export interface SendImageInput {
  to: string;
  imageUrl: string;
  caption?: string;
}
