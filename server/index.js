const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Porta: fixa 3000 local (Docker/Caddy), ou injetada pelo host (Render/PaaS).
const PORT = process.env.PORT || 3000;
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
// Limite generoso para acomodar overhead AES-GCM + base64 do FormData.
// O front continua bloqueando arquivos > 10MB (plaintext).
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const JSON_BODY_LIMIT = '5mb';
const E2EE_PBKDF2_ITERATIONS = 600000;

// ── Password ──
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || crypto.randomBytes(8).toString('hex');
if (!process.env.ACCESS_PASSWORD) {
  console.log(`\n========================================`);
  console.log(`  Generated Access Password: ${ACCESS_PASSWORD}`);
  console.log(`========================================\n`);
}

// ── Sessions ──
const sessions = new Map();

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function shortId() { return crypto.randomBytes(4).toString('hex'); }

// IDs de task sao 8 chars hex (shortId). Valida antes de tocar rotas de arquivo.
function isValidTaskId(id) { return typeof id === 'string' && /^[a-f0-9]{8}$/.test(id); }

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  const s = sessions.get(token);
  if (Date.now() - s.createdAt > SESSION_EXPIRY_MS) { sessions.delete(token); return false; }
  return true;
}

// ── E2EE salt (carregado do banco no startup; publico por design) ──
let e2eeSalt = null;

// ── Multer ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// ── Middleware ──
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

// Headers de seguranca. CSP permite inline script/style (app e um unico
// index.html inline) e 'self' para o JS de vendor + cliente socket.io, mas
// bloqueia qualquer origem externa — nada de CDN podendo injetar codigo no
// contexto que ve plaintext + a chave AES.
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: JSON_BODY_LIMIT }));

function requireAuth(req, res, next) {
  if (!isValidSession(req.cookies.session_token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Envolve handlers async: qualquer erro vira 500 (nunca derruba o processo).
function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[route]', req.method, req.path, err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Erro interno' });
  });
}

// Tráfego remoto SEMPRE passa por um proxy (Caddy/Fly) que injeta
// X-Forwarded-For; tráfego direto ao app (host, rede Docker, bridge) não tem
// XFF. Logo "sem XFF" = local confiável — isento do brute-force guard.
function isTrustedLocal(req) { return !req.headers['x-forwarded-for']; }

const loginLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  skipSuccessfulRequests: true,
  skip: isTrustedLocal,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde um minuto.' },
});

// Lockout escalonado por IP: apos LOGIN_FAIL_THRESHOLD falhas, bloqueia por um
// tempo que dobra a cada nova falha (cap em LOGIN_LOCK_MAX_MS).
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_LOCK_BASE_MS = 30 * 1000;
const LOGIN_LOCK_MAX_MS = 30 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { fails, lockedUntil, last }

function loginGuard(req, res, next) {
  if (isTrustedLocal(req)) return next();
  const rec = loginAttempts.get(req.ip);
  if (rec && rec.lockedUntil > Date.now()) {
    const secs = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', secs);
    return res.status(429).json({ error: `Muitas tentativas. Tente novamente em ${secs}s.` });
  }
  next();
}

function recordLoginFailure(ip) {
  const rec = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  rec.fails++;
  rec.last = Date.now();
  if (rec.fails >= LOGIN_FAIL_THRESHOLD) {
    const over = rec.fails - LOGIN_FAIL_THRESHOLD;
    rec.lockedUntil = Date.now() + Math.min(LOGIN_LOCK_BASE_MS * 2 ** over, LOGIN_LOCK_MAX_MS);
    console.warn(`[login] IP ${ip} bloqueado ate ${new Date(rec.lockedUntil).toISOString()} (${rec.fails} falhas)`);
  }
  loginAttempts.set(ip, rec);
}

// Comparacao constant-time da senha (evita timing attack).
function passwordMatches(input) {
  if (typeof input !== 'string') return false;
  const a = Buffer.from(input);
  const b = Buffer.from(ACCESS_PASSWORD);
  if (a.length !== b.length) { try { crypto.timingSafeEqual(b, b); } catch (_) {} return false; }
  return crypto.timingSafeEqual(a, b);
}

// Health check (Render/uptime pinger) — leve, não depende do DB.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Auth routes ──
app.post('/login', loginLimiter, loginGuard, (req, res) => {
  if (!passwordMatches(req.body.password)) {
    if (!isTrustedLocal(req)) recordLoginFailure(req.ip);
    return res.status(401).json({ error: 'Invalid password' });
  }
  loginAttempts.delete(req.ip); // reset no sucesso
  const token = generateToken();
  sessions.set(token, { createdAt: Date.now() });
  res.cookie('session_token', token, { httpOnly: true, maxAge: SESSION_EXPIRY_MS, sameSite: 'lax' });
  res.json({ ok: true });
});

