// MCP server (roda no Mac, lançado pelo `claude`). Expõe ferramentas read-only
// que, em vez de tocar no Mac, encaminham cada chamada pelo relay até o executor
// na máquina do codebase. IMPORTANTE: stdout é o canal do protocolo MCP — todo
// log vai para stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { io } from 'socket.io-client';
import crypto from 'node:crypto';

const RELAY = process.env.RELAY_URL || 'http://localhost:3998';
const PASSWORD = process.env.ACCESS_PASSWORD;
const RPC_TIMEOUT_MS = parseInt(process.env.AGENT_RPC_TIMEOUT_MS || '30000', 10);
const log = (...a) => console.error('[mcp]', ...a);

if (!PASSWORD) { log('ACCESS_PASSWORD ausente'); process.exit(1); }

// ── E2EE (formato E1.<iv>.<ct||tag>) ──
const ENC = 'E1.';
let key = null;
function enc(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return ENC + iv.toString('base64') + '.' + Buffer.concat([ct, c.getAuthTag()]).toString('base64');
}
function dec(packed) {
  const rest = packed.slice(ENC.length), dot = rest.indexOf('.');
  const iv = Buffer.from(rest.slice(0, dot), 'base64');
  const ctTag = Buffer.from(rest.slice(dot + 1), 'base64');
  const tag = ctTag.subarray(ctTag.length - 16), ct = ctTag.subarray(0, ctTag.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

// ── Conexão com o relay ──
let socket = null;
const pending = new Map();

async function connectRelay() {
  const lr = await fetch(RELAY + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  if (!lr.ok) throw new Error('login HTTP ' + lr.status);
  const cookie = (lr.headers.getSetCookie?.() || []).find((c) => c.startsWith('session_token='))?.split(';')[0];
  if (!cookie) throw new Error('sem cookie');
  const info = await (await fetch(RELAY + '/e2ee-salt')).json();
  key = crypto.pbkdf2Sync(PASSWORD, Buffer.from(info.salt, 'base64'), info.iterations, 32, 'sha256');

  socket = io(RELAY, { extraHeaders: { Cookie: cookie }, transports: ['websocket'], reconnection: true });
  socket.on('connect', () => { socket.emit('agent:join'); log('conectado ao relay (agent:main)'); });
  socket.on('disconnect', (r) => log('desconectado:', r));
  socket.on('agent:rpc:result', (m) => {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.to); try { p.resolve(dec(m.enc)); } catch (e) { p.resolve({ error: 'falha ao decifrar resultado' }); } }
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout conectando no relay')), 20000);
    socket.on('connect', () => { clearTimeout(t); res(); });
    socket.on('connect_error', (e) => { clearTimeout(t); rej(e); });
  });
}

const TASK_ID = process.env.AGENT_TASK_ID || '';
function rpc(method, params, timeoutMs) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) return resolve({ error: 'executor/relay desconectado' });
    const id = crypto.randomUUID();
    const to = setTimeout(() => { pending.delete(id); resolve({ error: 'timeout: o executor não respondeu (ele está rodando na máquina do codebase?)' }); }, timeoutMs || RPC_TIMEOUT_MS);
    pending.set(id, { resolve, to });
    socket.emit('agent:rpc', { id, enc: enc({ method, params }) });
  });
}

function toText(r) {
  if (r && r.error) return { content: [{ type: 'text', text: 'ERRO: ' + r.error }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(r.result ?? r, null, 2) }] };
}

// ── MCP server + ferramentas (read-only) ──
const server = new McpServer({ name: 'relay-tools', version: '1.0.0' });

server.registerTool('list_dir',
  { description: 'Lista um diretório do repositório remoto.', inputSchema: { path: z.string().optional().describe('caminho relativo (default: raiz)') } },
  async ({ path }) => toText(await rpc('list_dir', { path: path || '.' })));

server.registerTool('read_file',
  { description: 'Lê um arquivo de texto do repositório remoto.', inputSchema: { path: z.string().describe('caminho relativo do arquivo'), maxBytes: z.number().optional() } },
  async ({ path, maxBytes }) => toText(await rpc('read_file', { path, maxBytes })));

server.registerTool('glob',
  { description: 'Lista arquivos por padrão glob (ex.: **/*.cs).', inputSchema: { pattern: z.string() } },
  async ({ pattern }) => toText(await rpc('glob', { pattern })));

server.registerTool('grep',
  { description: 'Busca por regex no conteúdo dos arquivos do repo remoto.', inputSchema: { pattern: z.string(), pathGlob: z.string().optional() } },
  async ({ pattern, pathGlob }) => toText(await rpc('grep', { pattern, pathGlob })));

// Escrita: o usuário aprova o diff no chat antes de aplicar (gate no executor).
server.registerTool('write_file',
  { description: 'Cria ou sobrescreve um arquivo no repo remoto. Requer aprovação do usuário no chat.', inputSchema: { path: z.string(), content: z.string() } },
  async ({ path, content }) => toText(await rpc('write_file', { path, content, taskId: TASK_ID }, 150000)));

server.registerTool('edit_file',
  { description: 'Substitui um trecho exato (oldString -> newString) num arquivo do repo remoto. Requer aprovação do usuário. Use um oldString único, ou replaceAll.', inputSchema: { path: z.string(), oldString: z.string(), newString: z.string(), replaceAll: z.boolean().optional() } },
  async ({ path, oldString, newString, replaceAll }) => toText(await rpc('edit_file', { path, oldString, newString, replaceAll, taskId: TASK_ID }, 150000)));

server.registerTool('run',
  { description: 'Roda um comando no repo remoto (ex.: dotnet build, dotnet test, git status). Só comandos da allowlist e COM aprovação do usuário. Retorna exitCode/stdout/stderr.', inputSchema: { command: z.string(), cwd: z.string().optional() } },
  async ({ command, cwd }) => toText(await rpc('run', { command, cwd, taskId: TASK_ID }, 200000)));

(async () => {
  try { await connectRelay(); } catch (e) { log('falha ao conectar no relay:', e.message); }
  await server.connect(new StdioServerTransport());
  log('MCP pronto (stdio)');
})();
