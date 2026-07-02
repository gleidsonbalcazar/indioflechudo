'use strict';

/**
 * Clipboard Relay — Bridge (caminho B: chat puro via Claude Code CLI)
 * ------------------------------------------------------------------
 * Worker headless que age como "mais um cliente" do relay:
 *   1. faz login e deriva a MESMA chave AES-GCM (E2EE preservado — o servidor
 *      continua cego, este processo é que tem a chave).
 *   2. escuta mensagens novas; quando chega uma `side=input` (texto), decifra,
 *      pergunta ao Claude e posta a resposta de volta como `side=response`.
 *
 * Backend = `claude -p` (sua assinatura do Claude Code, SEM custo de API).
 * Chat puro: roda com `--tools ""`, então NUNCA toca filesystem/bash — o
 * cliente remoto só recebe texto.
 *
 * Memória por task: cada task vira uma sessão do Claude Code (UUID determinístico
 * derivado do taskId). 1ª mensagem cria com --session-id; as seguintes usam
 * --resume, então o Claude lembra o contexto (inclusive após restart do worker).
 *
 * Precisa rodar NO HOST (onde o `claude` está instalado e autenticado):
 *   cd bridge && node --env-file=../.env bridge.js
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

// ── Config ──
const RELAY_URL = process.env.RELAY_URL || 'http://localhost:3000';
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || ''; // vazio = default do Claude Code
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '180000', 10);
// Batida do keepalive de status (re-emite "trabalhando" pro front não dar timeout).
const KEEPALIVE_MS = parseInt(process.env.KEEPALIVE_MS || '120000', 10);
// Diretrizes fixas anexadas ao system prompt (override via BRIDGE_SYSTEM_PROMPT).
const SYSTEM_PROMPT = process.env.BRIDGE_SYSTEM_PROMPT || [
  'Diretrizes ao responder:',
  '- NÃO inclua comentários no código que você gerar, a menos que explicitamente solicitado.',
  '- O contexto é C# legado (versão antiga do C#/.NET): prefira código compatível com versões antigas e evite recursos modernos da linguagem, salvo indicação em contrário.',
  '- Seja direto e prático.',
].join('\n');
// Responder a inputs que já existiam antes do bridge subir? Default: não.
const ANSWER_BACKLOG = /^(1|true|yes)$/i.test(process.env.BRIDGE_ANSWER_BACKLOG || '');

// ── Modo agente (ferramentas remotas via MCP -> executor) ──
// Prefixo que liga o modo agente numa task; depois a task fica "grudada".
const AGENT_PREFIX = /^\s*(\/agente|@agente|@repo)\b[ :]*/i;
const MCP_SERVER = path.join(__dirname, '..', 'mcp', 'server.mjs');
const MCP_CONFIG_PATH = path.join(os.tmpdir(), 'relay-mcp-config.json');
const AGENT_TOOLS = ['mcp__relay-tools__list_dir', 'mcp__relay-tools__read_file', 'mcp__relay-tools__glob', 'mcp__relay-tools__grep', 'mcp__relay-tools__write_file', 'mcp__relay-tools__edit_file', 'mcp__relay-tools__run'];
const AGENT_SYSTEM = SYSTEM_PROMPT + '\n\n' + [
  'Você está operando num REPOSITÓRIO REMOTO somente através das ferramentas MCP',
  '(list_dir, read_file, glob, grep, write_file, edit_file, run). NÃO há acesso ao',
  'filesystem local — use SEMPRE essas ferramentas para navegar e ler o código antes de',
  'concluir. Para alterar arquivos use edit_file (trecho exato) ou write_file. Para',
  'compilar/testar/rodar scripts use run (ex.: dotnet build, dotnet test, git status) —',
  'só comandos da allowlist funcionam. CADA escrita E cada run exigem aprovação do usuário',
  'no chat, então faça ações pequenas e objetivas e explique o que vai fazer.',
].join(' ');
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || '600000', 10);
const agentTasks = new Set(); // tasks já em modo agente nesta execução

function writeMcpConfig() {
  const cfg = { mcpServers: { 'relay-tools': { command: process.execPath, args: [MCP_SERVER], env: { RELAY_URL, ACCESS_PASSWORD } } } };
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(cfg));
}

