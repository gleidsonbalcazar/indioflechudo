'use strict';
/**
 * console — REPL estilo Claude CLI para operar o repositório remoto (via
 * executor) a partir do terminal. É "mais um cliente" E2EE do relay: manda seus
 * prompts em MODO AGENTE e imprime o streaming das ferramentas + a resposta.
 *
 * O Claude roda no bridge (seu Mac); as "mãos" são o executor (na VDI).
 *
 * Uso:
 *   node client/console.js --relay https://SEU-APP.onrender.com --password X [--task <id>]
 * (ou ./console.sh, que carrega RELAY_URL/ACCESS_PASSWORD do bridge/render.env)
 *
 * Comandos: /help /new /task /clear /exit · histórico com ↑/↓ (persistente).
 */
const crypto = require('crypto');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

// ── Args ──
const av = process.argv.slice(2);
const flags = {};
for (let i = 0; i < av.length; i++) { const m = av[i].match(/^--([a-z-]+)(?:=(.*))?$/i); if (m) flags[m[1]] = m[2] !== undefined ? m[2] : av[++i]; }
const RELAY = (flags.relay || process.env.RELAY_URL || 'http://localhost:3998').replace(/\/$/, '');
const PW = flags.password || process.env.ACCESS_PASSWORD;
let TASK = flags.task || null;
if (!PW) { console.error('faltou --password (ou ACCESS_PASSWORD)'); process.exit(1); }

// ── Cores (respeitam TTY / NO_COLOR) ──
const TTY = !!process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code) => (s) => TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const C = { dim: color('2'), em: color('38;5;208'), b: color('1'), r: color('31'), code: color('38;5;214'), gray: color('90') };

// ── E2EE (E1.<iv>.<ct||tag>) ──
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

