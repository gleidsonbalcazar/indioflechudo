'use strict';

/**
 * corp-ping — teste de conectividade ZERO-dependência (só Node nativo).
 * Roda na máquina corporativa para descobrir se o Node consegue atravessar o
 * proxy até o relay. Não precisa de npm install nem senha (bate só no endpoint
 * público /e2ee-salt).
 *
 * Uso:
 *   node corp-ping.js <proxyUrl> [relayUrl]
 * Exemplos:
 *   node corp-ping.js http://meu-proxy:8080
 *   node corp-ping.js http://meu-proxy:8080 https://your-app.fly.dev
 *   (ou defina HTTPS_PROXY no ambiente e rode: node corp-ping.js)
 *
 * Interpretação:
 *   - "CONNECT 200" + salt JSON  -> Node passa pelo proxy: seguimos com Node.
 *   - "CONNECT 407"              -> proxy exige login (NTLM): vamos de .NET.
 *   - erro de DNS/timeout        -> proxy/host errado ou bloqueio de rede.
 */

const http = require('http');
const https = require('https');
const tls = require('tls');

// Args: flags nomeadas (recomendado) ou posicionais (compat). Proxy é OPCIONAL.
//   node corp-ping.js --relay https://... [--proxy http://host:8080]
const VALUE_FLAGS = new Set(['relay', 'proxy']);
const flags = {};
const pos = [];
const _av = process.argv.slice(2);
for (let i = 0; i < _av.length; i++) {
  const a = _av[i];
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/i);
  if (!m) { pos.push(a); continue; }
  const k = m[1].toLowerCase();
  if (VALUE_FLAGS.has(k)) { flags[k] = m[2] !== undefined ? m[2] : _av[++i]; continue; }
}
const PROXY = flags.proxy || pos[0] || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const RELAY = flags.relay || pos[1] || process.env.RELAY_URL || 'https://your-app.fly.dev';

if (!RELAY || /your-app\.fly\.dev/.test(RELAY)) {
  console.error('Informe o relay. Uso: node corp-ping.js --relay https://SEU-APP.onrender.com [--proxy http://host:8080]');
  process.exit(1);
}

function connectViaProxy(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl);
    const req = http.request({
      host: u.hostname,
      port: u.port || 8080,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: 15000,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`proxy respondeu CONNECT ${res.statusCode} ${res.statusMessage || ''}`));
      resolve(socket);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout no CONNECT do proxy')); });
    req.on('error', reject);
    req.end();
  });
}

async function getViaProxy(fullUrl) {
  const url = new URL(fullUrl);
  const port = url.port || 443;
  const socket = await connectViaProxy(PROXY, url.hostname, port);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      host: url.hostname,
      path: url.pathname + url.search,
      headers: { Host: url.hostname, 'ngrok-skip-browser-warning': '1', 'User-Agent': 'corp-ping' },
      createConnection: () => tls.connect({ socket, servername: url.hostname }),
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout na resposta HTTPS')); });
    req.on('error', reject);
    req.end();
  });
}

// Conexão direta (sem proxy) — para redes/VDIs que alcançam o relay sem proxy.
function getDirect(fullUrl) {
  const url = new URL(fullUrl);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET', host: url.hostname, port: url.port || 443,
      path: url.pathname + url.search, headers: { 'User-Agent': 'corp-ping' }, timeout: 15000,
    }, (res) => {
      let data = ''; res.on('data', (d) => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout na resposta HTTPS')); });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log(`proxy : ${PROXY || '(nenhum — conexão direta)'}`);
  console.log(`relay : ${RELAY}`);
  try {
    const r = PROXY ? await getViaProxy(RELAY + '/e2ee-salt') : await getDirect(RELAY + '/e2ee-salt');
    console.log(`\n✓ CONNECT ok — HTTP ${r.status}`);
    console.log('resposta:', r.body.slice(0, 200));
    if (r.status === 200 && r.body.includes('salt')) {
      console.log('\n==> RESULTADO: o Node alcança o relay' + (PROXY ? ' pelo proxy' : ' direto') + '. Podemos rodar o executor em Node.');
    } else {
      console.log('\n==> Alcançou o relay, mas resposta inesperada — me mostre o output.');
    }
  } catch (e) {
    console.log(`\n✗ Falhou: ${e.message}`);
    if (/407/.test(e.message)) {
      console.log('==> Proxy exige autenticação (provável NTLM). Caminho recomendado: executor em .NET (usa a credencial do Windows automaticamente).');
    } else {
      console.log('==> Verifique o endereço/porta do proxy. Me mande esta saída.');
    }
  }
})();