if (!ACCESS_PASSWORD) { console.error('[fatal] ACCESS_PASSWORD não definida.'); process.exit(1); }

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ── E2EE (compatível com o WebCrypto do front: formato `E1.<iv>.<ct||tag>`) ──
const ENC_PREFIX = 'E1.';
let aesKey = null; // Buffer de 32 bytes

function decryptText(packed) {
  if (typeof packed !== 'string' || !packed.startsWith(ENC_PREFIX)) return packed;
  const rest = packed.slice(ENC_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) throw new Error('formato cifrado inválido');
  const iv = Buffer.from(rest.slice(0, dot), 'base64');
  const ctTag = Buffer.from(rest.slice(dot + 1), 'base64');
  // WebCrypto anexa a tag (16 bytes) ao fim do ciphertext; o Node separa.
  const tag = ctTag.subarray(ctTag.length - 16);
  const ct = ctTag.subarray(0, ctTag.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function encryptText(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([c.update(Buffer.from(String(plain), 'utf8')), c.final()]);
  const tag = c.getAuthTag();
  return ENC_PREFIX + iv.toString('base64') + '.' + Buffer.concat([ct, tag]).toString('base64');
}

// Arquivos cifrados pelo front (encryptBlob): bytes crus = iv(12) + ct||tag.
function decryptBuffer(buf) {
  if (buf.length < 12 + 16) throw new Error('arquivo cifrado muito pequeno');
  const iv = buf.subarray(0, 12);
  const ctTag = buf.subarray(12);
  const tag = ctTag.subarray(ctTag.length - 16);
  const ct = ctTag.subarray(0, ctTag.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ── Auth: login -> cookie de sessão; salt -> chave AES ──
async function login() {
  const r = await fetch(RELAY_URL + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ACCESS_PASSWORD }),
  });
  if (!r.ok) throw new Error('login falhou: HTTP ' + r.status);
  const setCookies = (typeof r.headers.getSetCookie === 'function') ? r.headers.getSetCookie() : [];
  let token = null;
  for (const c of setCookies) { const m = /session_token=([^;]+)/.exec(c); if (m) token = m[1]; }
  if (!token) throw new Error('cookie de sessão não recebido');
  return token;
}

async function deriveKey() {
  const r = await fetch(RELAY_URL + '/e2ee-salt');
  if (!r.ok) throw new Error('falha ao buscar salt: HTTP ' + r.status);
  const info = await r.json();
  const salt = Buffer.from(info.salt, 'base64');
  // pbkdf2-sha256 -> 32 bytes (AES-256), espelhando o deriveKey do cliente.
  aesKey = crypto.pbkdf2Sync(ACCESS_PASSWORD, salt, info.iterations, 32, 'sha256');
  log(`chave E2EE derivada (PBKDF2 ${info.iterations} iter)`);
}

// ── Leitura de arquivos (extracao no bridge; claude continua chat-only) ──
const MAX_FILE_CHARS = parseInt(process.env.BRIDGE_MAX_FILE_CHARS || '200000', 10);
const MAX_ZIP_ENTRY = 50000;
// Formatos que o Claude consegue ver como imagem (via Read num arquivo temp).
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const TEXT_EXTS = new Set([
  'txt','md','markdown','csv','tsv','svg','html','htm','xml','json','jsonc',
  'yaml','yml','toml','ini','cfg','conf','properties','env','log','sql','graphql','gql',
  'css','scss','sass','less','js','jsx','mjs','cjs','ts','tsx','vue','svelte','astro',
  'py','rb','php','go','rs','java','kt','kts','c','h','hpp','cpp','cc','cs','swift','sh','bash','zsh','dart','lua',
]);

function extOf(name) { const i = (name || '').lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }
function capText(s, n) { return s.length > n ? s.slice(0, n) + `\n…[truncado, +${s.length - n} chars]` : s; }
function looksTextual(buf) {
  const n = Math.min(buf.length, 1024); let bad = 0;
  for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) bad++; }
  return n === 0 || bad / n < 0.1;
}

