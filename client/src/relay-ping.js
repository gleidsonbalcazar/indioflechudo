'use strict';

/**
 * relay-ping — prova a ponta autenticada completa a partir da máquina cliente:
 * login (via proxy + CA do sistema) -> deriva a chave E2EE -> conecta no
 * socket.io (websocket pelo proxy) -> confirma. Empacotado num único arquivo
 * (esbuild), então roda sem npm install.
 *
 * Uso:
 *   node --use-system-ca relay-ping.js <senha> [proxyUrl] [relayUrl]
 * Ex.:
 *   node --use-system-ca relay-ping.js gsb2083 http://proxy:8080
 */

const crypto = require('crypto');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { io } = require('socket.io-client');

const PASSWORD = process.argv[2] || process.env.RELAY_PASSWORD;
const PROXY = process.argv[3] || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const RELAY = process.argv[4] || process.env.RELAY_URL || 'https://your-app.fly.dev';
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

if (!PASSWORD) { console.error('Uso: node --use-system-ca relay-ping.js <senha> [proxyUrl] [relayUrl]'); process.exit(1); }

function httpJson(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method, host: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { ...headers, 'ngrok-skip-browser-warning': '1' }, agent, timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log(`relay : ${RELAY}`);
  console.log(`proxy : ${PROXY || '(nenhum)'}`);

  // 1. login -> cookie
  const lr = await httpJson('POST', RELAY + '/login', { 'Content-Type': 'application/json' }, JSON.stringify({ password: PASSWORD }));
  if (lr.status !== 200) { console.log(`✗ login HTTP ${lr.status}: ${lr.body.slice(0, 120)}`); process.exit(1); }
  const setCookie = (lr.headers['set-cookie'] || []).find((c) => c.startsWith('session_token='));
  const cookie = setCookie ? setCookie.split(';')[0] : '';
  if (!cookie) { console.log('✗ sem cookie de sessão'); process.exit(1); }
  console.log('✓ login ok');

  // 2. deriva a chave E2EE (prova o pbkdf2 no Windows)
  const info = JSON.parse((await httpJson('GET', RELAY + '/e2ee-salt')).body);
  const key = crypto.pbkdf2Sync(PASSWORD, Buffer.from(info.salt, 'base64'), info.iterations, 32, 'sha256');
  console.log(`✓ chave E2EE derivada (${key.length} bytes)`);

  // 3. conecta no socket.io (websocket pelo proxy) — io.use valida o cookie
  const socket = io(RELAY, { agent, extraHeaders: { Cookie: cookie }, transports: ['websocket'], reconnection: false, timeout: 20000 });
  const t = setTimeout(() => { console.log('✗ timeout conectando o socket'); process.exit(1); }, 25000);
  socket.on('connect', () => {
    clearTimeout(t);
    console.log(`✓ socket conectado (id ${socket.id})`);
    console.log('\n==> PONTA COMPLETA OK: login + cripto + websocket pelo proxy. Pronto pro executor.');
    socket.close();
    process.exit(0);
  });
  socket.on('connect_error', (e) => { clearTimeout(t); console.log(`✗ socket falhou: ${e.message}`); process.exit(1); });
})().catch((e) => { console.log(`✗ erro: ${e.message}`); process.exit(1); });