app.get('/auth-check', (req, res) => {
  isValidSession(req.cookies.session_token) ? res.json({ ok: true }) : res.status(401).json({ error: 'Unauthorized' });
});

// Salt para derivacao de chave E2EE no cliente. Publico por design.
app.get('/e2ee-salt', (_req, res) => {
  res.json({
    version: 1,
    algo: 'PBKDF2-SHA256',
    iterations: E2EE_PBKDF2_ITERATIONS,
    salt: e2eeSalt.toString('base64'),
  });
});

// ── Kit da máquina-alvo (bloqueada) ──
// /dl serve os conectores como arquivos únicos (bundles), e /onboard mostra os
// comandos prontos. Ambos PÚBLICOS de propósito: é só código-cliente open source
// e a segurança está na senha (E2EE), não em esconder o binário. Zero segredo aqui.
const DL_DIR = path.join(__dirname, '..', 'dl');
const DL_FILES = new Set(['executor.js', 'relay-ping.js', 'corp-ping.js']);

app.get('/dl/:name', (req, res) => {
  const name = req.params.name;
  if (!DL_FILES.has(name)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(path.join(DL_DIR, name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Bundle indisponível — rebuild da imagem (docker compose build).' });
  });
});

function onboardPage(base) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>indioflechudo — conectar máquina alvo</title>
<style>
 :root{--bg:#0a0a0b;--card:#111113;--bd:#1e1e22;--tx:#f2ede4;--mut:#8f887c;--em:#ff5a1f}
 *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:radial-gradient(1100px 560px at 50% -12%,#1c0d06,#050506);color:var(--tx);min-height:100vh}
 .wrap{max-width:760px;margin:0 auto;padding:40px 22px}
 h1{font-weight:800;font-size:1.5rem}h1 b{background:linear-gradient(135deg,#ff5a1f,#ff8c42);-webkit-background-clip:text;background-clip:text;color:transparent}
 .arrow{color:var(--em);filter:drop-shadow(0 0 8px rgba(255,90,31,.6))}
 p{color:var(--mut);line-height:1.6}
 .step{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:18px 20px;margin:16px 0}
 .step h2{font-size:1rem;margin:0 0 6px}
 pre{background:#060607;border:1px solid var(--bd);border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:.85rem}
 code{font-family:ui-monospace,monospace}.em{color:var(--em)}
 a.btn{display:inline-block;margin:4px 8px 0 0;padding:8px 12px;border:1px solid var(--bd);border-radius:8px;color:var(--tx);text-decoration:none;font-size:.85rem}
 a.btn:hover{border-color:var(--em)}
 .note{font-size:.82rem;color:var(--mut);border-left:2px solid var(--em);padding-left:10px;margin-top:10px}
</style></head><body><div class="wrap">
 <h1><span class="arrow">&#10148;</span> indio<b>flechudo</b> — conectar a máquina alvo</h1>
 <p>Rode os comandos na <b>máquina bloqueada</b> (Windows). Ela só precisa de <b>Node</b> e de alcançar este relay: <code class="em">${base}</code></p>
 <div class="step">
  <h2>1 &middot; Testar a rede (sem dependências)</h2>
  <p>Verifica se o Node atravessa o proxy até o relay. Troque <code>SEU-PROXY:8080</code>.</p>
  <pre>curl.exe -o corp-ping.js ${base}/dl/corp-ping.js
node corp-ping.js http://SEU-PROXY:8080</pre>
  <div class="note">"CONNECT 200" + salt = OK. "CONNECT 407" = proxy exige login (NTLM), o caminho Node não passa. DNS/timeout = proxy/rede errados.</div>
 </div>
 <div class="step">
  <h2>2 &middot; Rodar o conector (executor)</h2>
  <p>As "mãos" do agente no repositório. Use a <b>mesma senha</b> do login (ela deriva a chave E2EE). Ajuste o caminho do repo e o proxy.</p>
  <pre>curl.exe -o executor.js ${base}/dl/executor.js
node --use-system-ca executor.js SUA_SENHA C:\\repo http://SEU-PROXY:8080</pre>
  <div class="note">Somente leitura por padrão. Adicione <code>--write</code> e/ou <code>--run</code> para permitir edição/execução (com aprovação no chat).</div>
 </div>
 <div class="step">
  <h2>Downloads diretos</h2>
  <a class="btn" href="${base}/dl/corp-ping.js">corp-ping.js</a>
  <a class="btn" href="${base}/dl/relay-ping.js">relay-ping.js</a>
  <a class="btn" href="${base}/dl/executor.js">executor.js</a>
 </div>
 <p class="note">Sem Node na máquina alvo? Um executável único (.exe) está no roadmap. Relay local com Caddy self-signed? Acrescente <code>-k</code> ao curl.</p>
</div></body></html>`;
}

app.get('/onboard', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`.replace(/[^a-zA-Z0-9:/._-]/g, '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(onboardPage(base));
});

// ── Task routes ──
app.get('/tasks', requireAuth, wrap(async (_req, res) => {
  res.json(await db.listTaskMetas());
}));

app.post('/tasks', requireAuth, wrap(async (req, res) => {
  const id = shortId();
  const ts = new Date().toISOString();
  const title = (req.body.title || `Task ${id}`).substring(0, 200);
  const meta = await db.createTask(id, title, ts);
  io.emit('task:created', meta);
  res.json(meta);
}));

app.patch('/tasks/:id', requireAuth, wrap(async (req, res) => {
  const fields = {};
  if (req.body.title !== undefined) fields.title = String(req.body.title).substring(0, 200);
  if (req.body.status !== undefined && ['open', 'archived'].includes(req.body.status)) fields.status = req.body.status;
  const meta = await db.updateTask(req.params.id, fields, new Date().toISOString());
  if (!meta) return res.status(404).json({ error: 'Task not found' });
  io.emit('task:updated', meta);
  res.json(meta);
}));

app.delete('/tasks/:id', requireAuth, wrap(async (req, res) => {
  const ok = await db.deleteTask(req.params.id); // cascata: messages + files
  if (!ok) return res.status(404).json({ error: 'Task not found' });
  io.emit('task:deleted', { id: req.params.id });
  res.json({ ok: true });
}));

// ── File routes (bytea no Postgres) ──
app.post('/tasks/:id/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, wrap(async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo muito grande.' });
      return res.status(500).json({ error: 'Upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file.' });
    const taskId = req.params.id;
    if (!(await db.taskExists(taskId))) return res.status(404).json({ error: 'Task not found' });

    const filename = await db.uniqueFilename(taskId, req.file.originalname);
    await db.saveFile(taskId, filename, req.file.size, req.file.buffer);

    const side = req.body.side === 'response' ? 'response' : 'input';
    const author = req.body.author === 'claude' ? 'claude' : 'human';
    // O cliente envia metadados do arquivo (nome+tamanho originais) ja cifrados
    // no campo `text`. Fallback para originalname mantem compat.
    const encryptedText = (req.body.text && String(req.body.text).slice(0, 4096)) || req.file.originalname;
    const msg = {
      id: `msg-${shortId()}`,
      side,
      type: 'file',
      text: encryptedText,
      fileName: filename,
      fileSize: req.file.size,
      filePath: `task-${taskId}/${filename}`,
      author,
      timestamp: new Date().toISOString(),
    };
    if (side === 'input') msg.respondBy = req.body.respondBy === 'human' ? 'human' : 'claude';
    const { meta } = await db.addMessage(taskId, msg);

    io.to(`task:${taskId}`).emit('message:new', msg);
    io.emit('task:updated', meta);
    res.json(msg);
  }));
});