async function xlsxToText(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  let out = '';
  wb.eachSheet((ws) => {
    out += `# Planilha: ${ws.name}\n`;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values || []).slice(1).map((v) => {
        if (v == null) return '';
        if (typeof v === 'object') return v.text || v.result || v.hyperlink || JSON.stringify(v);
        return String(v);
      });
      out += vals.join(',') + '\n';
    });
    out += '\n';
  });
  return out;
}

function zipToText(buf) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buf);
  let out = 'Conteúdo do ZIP:\n', total = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const ext = extOf(e.entryName);
    const size = e.header.size;
    if (TEXT_EXTS.has(ext) && total < MAX_FILE_CHARS) {
      const txt = capText(e.getData().toString('utf8'), MAX_ZIP_ENTRY);
      total += txt.length;
      out += `\n===== ${e.entryName} (${size} bytes) =====\n${txt}\n`;
    } else {
      out += `\n----- ${e.entryName} (${size} bytes) [nao extraido] -----\n`;
    }
  }
  return out;
}

async function extractFileContent(name, buf) {
  const ext = extOf(name);
  if (ext === 'xlsx' || ext === 'xlsm') return capText(await xlsxToText(buf), MAX_FILE_CHARS);
  if (ext === 'zip') return capText(zipToText(buf), MAX_FILE_CHARS);
  if (TEXT_EXTS.has(ext) || looksTextual(buf)) return capText(buf.toString('utf8'), MAX_FILE_CHARS);
  return `[arquivo binário "${name}" (${buf.length} bytes), tipo .${ext || '?'} — não dá para ler como texto]`;
}

async function downloadFile(taskId, fileName) {
  const r = await fetch(`${RELAY_URL}/tasks/${taskId}/files/${encodeURIComponent(fileName)}`, {
    headers: { Cookie: `session_token=${sessionToken}` },
  });
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  return decryptBuffer(Buffer.from(await r.arrayBuffer()));
}

// ── Claude Code (claude -p, chat puro, sessão por task) ──
const createdSessions = new Set(); // taskIds cuja sessão já foi criada nesta execução

// UUID v4-shaped determinístico a partir do taskId (mesma task -> mesma sessão).
function taskSessionId(taskId) {
  const b = crypto.createHash('sha256').update('clipboard-relay:' + taskId).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40; // versão 4
  b[8] = (b[8] & 0x3f) | 0x80; // variante RFC4122
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Resume um tool_use do stream em algo curto e legível p/ narrar no front.
// Sem dump de conteúdo grande (ex.: content de write_file): só nome + alvo.
function describeToolUse(name, input) {
  const tool = String(name || '').replace(/^mcp__[^_]+__/, '');
  const i = (input && typeof input === 'object') ? input : {};
  let detail = i.path || i.file || i.file_path || i.pattern || i.command || i.cmd || i.query || '';
  if (!detail) { const k = Object.keys(i)[0]; if (k) detail = i[k]; }
  detail = String(detail == null ? '' : detail).replace(/\s+/g, ' ').slice(0, 140);
  return { kind: 'tool', label: tool, detail };
}

// Traduz um evento NDJSON do claude em narração para o front (via onEvent).
// Só eventos de "ação" (tool_use) e "pensando"; o texto final vai pelo reply().
function narrateStreamEvent(evt, onEvent) {
  if (!evt || typeof evt !== 'object' || typeof onEvent !== 'function') return;
  if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
    for (const b of evt.message.content) {
      if (b && b.type === 'tool_use') onEvent(describeToolUse(b.name, b.input));
      else if (b && b.type === 'thinking') onEvent({ kind: 'thinking' });
    }
  }
}

