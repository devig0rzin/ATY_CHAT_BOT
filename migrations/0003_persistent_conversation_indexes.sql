CREATE INDEX IF NOT EXISTS idx_conversations_open_contact
  ON conversations(contact_id, status, last_message_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_contact_status
  ON handoffs(contact_id, status);
