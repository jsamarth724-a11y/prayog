import { randomUUID } from "node:crypto";

function parseReferences(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not parse Copilot evidence references:", error);
    return [];
  }
}

function messageFromRow(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    evidence_refs: parseReferences(row.evidence_refs),
    created_at: row.created_at,
  };
}

export function createConversation(database, ownerId, { title, machineId = null }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO copilot_conversations (id, owner_id, title, machine_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, ownerId, title, machineId, now, now);
  return getConversation(database, ownerId, id);
}

export function listConversations(database, ownerId) {
  return database.prepare(`
    SELECT id, title, machine_id, created_at, updated_at
    FROM copilot_conversations WHERE owner_id = ?
    ORDER BY updated_at DESC, id LIMIT 50
  `).all(ownerId);
}

export function getConversation(database, ownerId, conversationId) {
  const conversation = database.prepare(`
    SELECT id, title, machine_id, created_at, updated_at
    FROM copilot_conversations WHERE id = ? AND owner_id = ?
  `).get(conversationId, ownerId);
  if (!conversation) return null;
  const messages = database.prepare(`
    SELECT id, role, content, evidence_refs, created_at
    FROM copilot_messages WHERE conversation_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 100
  `).all(conversationId).reverse().map(messageFromRow);
  return { ...conversation, messages };
}

export function setConversationContext(database, ownerId, conversationId, { title, machineId }) {
  const now = new Date().toISOString();
  return database.prepare(`
    UPDATE copilot_conversations SET title = ?, machine_id = ?, updated_at = ?
    WHERE id = ? AND owner_id = ?
  `).run(title, machineId, now, conversationId, ownerId).changes === 1;
}

export function appendConversationTurn(database, ownerId, conversationId, question, answer, evidenceRefs) {
  const userAt = new Date();
  const assistantAt = new Date(userAt.getTime() + 1).toISOString();
  const userTimestamp = userAt.toISOString();
  const insert = database.prepare(`
    INSERT INTO copilot_messages (id, conversation_id, role, content, evidence_refs, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const save = database.transaction(() => {
    const exists = database.prepare(`
      SELECT id FROM copilot_conversations WHERE id = ? AND owner_id = ?
    `).get(conversationId, ownerId);
    if (!exists) return false;
    insert.run(randomUUID(), conversationId, "user", question, "[]", userTimestamp);
    insert.run(randomUUID(), conversationId, "assistant", answer, JSON.stringify(evidenceRefs), assistantAt);
    database.prepare(`
      UPDATE copilot_conversations SET updated_at = ? WHERE id = ? AND owner_id = ?
    `).run(assistantAt, conversationId, ownerId);
    return true;
  });
  return save();
}

export function getRecentMessages(database, conversationId, limit = 12) {
  const newestFirst = database.prepare(`
    SELECT role, content FROM copilot_messages
    WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(conversationId, limit);
  const bounded = [];
  let total = 0;
  for (const message of newestFirst) {
    if (total + message.content.length > 12_000) break;
    bounded.push(message);
    total += message.content.length;
  }
  return bounded.reverse();
}

export function deleteConversation(database, ownerId, conversationId) {
  return database.prepare(`
    DELETE FROM copilot_conversations WHERE id = ? AND owner_id = ?
  `).run(conversationId, ownerId).changes === 1;
}

export function clearConversation(database, ownerId, conversationId) {
  const clear = database.transaction(() => {
    const exists = database.prepare(`
      SELECT id FROM copilot_conversations WHERE id = ? AND owner_id = ?
    `).get(conversationId, ownerId);
    if (!exists) return false;
    database.prepare("DELETE FROM copilot_messages WHERE conversation_id = ?").run(conversationId);
    database.prepare("UPDATE copilot_conversations SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), conversationId);
    return true;
  });
  return clear();
}
