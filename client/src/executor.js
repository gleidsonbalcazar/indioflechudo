'use strict';

/**
 * executor — as "mãos" do agente, roda na máquina onde o codebase vive.
 * Conecta no relay (sala agent:main), recebe chamadas de ferramenta do MCP
 * server (que fica no Mac, junto do Claude), executa LOCALMENTE no REPO_DIR e
 * devolve o resultado. Tudo cifrado E2EE (o relay só vê ciphertext).
 *
 * Fatia 1 = SOMENTE LEITURA: list_dir, read_file, glob, grep. Nada de escrever
 * ou rodar comandos ainda.
 *
 * Uso (na máquina corporativa):
 *   node --use-system-ca executor.js <senha> <repoDir> [proxyUrl] [relayUrl]
 * Ex.:
 *   node --use-system-ca executor.js MinhaSenha@2026 C:\repo http://proxy:8080
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { io } = require('socket.io-client');

// Posicionais ignoram flags (ex.: --write pode vir em qualquer posição).
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PASSWORD = ARGS[0] || process.env.RELAY_PASSWORD;
const REPO_DIR = path.resolve(ARGS[1] || process.env.REPO_DIR || '.');
const PROXY = ARGS[2] || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const RELAY = ARGS[3] || process.env.RELAY_URL || 'https://your-app.fly.dev';
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

const MAX_READ = 400 * 1024;     // cap por arquivo lido
const MAX_HITS = 300;            // cap de resultados em grep/glob
const IGNORE = new Set(['node_modules', '.git', 'bin', 'obj', '.vs', 'packages', 'dist']);
// Escrita só é permitida se o executor subir com --write (ou AGENT_WRITE=1).
const ALLOW_WRITE = process.argv.includes('--write') || /^(1|true|yes)$/i.test(process.env.AGENT_WRITE || '');
// Execução de comandos só com --run (ou AGENT_RUN=1). Allowlist do 1º token.
const ALLOW_RUN = process.argv.includes('--run') || /^(1|true|yes)$/i.test(process.env.AGENT_RUN || '');
const RUN_ALLOWLIST = (process.env.RUN_ALLOW || 'dotnet,git,msbuild,nuget,sqlcmd,where,dir,type,findstr')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS || '120000', 10);
const RUN_MAX_OUT = 100 * 1024;

if (!PASSWORD) { console.error('Uso: node --use-system-ca executor.js <senha> <repoDir> [proxy] [relay]'); process.exit(1); }

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ── E2EE (mesmo formato E1.<iv>.<ct||tag> do resto do sistema) ──
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

// ── Caminho seguro (nunca sai do REPO_DIR) ──
function safe(rel) {
  const p = path.resolve(REPO_DIR, rel || '.');
  if (p !== REPO_DIR && !p.startsWith(REPO_DIR + path.sep)) throw new Error('caminho fora do repo');
  return p;
}
function walk(dir, out, depth) {
  if (depth > 25 || out.length >= 5000) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') { /* permite ocultos? pula só ignorados */ }
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile()) out.push(full);
  }
}
function globToRe(p) {
  // `**/` casa zero+ diretorios (inclui raiz); `**` qualquer coisa; `*` dentro de
  // um segmento; `?` um char.
  const esc = p
    .replace(/[.+^${}()|[\]\\]/g, function (m) { return '\\' + m; })
    .replace(/\*\*\//g, ' DS ')
    .replace(/\*\*/g, ' DD ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .split(' DS ').join('(?:.*/)?')
    .split(' DD ').join('.*');
  return new RegExp('^' + esc + '$', 'i');
}

// ── Aprovação humana (gate de escrita) ──
let socket = null;
const approvals = new Map();
let apSeq = 0;
const APPROVAL_TIMEOUT_MS = 120000;
function awaitApproval(taskId, summary) {
  return new Promise((resolve) => {
    if (!taskId || !socket) return resolve(false);
    const id = 'ap' + (++apSeq);
    const to = setTimeout(() => { approvals.delete(id); resolve(false); }, APPROVAL_TIMEOUT_MS);
    approvals.set(id, { resolve, to });
    socket.emit('agent:approval:request', { taskId, id, enc: enc(summary) });
    log(`aprovação solicitada (${summary.kind} ${summary.path})`);
  });
}

// ── Métodos ──
const methods = {
  list_dir({ path: rel }) {
    const dir = safe(rel || '.');
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: e.isFile() ? (fs.statSync(path.join(dir, e.name)).size) : undefined,
    }));
  },
  read_file({ path: rel, maxBytes }) {
    const f = safe(rel);
    const buf = fs.readFileSync(f);
    const cap = Math.min(maxBytes || MAX_READ, MAX_READ);
    const truncated = buf.length > cap;
    return { path: rel, size: buf.length, truncated, content: buf.subarray(0, cap).toString('utf8') };
  },
  glob({ pattern }) {
    const re = globToRe(pattern);
    const files = []; walk(REPO_DIR, files, 0);
    const hits = files.map((f) => path.relative(REPO_DIR, f).split(path.sep).join('/'))
      .filter((rel) => re.test(rel)).slice(0, MAX_HITS);
    return { pattern, count: hits.length, files: hits };
  },
  grep({ pattern, pathGlob }) {
    const re = new RegExp(pattern, 'i');
    const fileRe = pathGlob ? globToRe(pathGlob) : null;
    const files = []; walk(REPO_DIR, files, 0);
    const hits = [];
    for (const f of files) {
      const rel = path.relative(REPO_DIR, f).split(path.sep).join('/');
      if (fileRe && !fileRe.test(rel)) continue;
      let txt; try { const st = fs.statSync(f); if (st.size > MAX_READ) continue; txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      const lines = txt.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { hits.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) }); if (hits.length >= MAX_HITS) return { pattern, count: hits.length, hits, capped: true }; }
      }
    }
    return { pattern, count: hits.length, hits };
  },
  async write_file({ path: rel, content, taskId }) {
    if (!ALLOW_WRITE) return { error: 'escrita desabilitada — suba o executor com --write' };
    const f = safe(rel);
    const exists = fs.existsSync(f);
    const text = String(content == null ? '' : content);
    const ok = await awaitApproval(taskId, { kind: 'write', path: rel, exists, bytes: Buffer.byteLength(text, 'utf8'), preview: text.slice(0, 2000) });
    if (!ok) return { error: 'edição rejeitada ou aprovação expirada' };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text, 'utf8');
    log(`write_file aplicado: ${rel}`);
    return { ok: true, path: rel, bytes: Buffer.byteLength(text, 'utf8'), created: !exists };
  },
  async edit_file({ path: rel, oldString, newString, replaceAll, taskId }) {
    if (!ALLOW_WRITE) return { error: 'escrita desabilitada — suba o executor com --write' };
    const f = safe(rel);
    const txt = fs.readFileSync(f, 'utf8');
    if (typeof oldString !== 'string' || !oldString) return { error: 'oldString vazio' };
    const count = txt.split(oldString).length - 1;
    if (count === 0) return { error: 'oldString não encontrado no arquivo' };
    if (count > 1 && !replaceAll) return { error: `oldString aparece ${count}x; use replaceAll ou um trecho único` };
    const ns = String(newString == null ? '' : newString);
    const ok = await awaitApproval(taskId, { kind: 'edit', path: rel, old: oldString.slice(0, 1500), new: ns.slice(0, 1500), count: replaceAll ? count : 1 });
    if (!ok) return { error: 'edição rejeitada ou aprovação expirada' };
    const out = replaceAll ? txt.split(oldString).join(ns) : txt.replace(oldString, ns);
    fs.writeFileSync(f, out, 'utf8');
    log(`edit_file aplicado: ${rel} (${replaceAll ? count : 1}x)`);
    return { ok: true, path: rel, replacements: replaceAll ? count : 1 };
  },
  async run({ command, cwd, taskId }) {
    if (!ALLOW_RUN) return { error: 'execução desabilitada — suba o executor com --run' };
    if (typeof command !== 'string' || !command.trim()) return { error: 'comando vazio' };
    const first = command.trim().split(/\s+/)[0].toLowerCase().replace(/\.exe$/, '');
    if (!RUN_ALLOWLIST.includes(first)) return { error: `comando "${first}" não está na allowlist (${RUN_ALLOWLIST.join(', ')})` };
    const wd = cwd ? safe(cwd) : REPO_DIR;
    const ok = await awaitApproval(taskId, { kind: 'run', command: command.slice(0, 1000), cwd: path.relative(REPO_DIR, wd) || '.' });
    if (!ok) return { error: 'execução rejeitada ou aprovação expirada' };
    log(`run: ${command}`);
    return await new Promise((resolve) => {
      const child = spawn(command, { cwd: wd, shell: true });
      let out = '', err = '', killed = false;
      const to = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, RUN_TIMEOUT_MS);
      child.stdout.on('data', (d) => { if (out.length < RUN_MAX_OUT) out += d; });
      child.stderr.on('data', (d) => { if (err.length < RUN_MAX_OUT) err += d; });
      child.on('error', (e) => { clearTimeout(to); resolve({ error: 'falha ao executar: ' + e.message }); });
      child.on('close', (code) => {
        clearTimeout(to);
        resolve({ ok: !killed, exitCode: code, killed, stdout: out.slice(0, RUN_MAX_OUT), stderr: err.slice(0, RUN_MAX_OUT) });
      });
    });
  },
};

