'use strict';

// Camada de dados Postgres (repositório). Substitui a persistência em JSON do
// projeto original: tasks/messages em tabelas, arquivos como bytea, e o salt do
// E2EE numa tabela de config. Todo conteúdo continua cifrado E2EE pelo cliente —
// o banco (como antes o JSON) só guarda ciphertext, nunca o plaintext.

const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Fly Postgres interno é sem TLS; provedores externos usam TLS. Controlado por env.
  ssl: /^(1|true|require)$/i.test(process.env.DATABASE_SSL || '') ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
});

pool.on('error', (err) => console.error('[db] erro no pool:', err.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq        BIGSERIAL PRIMARY KEY,
  id         TEXT NOT NULL,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  side       TEXT NOT NULL,
  type       TEXT NOT NULL,
  text       TEXT,
  author     TEXT,
  respond_by TEXT,
  agent_mode BOOLEAN NOT NULL DEFAULT false,
  file_name  TEXT,
  file_size  BIGINT,
  file_path  TEXT,
  timestamp  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, seq);
CREATE TABLE IF NOT EXISTS files (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  size    BIGINT NOT NULL,
  data    BYTEA NOT NULL,
  PRIMARY KEY (task_id, name)
);
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

async function initSchema() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não definida.');
  await pool.query(SCHEMA);
}

// ── Salt do E2EE (público por design) — mora na tabela config, criado uma vez ──
async function loadOrCreateSalt() {
  const { rows } = await pool.query(`SELECT value FROM config WHERE key = 'e2ee_salt'`);
  if (rows.length) return Buffer.from(rows[0].value, 'base64');
  const salt = crypto.randomBytes(32);
  await pool.query(
    `INSERT INTO config (key, value) VALUES ('e2ee_salt', $1) ON CONFLICT (key) DO NOTHING`,
    [salt.toString('base64')]
  );
  // Corrida improvável: reconsulta caso outro processo tenha inserido primeiro.
  const again = await pool.query(`SELECT value FROM config WHERE key = 'e2ee_salt'`);
  return Buffer.from(again.rows[0].value, 'base64');
}

// ── Mapeadores linha->objeto (mesma forma que o front/bridge esperam) ──
function rowToMessage(r) {
  const m = { id: r.id, side: r.side, type: r.type, text: r.text, author: r.author, timestamp: r.timestamp };
  if (r.type === 'file') { m.fileName = r.file_name; m.fileSize = Number(r.file_size); m.filePath = r.file_path; }
  if (r.side === 'input') {
    if (r.respond_by) m.respondBy = r.respond_by;
    if (r.agent_mode) m.agentMode = true;
  }
  return m;
}

function rowToMeta(r) {
  const hasLast = r.lm_id != null;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: Number(r.message_count),
    lastMessage: hasLast ? {
      text: r.lm_text,
      side: r.lm_side,
      type: r.lm_type,
      timestamp: r.lm_timestamp,
      author: r.lm_author,
      respondBy: r.lm_respond_by || undefined,
      fileName: r.lm_file_name || undefined,
      agentMode: r.lm_agent_mode || undefined,
    } : null,
  };
}

const META_SELECT = `
  SELECT t.id, t.title, t.status, t.created_at, t.updated_at,
         (SELECT count(*) FROM messages m WHERE m.task_id = t.id) AS message_count,
         lm.id AS lm_id, lm.side AS lm_side, lm.type AS lm_type, lm.text AS lm_text,
         lm.author AS lm_author, lm.respond_by AS lm_respond_by, lm.agent_mode AS lm_agent_mode,
         lm.file_name AS lm_file_name, lm.timestamp AS lm_timestamp
  FROM tasks t
  LEFT JOIN LATERAL (
    SELECT * FROM messages m WHERE m.task_id = t.id ORDER BY m.seq DESC LIMIT 1
  ) lm ON true
`;

async function listTaskMetas() {
  const { rows } = await pool.query(`${META_SELECT} ORDER BY t.updated_at DESC`);
  return rows.map(rowToMeta);
}

async function getTaskMeta(id) {
  const { rows } = await pool.query(`${META_SELECT} WHERE t.id = $1`, [id]);
  return rows.length ? rowToMeta(rows[0]) : null;
}

async function taskExists(id) {
  const { rows } = await pool.query(`SELECT 1 FROM tasks WHERE id = $1`, [id]);
  return rows.length > 0;
}

