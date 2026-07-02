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

const PROXY = process.argv[2] || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const RELAY = process.argv[3] || process.env.RELAY_URL || 'https://your-app.fly.dev';

if (!PROXY) {
  console.error('Faltou o proxy. Uso: node corp-ping.js http://seu-proxy:8080 [relayUrl]');
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

(async () => {
  console.log(`proxy : ${PROXY}`);
  console.log(`relay : ${RELAY}`);
  try {
    const r = await getViaProxy(RELAY + '/e2ee-salt');
    console.log(`\n✓ CONNECT ok — HTTP ${r.status}`);
    console.log('resposta:', r.body.slice(0, 200));
    if (r.status === 200 && r.body.includes('salt')) {
      console.log('\n==> RESULTADO: Node atravessa o proxy. Podemos fazer o executor em Node.');
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
