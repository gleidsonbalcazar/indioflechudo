# indioflechudo

Relay pessoal de texto e arquivos via web, com **criptografia ponta-a-ponta (E2EE)**.
Útil para passar trechos de código, prints e arquivos entre máquinas (ex.: uma
máquina restrita e o seu Mac) por uma página simples, em tempo real.

Derivado da base do Clipboard Relay, mas **projeto independente** com persistência
em **Postgres** (o original usava arquivo JSON).

- **Backend**: Node.js + Express + Socket.io, persistência em **Postgres** (`server/db.js`).
- **Frontend**: um único `public/index.html` (sem build), vanilla JS.
- **Deploy**: Docker Compose (app + Postgres) + Caddy (HTTPS automático).

> **Dev local**: `docker compose up -d --build` sobe app + Postgres. App em
> `http://127.0.0.1:3998` (ou `https://localhost:8444` via Caddy). Configure o
> `.env` (copie de `.env.example`) com `ACCESS_PASSWORD`. O `DATABASE_URL` já vem
> apontado pro serviço `db` do compose.

## Como funciona a criptografia

- O cliente deriva uma chave **AES-GCM** a partir da senha via **PBKDF2**
  (600k iterações, SHA-256). A chave vive **apenas em memória** no navegador.
- Todo conteúdo (mensagens, nomes e bytes de arquivos, títulos) é cifrado
  **no cliente**. O servidor só armazena ciphertext — nunca vê o plaintext.
- O `salt` do PBKDF2 é público por design (servido em `/e2ee-salt`).

> ⚠️ **A segurança depende inteiramente da senha.** `ACCESS_PASSWORD` é ao mesmo
> tempo a senha de login **e** a semente da chave E2EE. Use uma passphrase longa
> e única em produção, e **nunca** a versione (ela mora em `.env`, que está no
> `.gitignore`).

## Setup

```bash
# 1. Configure a senha (fora do git)
cp .env.example .env
$EDITOR .env            # defina ACCESS_PASSWORD

# 2. Suba
./start.sh              # ou: docker compose up -d --build
```

Acesse **https://localhost:8443** (Caddy usa cert interno self-signed; o aviso do
navegador é esperado em uso local). HTTP em :8080 redireciona para HTTPS.

### Ligar com um comando (Docker + ngrok)

```bash
./run.sh         # sobe o Docker se não estiver no ar e ativa o ngrok
./relay-stop.sh  # para o ngrok do relay e (opcional) o Docker
```

Defina `NGROK_DOMAIN` no `.env` para usar um domínio fixo do ngrok; sem isso o
ngrok abre com URL aleatória. Dica de alias (zsh): `alias relay='/caminho/para/run.sh'`.

Se `ACCESS_PASSWORD` não for definida, o servidor gera uma senha aleatória e a
imprime no log de startup (`docker compose logs clipboard`).

### Rodar sem Docker (dev)

```bash
cd server
npm ci
ACCESS_PASSWORD="uma-passphrase-longa" node index.js   # http://localhost:3000
```

## Parar / limpar

```bash
./stop.sh   # derruba os containers e pergunta se quer apagar os dados
```

## Dados e backup

- Dados ficam em `./data/` (montado como volume): `tasks.json`, arquivos cifrados
  em `data/files/`, e o salt em `data/e2ee-salt.bin`.
- Escrita atômica (`tmp` + rename) com cópia `.prev` para rollback.
- Snapshot diário em `data/backups/` com retenção de 30 dias.
- **`data/` e `uploads/` estão no `.gitignore` — nunca são publicados.**

## Bridge automático (opcional) — responder com o Claude

O `bridge/` é um worker headless que automatiza o fluxo: quando chega uma
mensagem do lado **`input`** (a máquina cliente), ele decifra, pergunta ao
**Claude** e posta a resposta de volta como **`response`** — o cliente só
precisa abrir o chat e ler.

- **Chat puro via Claude Code**: usa o `claude -p` (reusa sua assinatura, **sem**
  custo de API). Texto e arquivos de texto vão com `--tools ""` (sem
  filesystem/bash). **Imagens** (png/jpg/gif/webp) são gravadas num arquivo
  temporário e lidas com a ferramenta **Read** (só leitura, escopo do temp via
  `--add-dir`) — é como o Claude "vê" a imagem. O temp é apagado depois.
- **Tipos de arquivo**: texto (csv, svg, html, ts, scss, js, json…) inline;
  **xlsx** via exceljs; **zip** via adm-zip; **imagens** via Read/visão.
- **Memória por task**: cada task vira uma sessão do Claude Code (UUID
  determinístico). A 1ª mensagem cria a sessão; as seguintes usam `--resume`,
  então o Claude mantém o contexto, inclusive após restart do worker.
- **Diretrizes fixas** (system prompt): por padrão, sem comentários no código e
  contexto C# legado. Ajuste via `BRIDGE_SYSTEM_PROMPT` no `.env`.
- **E2EE preservado**: o bridge é só "mais um cliente" com a senha — o servidor
  continua cego. A chave AES é derivada igual ao front (PBKDF2 → AES-GCM).

### Rodar o bridge

O bridge roda **no host** (onde o `claude` está instalado e autenticado), não no
Docker. Ele fala com o relay pela porta publicada no localhost (`3000`):

```bash
cd bridge
npm ci
node --env-file=../.env bridge.js     # reusa ACCESS_PASSWORD do .env do relay
```

Overrides opcionais (modelo, caminho do binário, timeout) em `bridge/.env.example`.

### Quem responde + rótulo de autor

No cliente há um seletor **Responder: 🤖 Claude / 👤 Eu**:

- **🤖 Claude** (default): o bridge responde automaticamente a pergunta.
- **👤 Eu**: o bridge ignora — você mesmo responde do outro lado (toggle "Mac").

Cada mensagem mostra um rótulo de autor (🤖 Claude ou 👤 Você), então fica claro
quem respondeu. Tecnicamente: as perguntas carregam `respondBy` (claude|human) e
as respostas carregam `author`.

### Rodar como serviço (macOS, sobe no boot + reinicia se cair)

```bash
./bridge/service/install-launchd.sh     # gera o plist com seus caminhos e carrega
tail -f ~/Library/Logs/clipboard-bridge.out.log
./bridge/service/uninstall-launchd.sh   # para remover
```

> ⚠️ O bridge tem a senha do relay (= chave E2EE). Trate-a como segredo de alto
> valor e rode o worker com privilégio mínimo.

## Notas de segurança

- Headers de segurança (CSP sem origens externas, `X-Frame-Options: DENY`,
  `nosniff`) aplicados no servidor.
- Dependências de frontend são **self-hospedadas** (sem CDN): o cliente
  socket.io vem do próprio servidor e o `marked` é servido localmente com SRI.
- Cookie de sessão `httpOnly` + `SameSite=Lax`; rate limit no `/login`.

## Licença

Uso pessoal. Sem garantias.