// Roda o claude com os args de sessão dados (resume ou session-id). Resolve
// sempre (nunca rejeita): { ok, text } ou { ok:false, notFound, error }.
// opts.tools: lista de ferramentas (default "" = nenhuma). opts.permissionMode.
// opts.onEvent(e): se presente, ativa streaming e recebe eventos narrados.
function execClaude(sessionArgs, prompt, opts = {}) {
  return new Promise((resolve) => {
    // Streaming (NDJSON) só quando há onEvent (modo agente): narra tool-use/thinking
    // ao front em tempo real. Sem onEvent (chat puro/arquivo) mantém json one-shot.
    const streaming = typeof opts.onEvent === 'function';
    const args = ['-p', '--output-format', streaming ? 'stream-json' : 'json', '--tools', opts.tools != null ? opts.tools : ''];
    if (streaming) args.push('--verbose'); // exigido p/ stream-json em modo -p
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    if (opts.addDir) args.push('--add-dir', opts.addDir);
    if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
    // Só os MCP do bridge (relay-tools); ignora os MCP globais do host (Figma,
    // Gmail, serena…) — irrelevantes aqui e puro overhead/latência de init.
    args.push('--strict-mcp-config');
    if (opts.allowedTools && opts.allowedTools.length) args.push('--allowedTools', ...opts.allowedTools);
    const sp = opts.systemPrompt || SYSTEM_PROMPT;
    if (sp) args.push('--append-system-prompt', sp);
    if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);
    args.push(...sessionArgs);

    const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ? { ...process.env, ...opts.env } : process.env });
    let out = '', err = '', done = false, lineBuf = '', resultEvt = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(to); resolve(v); } };
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish({ ok: false, error: 'timeout' }); }, opts.timeoutMs || CLAUDE_TIMEOUT_MS);

    // Consome uma linha NDJSON: guarda o evento `result`, narra os intermediários.
    const consumeLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let evt; try { evt = JSON.parse(s); } catch (_) { return; }
      if (evt && evt.type === 'result') { resultEvt = evt; return; }
      try { narrateStreamEvent(evt, opts.onEvent); } catch (_) {} // nunca derruba o turno
    };

    child.stdout.on('data', d => {
      out += d;
      if (!streaming) return;
      lineBuf += d;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) { consumeLine(lineBuf.slice(0, nl)); lineBuf = lineBuf.slice(nl + 1); }
    });
    child.stderr.on('data', d => err += d);
    child.on('error', e => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (streaming && lineBuf.trim()) consumeLine(lineBuf); // linha final sem \n
      const combined = out + '\n' + err;
      const notFound = /No conversation found/i.test(combined);
      let j = resultEvt;
      if (!j && !streaming) { try { j = JSON.parse(out.trim()); } catch (_) {} }
      if (j && typeof j.result === 'string' && !j.is_error) { finish({ ok: true, text: j.result }); return; }
      // is_error: o claude põe a mensagem legível em j.result (ex.: limite de
      // sessão). Preferimos ela ao JSON cru; marcamos limite de sessão à parte.
      const cleanResult = j && typeof j.result === 'string' ? j.result.trim() : '';
      const sessionLimit = (j && j.api_error_status === 429) || /session limit|usage limit|limit reached/i.test(combined);
      const error = (cleanResult || err || out || ('exit ' + code)).trim().slice(0, 500);
      finish({ ok: false, notFound, sessionLimit, error });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Constrói um Error preservando flags da falha (ex.: sessionLimit) p/ formatação.
function failErr(r) { const e = new Error(r.error); e.sessionLimit = !!r.sessionLimit; return e; }

// Pergunta ao Claude mantendo memória da task. Tenta --resume; se a sessão
// ainda não existe (1ª mensagem ou nunca criada), cria com --session-id.
async function askClaude(taskId, prompt, opts = {}) {
  const sid = taskSessionId(taskId);
  if (createdSessions.has(taskId)) {
    const r = await execClaude(['--resume', sid], prompt, opts);
    if (r.ok) return r.text;
    if (!r.notFound) throw failErr(r);
    // sessão sumiu — recria abaixo
  } else {
    const r = await execClaude(['--resume', sid], prompt, opts); // pode existir de execução anterior
    if (r.ok) { createdSessions.add(taskId); return r.text; }
    if (!r.notFound) throw failErr(r);
  }
  const c = await execClaude(['--session-id', sid], prompt, opts);
  if (!c.ok) throw failErr(c);
  createdSessions.add(taskId);
  return c.text;
}

// ── Socket / loop principal ──
let socket = null;
let sessionToken = null;
const seen = new Map();     // taskId -> timestamp ISO do último input já tratado
const pending = new Map();  // taskId -> lastMessage meta a processar
const queue = [];
let processing = false;

function reply(taskId, text) {
  socket.emit('message:send', { taskId, side: 'response', text: encryptText(text), author: 'claude' });
  log(`task ${taskId}: resposta enviada (${text.length} chars)`);
}

// Status efemero (Claude trabalhando) — fases genericas, sem conteudo sensivel.
function status(taskId, phase) { try { socket.emit('task:status', { taskId, phase }); } catch (_) {} }

// Evento de narração do agente (tool-use/thinking), CIFRADO fim-a-fim: o relay
// só repassa opaco p/ a sala da task (mesmo padrão de agent:rpc/approval).
function emitAgentEvent(taskId, e) {
  try { socket.emit('agent:event', { taskId, enc: encryptText(JSON.stringify(e)) }); } catch (_) {}
}

// Transforma uma falha do claude em mensagem limpa pro chat. Trata limite de
// sessão (429) à parte: extrai o horário de reset se o claude o informar.
function formatClaudeError(err) {
  const msg = (err && err.message) || 'erro desconhecido';
  if (err && err.sessionLimit) {
    const m = msg.match(/resets?\s+(.+?)(?:\.|$)/i);
    const quando = m ? ` Reseta ${m[1].trim()}.` : '';
    return `⏳ Limite de sessão do Claude atingido.${quando} Tente novamente depois disso.`;
  }
  if (/timeout/i.test(msg)) return '⏱️ O Claude demorou demais e a requisição expirou. Tente uma tarefa menor ou reenvie.';
  return '⚠️ Erro ao consultar o Claude: ' + msg;
}

async function handleTask(taskId) {
  const lm = pending.get(taskId);
  if (!lm) return;
  const seenTs = seen.get(taskId);
  if (seenTs && new Date(lm.timestamp) <= new Date(seenTs)) return; // já tratado

  let prompt, opts = {}, cleanup = null;
  try {
    if (lm.type === 'file') {
      status(taskId, 'reading');
      ({ prompt, opts, cleanup } = await prepareFileRequest(taskId, lm));
    } else {
      prompt = decryptText(lm.text);
      // Modo agente: pelo toggle (lm.agentMode) OU prefixo; depois fica grudado.
      const m = prompt.match(AGENT_PREFIX);
      if (m) { prompt = prompt.slice(m[0].length); }
      if (m || lm.agentMode === true) agentTasks.add(taskId);
      if (agentTasks.has(taskId)) {
        opts = { tools: '', mcpConfig: MCP_CONFIG_PATH, allowedTools: AGENT_TOOLS, permissionMode: 'dontAsk', systemPrompt: AGENT_SYSTEM, env: { AGENT_TASK_ID: taskId }, timeoutMs: AGENT_TIMEOUT_MS, onEvent: (e) => emitAgentEvent(taskId, e) };
      }
    }
  } catch (err) {
    log(`task ${taskId}: erro preparando prompt:`, err.message);
    reply(taskId, '⚠️ Erro ao processar o arquivo: ' + err.message);
    seen.set(taskId, lm.timestamp);
    return;
  }
  if (!prompt || !prompt.trim()) { if (cleanup) cleanup(); return; }

  log(`task ${taskId}: -> claude (${prompt.length} chars${lm.type === 'file' ? ', arquivo' : ''})`);
  // Keepalive: re-emite o status periodicamente enquanto o claude roda, pra que
  // o indicador "Claude trabalhando" não suma no front em tasks longas (agente
  // pode levar minutos). Reseta o safety-timeout do cliente a cada batida.
  const phase = agentTasks.has(taskId) ? 'working' : 'thinking';
  status(taskId, phase);
  const keepalive = setInterval(() => status(taskId, phase), KEEPALIVE_MS);
  try {
    const answer = await askClaude(taskId, prompt, opts);
    reply(taskId, answer);
  } catch (err) {
    log(`task ${taskId}: erro no claude:`, err.message);
    reply(taskId, formatClaudeError(err));
  } finally {
    clearInterval(keepalive);
    if (cleanup) cleanup();
  }
  seen.set(taskId, lm.timestamp);
}

// Prepara a requisição a partir de um arquivo: baixa+decifra. Imagens viram um
// arquivo temporário que o Claude lê com a ferramenta Read (só leitura); os
// demais tipos têm o conteúdo extraído como texto (chat puro, sem ferramentas).
// Retorna { prompt, opts, cleanup }.
async function prepareFileRequest(taskId, lm) {
  if (!lm.fileName) throw new Error('arquivo sem fileName');
  let name = lm.fileName, caption = '';
  try { const o = JSON.parse(decryptText(lm.text)); name = o.n || name; caption = o.c || ''; } catch (_) {}
  const buf = await downloadFile(taskId, lm.fileName);
  const ext = extOf(name);

  if (IMAGE_EXTS.has(ext)) {
    const dir = os.tmpdir();
    const tmp = path.join(dir, `relay-img-${crypto.randomBytes(6).toString('hex')}.${ext}`);
    fs.writeFileSync(tmp, buf);
    const instr = caption.trim() || 'Veja esta imagem e descreva/analise o conteúdo.';
    return {
      // Read só leitura + add-dir do temp (em dontAsk, ler fora do cwd exige isso).
      prompt: `${instr}\n\n(imagem: ${name})\nAbra e veja a imagem em: ${tmp}\nUse a ferramenta Read nesse caminho para enxergá-la.`,
      opts: { tools: 'Read', permissionMode: 'dontAsk', addDir: dir },
      cleanup: () => { try { fs.unlinkSync(tmp); } catch (_) {} },
    };
  }

  const content = await extractFileContent(name, buf);
  const instr = caption.trim() || 'Leia e analise o conteúdo deste arquivo. Resuma e trate conforme fizer sentido.';
  return { prompt: `${instr}\n\n--- arquivo: ${name} ---\n${content}`, opts: {}, cleanup: null };
}

function enqueue(taskId) {
  if (!queue.includes(taskId)) queue.push(taskId);
  pump();
}

async function pump() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const taskId = queue.shift();
    try { await handleTask(taskId); }
    catch (err) { log(`task ${taskId}: falha`, err.message); }
  }
  processing = false;
}

