'use strict';
/**
 * console — REPL estilo Claude CLI para operar o repositório remoto (via
 * executor) a partir do terminal, em vez do navegador. É "mais um cliente" do
 * relay: manda seus prompts em MODO AGENTE e imprime o streaming das ferramentas
 * (list_dir/read_file/edit_file/run…) + a resposta final.
 *
 * O Claude roda no bridge (seu Mac); as "mãos" são o executor (na VDI). Aqui é só
 * o terminal de comando + a resposta.
 *
 * Uso:
 *   node client/console.js --relay https://SEU-APP.onrender.com --password X [--task <id>]
 * (ou use ./console.sh, que carrega RELAY_URL/ACCESS_PASSWORD do bridge/render.env)
 */
const crypto = require('crypto');
const readline = require('readline');
const { io } = require('socket.io-client');

// ── Args ──
const av = process.argv.slice(2);
const flags = {};
for (let i = 0; i < av.length; i++) { const m = av[i].match(/^--([a-z-]+)(?:=(.*))?$/i); if (m) flags[m[1]] = m[2] !== undefined ? m[2] : av[++i]; }
const RELAY = (flags.relay || process.env.RELAY_URL || 'http://localhost:3998').replace(/\/$/, '');
const PW = flags.password || process.env.ACCESS_PASSWORD;
let TASK = flags.task || null;
if (!PW) { console.error('faltou --password (ou ACCESS_PASSWORD)'); process.exit(1); }

// ── Cores ──
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, em: (s) => `\x1b[38;5;208m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`,
};

// ── E2EE (E1.<iv>.<ct||tag>, mesmo formato do resto) ──
const ENC = 'E1.';
let key = null;
function enc(str) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(str, 'utf8')), c.final()]);
  return ENC + iv.toString('base64') + '.' + Buffer.concat([ct, c.getAuthTag()]).toString('base64');
}
function dec(packed) {
  if (typeof packed !== 'string' || !packed.startsWith(ENC)) return packed;
  const rest = packed.slice(ENC.length), dot = rest.indexOf('.');
  const iv = Buffer.from(rest.slice(0, dot), 'base64');
  const ctTag = Buffer.from(rest.slice(dot + 1), 'base64');
  const tag = ctTag.subarray(ctTag.length - 16), ct = ctTag.subarray(0, ctTag.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

const ICON = { list_dir: '📂', read_file: '📖', glob: '🔎', grep: '🔎', write_file: '✏️', edit_file: '✏️', run: '▶️' };

async function api(method, path, cookie, body) {
  return fetch(RELAY + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

(async () => {
  const lr = await api('POST', '/login', null, { password: PW });
  if (!lr.ok) { console.error(C.r('login falhou: ' + lr.status)); process.exit(1); }
  const cookie = (lr.headers.getSetCookie() || []).find((c) => c.startsWith('session_token='))?.split(';')[0];
  const info = await (await api('GET', '/e2ee-salt', cookie)).json();
  key = crypto.pbkdf2Sync(PW, Buffer.from(info.salt, 'base64'), info.iterations, 32, 'sha256');
  if (!TASK) { const t = await (await api('POST', '/tasks', cookie, { title: 'console' })).json(); TASK = t.id; }

  const socket = io(RELAY, { extraHeaders: { Cookie: cookie }, transports: ['websocket'], reconnection: true });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.em('› ') });
  let waiting = false, lastThinking = false;

  function banner() {
    console.log(C.em('➤ indioflechudo') + C.dim(`  · relay=${RELAY.replace(/^https?:\/\//, '')} · task=${TASK}`));
    console.log(C.dim('  toda mensagem opera o repo remoto (agente). /new · /task · /exit\n'));
  }

  socket.on('connect', () => { socket.emit('task:join', TASK); });
  socket.once('connect', () => { banner(); rl.prompt(); });

  socket.on('agent:event', (m) => {
    if (!m || m.taskId !== TASK) return;
    let e; try { e = JSON.parse(dec(m.enc)); } catch { return; }
    if (e.kind === 'thinking') { if (lastThinking) return; lastThinking = true; process.stdout.write('\n' + C.dim('  💭 pensando…')); }
    else { lastThinking = false; const ic = ICON[e.label] || '·'; process.stdout.write('\n' + C.dim(`  ${ic} ${e.label}${e.detail ? ' ' + e.detail : ''}`)); }
  });

  socket.on('message:new', (msg) => {
    if (!msg || msg.side !== 'response' || !waiting) return;
    waiting = false; lastThinking = false;
    let txt; try { txt = dec(msg.text); } catch { txt = '(falha ao decifrar)'; }
    process.stdout.write('\n\n' + txt + '\n\n');
    rl.prompt();
  });

  socket.on('disconnect', () => process.stdout.write(C.r('\n[desconectado — reconectando…]\n')));

  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) { rl.prompt(); return; }
    if (waiting) { process.stdout.write(C.dim('  (aguardando a resposta anterior…)\n')); return; }
    if (s === '/exit' || s === '/quit') { rl.close(); return; }
    if (s === '/task') { console.log(C.dim('  task: ' + TASK)); rl.prompt(); return; }
    if (s === '/new') {
      const t = await (await api('POST', '/tasks', cookie, { title: 'console' })).json();
      socket.emit('task:leave'); TASK = t.id; socket.emit('task:join', TASK);
      console.log(C.dim('  nova conversa: ' + TASK)); rl.prompt(); return;
    }
    waiting = true;
    socket.emit('message:send', { taskId: TASK, side: 'input', text: enc(s), author: 'human', respondBy: 'claude', agentMode: true });
    process.stdout.write(C.dim('  …'));
  });
  rl.on('close', () => { console.log(C.dim('\ntchau.')); socket.close(); process.exit(0); });
})().catch((e) => { console.error(C.r(String(e && e.message || e))); process.exit(1); });