async function getMessages(id) {
  const { rows } = await pool.query(`SELECT * FROM messages WHERE task_id = $1 ORDER BY seq ASC`, [id]);
  return rows.map(rowToMessage);
}

async function createTask(id, title, ts) {
  await pool.query(
    `INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ($1, $2, 'open', $3, $3)`,
    [id, title, ts]
  );
  return getTaskMeta(id);
}

async function updateTask(id, fields, ts) {
  const sets = [], vals = [];
  if (fields.title !== undefined) { vals.push(fields.title); sets.push(`title = $${vals.length}`); }
  if (fields.status !== undefined) { vals.push(fields.status); sets.push(`status = $${vals.length}`); }
  vals.push(ts); sets.push(`updated_at = $${vals.length}`);
  vals.push(id);
  const { rowCount } = await pool.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  if (!rowCount) return null;
  return getTaskMeta(id);
}

async function deleteTask(id) {
  const { rowCount } = await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]); // cascata: messages + files
  return rowCount > 0;
}

// Insere a mensagem e "toca" o updated_at da task. Retorna { msg, meta }.
async function addMessage(taskId, msg) {
  await pool.query(
    `INSERT INTO messages (id, task_id, side, type, text, author, respond_by, agent_mode, file_name, file_size, file_path, timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [msg.id, taskId, msg.side, msg.type, msg.text ?? null, msg.author ?? null,
     msg.respondBy ?? null, msg.agentMode === true, msg.fileName ?? null,
     msg.fileSize ?? null, msg.filePath ?? null, msg.timestamp]
  );
  await pool.query(`UPDATE tasks SET updated_at = $1 WHERE id = $2`, [msg.timestamp, taskId]);
  return { msg, meta: await getTaskMeta(taskId) };
}

async function clearMessages(taskId, ts) {
  await pool.query(`DELETE FROM messages WHERE task_id = $1`, [taskId]); // arquivos: cascata separada abaixo
  await pool.query(`DELETE FROM files WHERE task_id = $1`, [taskId]);
  await pool.query(`UPDATE tasks SET updated_at = $1 WHERE id = $2`, [ts, taskId]);
  return getTaskMeta(taskId);
}

// ── Arquivos (bytea) ──
function splitName(original) {
  const dot = original.lastIndexOf('.');
  const ext = dot > 0 ? original.slice(dot) : '';
  const base = (dot > 0 ? original.slice(0, dot) : original).replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
  return { base, ext };
}

async function uniqueFilename(taskId, original) {
  const { rows } = await pool.query(`SELECT name FROM files WHERE task_id = $1`, [taskId]);
  const taken = new Set(rows.map((r) => r.name));
  const { base, ext } = splitName(original);
  let name = `${base}${ext}`, counter = 2;
  while (taken.has(name)) { name = `${base}-${counter}${ext}`; counter++; }
  return name;
}

async function saveFile(taskId, name, size, buf) {
  await pool.query(
    `INSERT INTO files (task_id, name, size, data) VALUES ($1,$2,$3,$4)
     ON CONFLICT (task_id, name) DO UPDATE SET size = EXCLUDED.size, data = EXCLUDED.data`,
    [taskId, name, size, buf]
  );
}

async function listFiles(taskId) {
  const { rows } = await pool.query(`SELECT name, size FROM files WHERE task_id = $1 ORDER BY name`, [taskId]);
  return rows.map((r) => ({ name: r.name, size: Number(r.size) }));
}

async function getFile(taskId, name) {
  const { rows } = await pool.query(`SELECT size, data FROM files WHERE task_id = $1 AND name = $2`, [taskId, name]);
  return rows.length ? { size: Number(rows[0].size), data: rows[0].data } : null;
}

async function deleteFile(taskId, name) {
  await pool.query(`DELETE FROM files WHERE task_id = $1 AND name = $2`, [taskId, name]);
}

async function deleteTaskFiles(taskId) {
  await pool.query(`DELETE FROM files WHERE task_id = $1`, [taskId]);
}

module.exports = {
  pool, initSchema, loadOrCreateSalt,
  listTaskMetas, getTaskMeta, taskExists, getMessages,
  createTask, updateTask, deleteTask, addMessage, clearMessages,
  uniqueFilename, saveFile, listFiles, getFile, deleteFile, deleteTaskFiles,
};
