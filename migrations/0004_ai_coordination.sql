CREATE TABLE IF NOT EXISTS ai_conversation_state (
  conversation_id TEXT PRIMARY KEY,
  locked_until TEXT,
  last_processed_created_at TEXT,
  last_processed_message_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS ai_provider_rate_state (
  provider TEXT PRIMARY KEY,
  locked_until TEXT,
  last_request_at TEXT,
  updated_at TEXT NOT NULL
);