function onMeta(meta) {
  if (!meta || !meta.id) return;
  const lm = meta.lastMessage;
  if (!lm || lm.side !== 'input') return; // só reagimos a pedidos do cliente
  if (lm.respondBy === 'human') return;   // o usuário vai responder manualmente
  const seenTs = seen.get(meta.id);
  if (seenTs && new Date(lm.timestamp) <= new Date(seenTs)) return;
  pending.set(meta.id, lm);
  status(meta.id, 'working'); // feedback imediato no cliente (mesmo se enfileirado)
  enqueue(meta.id);
}

async function seedSeen() {
  if (ANSWER_BACKLOG) { log('backlog: respondendo inputs pré-existentes'); return; }
  const r = await fetch(RELAY_URL + '/tasks', { headers: { Cookie: `session_token=${sessionToken}` } });
  if (!r.ok) return;
  const tasks = await r.json();
  for (const t of tasks) if (t.lastMessage) seen.set(t.id, t.lastMessage.timestamp);
  log(`backlog ignorado: ${tasks.length} task(s) marcadas como vistas`);
}

function connect() {
  socket = io(RELAY_URL, {
    extraHeaders: { Cookie: `session_token=${sessionToken}` },
    reconnection: true,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => log('conectado ao relay'));
  socket.on('disconnect', (reason) => log('desconectado:', reason));
  socket.on('task:updated', onMeta);
  socket.on('task:created', onMeta);

  socket.on('connect_error', async (err) => {
    if (err && /unauthorized/i.test(err.message || '')) {
      log('sessão expirada — refazendo login');
      try {
        sessionToken = await login();
        socket.io.opts.extraHeaders = { Cookie: `session_token=${sessionToken}` };
      } catch (e) { log('relogin falhou:', e.message); }
    } else {
      log('erro de conexão:', err && err.message);
    }
  });
}

async function main() {
  log(`bridge iniciando — relay=${RELAY_URL} backend=claude(${CLAUDE_MODEL || 'default'})`);
  try { writeMcpConfig(); } catch (e) { log('aviso: falha ao gerar mcp-config:', e.message); }
  sessionToken = await login();
  await deriveKey();
  await seedSeen();
  connect();
  log('bridge pronto — aguardando mensagens (side=input).');
}

function shutdown() { log('encerrando...'); try { socket && socket.close(); } catch (_) {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(err => { console.error('[fatal]', err); process.exit(1); });