// ── Auth ──
function httpJson(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({ method, host: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, headers: { ...headers, 'ngrok-skip-browser-warning': '1' }, agent: isHttps ? agent : undefined, timeout: 20000 }, (res) => {
      let data = ''; res.on('data', (d) => data += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

async function main() {
  log(`executor — repo=${REPO_DIR} relay=${RELAY} proxy=${PROXY || '(nenhum)'}`);
  if (!fs.existsSync(REPO_DIR)) { console.error('REPO_DIR não existe:', REPO_DIR); process.exit(1); }
  const lr = await httpJson('POST', RELAY + '/login', { 'Content-Type': 'application/json' }, JSON.stringify({ password: PASSWORD }));
  if (lr.status !== 200) { console.error('login falhou:', lr.status); process.exit(1); }
  const cookie = (lr.headers['set-cookie'] || []).find((c) => c.startsWith('session_token='))?.split(';')[0];
  const info = JSON.parse((await httpJson('GET', RELAY + '/e2ee-salt')).body);
  key = crypto.pbkdf2Sync(PASSWORD, Buffer.from(info.salt, 'base64'), info.iterations, 32, 'sha256');
  log('login ok, chave derivada');

  socket = io(RELAY, { agent, extraHeaders: { Cookie: cookie }, transports: ['websocket'], reconnection: true, reconnectionDelay: 2000 });
  socket.on('connect', () => { socket.emit('agent:join'); log(`conectado, no canal agent:main — escrita ${ALLOW_WRITE ? 'ON' : 'off'}, run ${ALLOW_RUN ? 'ON' : 'off'}`); });
  socket.on('disconnect', (r) => log('desconectado:', r));
  socket.on('connect_error', (e) => log('erro de conexão:', e.message));

  socket.on('agent:approval:response', (m) => {
    const a = approvals.get(m && m.id);
    if (a) { approvals.delete(m.id); clearTimeout(a.to); a.resolve(!!m.approved); }
  });

  socket.on('agent:rpc', async (msg) => {
    if (!msg || !msg.id || !msg.enc) return;
    let res;
    try {
      const { method, params } = dec(msg.enc);
      if (!methods[method]) throw new Error('método desconhecido: ' + method);
      log(`rpc ${method}`, JSON.stringify(params || {}).slice(0, 120));
      res = { result: await methods[method](params || {}) };
    } catch (e) {
      res = { error: e.message };
    }
    socket.emit('agent:rpc:result', { id: msg.id, enc: enc(res) });
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