app.get('/tasks/:id/files', requireAuth, wrap(async (req, res) => {
  if (!isValidTaskId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  res.json(await db.listFiles(req.params.id));
}));

app.get('/tasks/:id/files/:filename', requireAuth, wrap(async (req, res) => {
  if (!isValidTaskId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const filename = path.basename(req.params.filename);
  const f = await db.getFile(req.params.id, filename);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.send(f.data);
}));

app.delete('/tasks/:id/files', requireAuth, wrap(async (req, res) => {
  if (!isValidTaskId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  await db.deleteTaskFiles(req.params.id);
  res.json({ ok: true });
}));

app.delete('/tasks/:id/files/:filename', requireAuth, wrap(async (req, res) => {
  if (!isValidTaskId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  await db.deleteFile(req.params.id, path.basename(req.params.filename));
  res.json({ ok: true });
}));

// ── Socket.io ──
io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || '';
  const parsed = {};
  cookieHeader.split(';').forEach(c => { const [k, ...v] = c.trim().split('='); if (k) parsed[k] = v.join('='); });
  if (!isValidSession(parsed.session_token)) return next(new Error('Unauthorized'));
  next();
});

io.on('connection', (socket) => {
  let currentTaskId = null;

  socket.on('task:join', async (taskId) => {
    try {
      if (currentTaskId) socket.leave(`task:${currentTaskId}`);
      currentTaskId = taskId;
      socket.join(`task:${taskId}`);
      socket.emit('task:history', await db.getMessages(taskId));
    } catch (err) { console.error('[socket] task:join', err.message); }
  });

  socket.on('task:leave', () => {
    if (currentTaskId) socket.leave(`task:${currentTaskId}`);
    currentTaskId = null;
  });

  socket.on('message:send', async (payload) => {
    try {
      if (!payload || !payload.taskId || !payload.text || !payload.text.trim()) return;
      if (!(await db.taskExists(payload.taskId))) return;
      const side = payload.side === 'response' ? 'response' : 'input';
      const author = payload.author === 'claude' ? 'claude' : 'human';
      const msg = {
        id: `msg-${shortId()}`,
        side,
        type: 'text',
        text: payload.text.trim(),
        author,
        timestamp: new Date().toISOString(),
      };
      if (side === 'input') {
        msg.respondBy = payload.respondBy === 'human' ? 'human' : 'claude';
        if (payload.agentMode === true) msg.agentMode = true;
      }
      const { meta } = await db.addMessage(payload.taskId, msg);
      io.to(`task:${payload.taskId}`).emit('message:new', msg);
      io.emit('task:updated', meta);
    } catch (err) { console.error('[socket] message:send', err.message); }
  });

  // Status efemero do bridge (Claude trabalhando). Nao e persistido — so um
  // hint de UI repassado para quem esta na sala da task. Fase e um enum curto.
  const STATUS_PHASES = new Set(['working', 'reading', 'thinking', 'writing', 'done']);
  socket.on('task:status', (p) => {
    if (!p || !p.taskId || !STATUS_PHASES.has(p.phase)) return;
    io.to(`task:${p.taskId}`).emit('task:status', { taskId: p.taskId, phase: p.phase });
  });

  // ── Canal do agente (cérebro no Mac <-> executor no cliente) ──
  // Roteamento efêmero numa sala fixa; o servidor só repassa payloads opacos
  // (já cifrados E2EE pelas pontas), nunca os lê nem persiste.
  socket.on('agent:join', () => { socket.join('agent:main'); });
  socket.on('agent:rpc', (m) => { if (m && m.id) socket.to('agent:main').emit('agent:rpc', m); });
  socket.on('agent:rpc:result', (m) => { if (m && m.id) socket.to('agent:main').emit('agent:rpc:result', m); });
  // Aprovação de escrita: pedido vai pra sala da task (cliente vê e decide);
  // resposta volta pro canal do agente (executor aguarda). Payload opaco (E2EE).
  socket.on('agent:approval:request', (m) => { if (m && m.id && m.taskId) io.to(`task:${m.taskId}`).emit('agent:approval:request', m); });
  socket.on('agent:approval:response', (m) => { if (m && m.id) io.to('agent:main').emit('agent:approval:response', m); });
  // Narração do agente (tool-use/thinking em tempo real): bridge -> sala da task.
  // Payload opaco (enc cifrado E2EE); o servidor só repassa, nunca lê nem persiste.
  socket.on('agent:event', (m) => { if (m && m.taskId && m.enc) io.to(`task:${m.taskId}`).emit('agent:event', m); });

  socket.on('messages:clear', async (taskId) => {
    try {
      if (!(await db.taskExists(taskId))) return;
      const meta = await db.clearMessages(taskId, new Date().toISOString());
      io.to(`task:${taskId}`).emit('messages:cleared');
      io.emit('task:updated', meta);
    } catch (err) { console.error('[socket] messages:clear', err.message); }
  });
});

// Varredura periodica: remove sessoes expiradas e registros de login inativos.
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_EXPIRY_MS) sessions.delete(token);
  }
  for (const [ip, rec] of loginAttempts) {
    if (rec.lockedUntil < now && now - (rec.last || 0) > 60 * 60 * 1000) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000).unref();

// ── Startup ──
async function main() {
  await db.initSchema();
  e2eeSalt = await db.loadOrCreateSalt();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`indioflechudo running on http://localhost:${PORT}`);
  });
}

main().catch((err) => { console.error('[fatal] falha no startup:', err.message); process.exit(1); });

// Graceful shutdown (o Postgres persiste na hora; só fechamos o pool).
async function shutdown() { try { await db.pool.end(); } catch (_) {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
