PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE,
  name TEXT,
  email TEXT,
  company TEXT,
  segment TEXT,
  preferred_language TEXT DEFAULT 'pt-BR',
  ai_enabled INTEGER DEFAULT 1,
  lead_stage TEXT DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'uazapi',
  provider_instance_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  started_at TEXT NOT NULL,
  last_message_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  direction TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  content TEXT,
  raw_payload_json TEXT,
  ai_generated INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS conversation_memory (
  contact_id TEXT PRIMARY KEY,
  summary TEXT,
  facts_json TEXT,
  goals_json TEXT,
  open_loops_json TEXT,
  current_intent TEXT,
  memory_version INTEGER DEFAULT 1,
  last_summarized_message_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL UNIQUE,
  status TEXT DEFAULT 'new',
  service_interest TEXT,
  budget_status TEXT,
  urgency TEXT,
  company_size TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  conversation_id TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  requested_at TEXT NOT NULL,
  accepted_at TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  event_type TEXT,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received',
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  conversation_id TEXT,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  content TEXT,
  status TEXT DEFAULT 'queued',
  attempt_count INTEGER DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS processing_errors (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  error_code TEXT NOT NULL,
  safe_message TEXT,
  context_json TEXT,
  created_at TEXT NOT NULL
);
