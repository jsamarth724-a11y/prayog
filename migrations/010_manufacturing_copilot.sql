CREATE TABLE copilot_conversations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  machine_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE SET NULL
);

CREATE INDEX idx_copilot_conversations_owner_updated
  ON copilot_conversations(owner_id, updated_at DESC);

CREATE TABLE copilot_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES copilot_conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_copilot_messages_conversation_created
  ON copilot_messages(conversation_id, created_at, id);