// ── Render leve de markdown (bold, `code`, cercas, headers) ──
function renderMd(md) {
  const out = []; let fence = false;
  for (const ln of String(md).split('\n')) {
    if (/^\s*```/.test(ln)) { fence = !fence; out.push(C.gray(ln)); continue; }
    if (fence) { out.push(C.code(ln)); continue; }
    const h = ln.match(/^(#{1,6})\s+(.*)$/); if (h) { out.push(C.b(C.em(h[2]))); continue; }
    let s = ln.replace(/\*\*([^*]+)\*\*/g, (_, m) => C.b(m)).replace(/`([^`]+)`/g, (_, m) => C.code(m));
    out.push(s);
  }
  return out.join('\n');
}

// ── Spinner (só em TTY) ──
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spTimer = null, spStart = 0, spFrame = 0, spLabel = 'trabalhando';
function spDraw() { const s = Math.floor((Date.now() - spStart) / 1000); process.stdout.write(`\r\x1b[2K${C.em(FRAMES[spFrame = (spFrame + 1) % FRAMES.length])} ${C.dim(spLabel + '… ' + s + 's')}`); }
function spStartFn(label) { if (!TTY) return; spStart = Date.now(); spLabel = label || 'trabalhando'; if (spTimer) clearInterval(spTimer); spTimer = setInterval(spDraw, 120); spDraw(); }
function spStop() { if (spTimer) { clearInterval(spTimer); spTimer = null; } if (TTY) process.stdout.write('\r\x1b[2K'); }
// imprime uma linha "acima" do spinner (pausa, escreve, retoma)
function printAbove(text) {
  const on = !!spTimer;
  if (on) { clearInterval(spTimer); spTimer = null; if (TTY) process.stdout.write('\r\x1b[2K'); }
  process.stdout.write(text + '\n');
  if (on) spTimer = setInterval(spDraw, 120);
}

// ── Histórico persistente ──
const HIST = path.join(os.homedir(), '.indioflechudo_history');
function loadHistory() { try { return fs.readFileSync(HIST, 'utf8').split('\n').filter(Boolean).slice(-500); } catch { return []; } }
function saveHistory(s) { try { fs.appendFileSync(HIST, s + '\n'); } catch (_) {} }

const ICON = { list_dir: '📂', read_file: '📖', glob: '🔎', grep: '🔎', write_file: '✏️', edit_file: '✏️', run: '▶️' };

async function api(method, path_, cookie, body) {
  return fetch(RELAY + path_, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
  rl.history = loadHistory().reverse();
  let waiting = false, lastThinking = false;

  function banner() {
    console.log(C.em('➤ indioflechudo') + C.dim(`  · ${RELAY.replace(/^https?:\/\//, '')} · task ${TASK}`));
    console.log(C.dim('  toda mensagem opera o repo remoto (agente). /help para comandos.\n'));
  }
  function help() {
    printAbove([
      C.b('  comandos:'),
      '  /new    — nova conversa (contexto limpo)',
      '  /task   — mostra o id da task atual',
      '  /clear  — limpa a tela',
      '  /exit   — sair (ou Ctrl+D)',
      C.dim('  ↑/↓ = histórico · Ctrl+C = cancelar a espera'),
    ].map((l) => C.dim(l)).join('\n'));
  }

  socket.once('connect', () => { banner(); rl.prompt(); });
  socket.on('connect', () => socket.emit('task:join', TASK));
  socket.on('disconnect', () => { if (waiting || TTY) printAbove(C.r('  [desconectado — reconectando…]')); });

  socket.on('agent:event', (m) => {
    if (!m || m.taskId !== TASK || !waiting) return;
    let e; try { e = JSON.parse(dec(m.enc)); } catch { return; }
    if (e.kind === 'thinking') { if (lastThinking) return; lastThinking = true; printAbove(C.dim('  💭 pensando…')); }
    else { lastThinking = false; const ic = ICON[e.label] || '·'; printAbove(C.dim(`  ${ic} ${e.label}${e.detail ? ' ' + C.gray(e.detail) : ''}`)); }
  });

  socket.on('message:new', (msg) => {
    if (!msg || msg.side !== 'response' || !waiting) return;
    waiting = false; lastThinking = false; spStop();
    let txt; try { txt = dec(msg.text); } catch { txt = '(falha ao decifrar)'; }
    process.stdout.write('\n' + renderMd(txt) + '\n\n');
    rl.prompt();
  });

  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) { rl.prompt(); return; }
    if (waiting) { printAbove(C.dim('  (aguardando a resposta anterior…)')); return; }
    if (s === '/exit' || s === '/quit') { rl.close(); return; }
    if (s === '/help') { help(); rl.prompt(); return; }
    if (s === '/clear') { console.clear(); rl.prompt(); return; }
    if (s === '/task') { printAbove(C.dim('  task: ' + TASK)); rl.prompt(); return; }
    if (s === '/new') {
      const t = await (await api('POST', '/tasks', cookie, { title: 'console' })).json();
      socket.emit('task:leave'); TASK = t.id; socket.emit('task:join', TASK);
      printAbove(C.dim('  nova conversa: ' + TASK)); rl.prompt(); return;
    }
    saveHistory(s);
    waiting = true; lastThinking = false;
    socket.emit('message:send', { taskId: TASK, side: 'input', text: enc(s), author: 'human', respondBy: 'claude', agentMode: true });
    spStartFn('trabalhando');
  });

  // Ctrl+C: cancela a espera local (a resposta ainda pode chegar); duplo = sair.
  let sigints = 0;
  rl.on('SIGINT', () => {
    if (waiting) { waiting = false; spStop(); printAbove(C.dim('  (espera cancelada — a resposta pode ainda aparecer)')); rl.prompt(); return; }
    sigints++;
    if (sigints >= 2) { rl.close(); return; }
    printAbove(C.dim('  (Ctrl+C de novo, ou /exit, para sair)')); rl.prompt();
    setTimeout(() => { sigints = 0; }, 1500);
  });

  rl.on('close', () => { spStop(); console.log(C.dim('\ntchau.')); try { socket.close(); } catch (_) {} process.exit(0); });
})().catch((e) => { console.error(C.r(String((e && e.message) || e))); process.exit(1); });
