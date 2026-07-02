# indioflechudo

Relay pessoal de **texto e arquivos** via web, com **criptografia ponta-a-ponta
(E2EE)** e **servidor cego**. Serve para passar trechos de código, prints e
arquivos entre máquinas — por exemplo, de uma máquina/VDI corporativa restrita
para o seu Mac — por uma página simples, em tempo real.

O servidor **nunca vê o conteúdo em claro**: tudo é cifrado no navegador e só o
ciphertext trafega e é persistido.

> Derivado da base do *Clipboard Relay*, mas é um **projeto independente**. A
> diferença central é a persistência em **Postgres** (o original usava arquivo
> JSON em disco).

---

## Sumário

- [Interface](#interface)
- [Arquitetura em 30 segundos](#arquitetura-em-30-segundos)
- [Stack](#stack)
- [Rodar local (Docker)](#rodar-local-docker)
- [Passo a passo (uso)](#passo-a-passo-uso)
- [Configuração (.env)](#configuração-env)
- [Como funciona o E2EE](#como-funciona-o-e2ee)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Bridge automático (responder com o Claude)](#bridge-automático-responder-com-o-claude)
- [Modo agente (operar um repositório remoto)](#modo-agente-operar-um-repositório-remoto)
- [Deploy (Fly)](#deploy-fly)
- [Notas de segurança](#notas-de-segurança)
- [Estado atual e pendências](#estado-atual-e-pendências)

Para o detalhamento técnico (schema, eventos Socket.io, modelo de ameaças),
veja **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## Interface

Tema **Brasa** — preto quase absoluto com acentos de brasa (laranja-vermelho) e a
flecha como assinatura. Interface single-file (`public/index.html`), sem build.

**Tela de login**

![Tela de login do indioflechudo](docs/screenshots/login-brasa.png)

**App — lista de tasks + chat E2EE**

![Interface principal do indioflechudo](docs/screenshots/app-brasa.png)

> ℹ️ As imagens usam **dados de exemplo** (tasks e mensagens fictícias), apenas
> para ilustração.

---

## Arquitetura em 30 segundos

```
 Navegador (Mac)                    Relay (servidor cego)                 Navegador/VDI
 ───────────────                    ─────────────────────                 ─────────────
 senha ──PBKDF2──► chave AES         Express + Socket.io                  chave AES ◄── senha
 cifra no cliente ─────────────────► só armazena ciphertext ◄──────────── cifra no cliente
 decifra ao ler   ◄──── Postgres (mensagens, arquivos=bytea, salt) ─────► decifra ao ler
```

- **Servidor cego**: mensagens, nomes/bytes de arquivos e títulos são cifrados
  **no cliente**. O Postgres só guarda ciphertext.
- **Tempo real**: entrega via Socket.io (salas por task).
- **Uploads**: arquivos cifrados são armazenados como `bytea` **dentro do
  Postgres** (não há storage em disco).

---

## Stack

| Camada       | Tecnologia                                                        |
|--------------|-------------------------------------------------------------------|
| Backend      | Node.js 20 + Express + Socket.io                                   |
| Persistência | **PostgreSQL 16** (`server/db.js`, pool `pg` + repositório)        |
| Frontend     | `public/index.html` único, vanilla JS, **sem build**              |
| Proxy/TLS    | Caddy 2 (HTTPS self-signed local; termina TLS em produção)         |
| Orquestração | Docker Compose (`app` + `db` + `caddy`)                            |
| Deploy       | Fly.io (workflow em `.github/workflows/`)                          |

---

## Rodar local (Docker)

Pré-requisito: Docker + Docker Compose.

```bash
# 1. Configure a senha (fora do git)
cp .env.example .env
$EDITOR .env                 # defina ACCESS_PASSWORD (passphrase longa)

# 2. Suba tudo (app + Postgres + Caddy)
./start.sh                   # equivale a: docker compose up -d --build
```

Portas publicadas (escolhidas para **não colidir** com outros stacks locais):

| Serviço            | URL                          | Observação                          |
|--------------------|------------------------------|-------------------------------------|
| App (direto)       | http://127.0.0.1:3998        | Só localhost                        |
| Caddy (HTTPS)      | https://localhost:8444       | Cert interno self-signed (aviso ok) |
| Caddy (HTTP)       | http://localhost:8081        | Redireciona para HTTPS              |

Acesse **https://localhost:8444** e faça login com o `ACCESS_PASSWORD`.

Se `ACCESS_PASSWORD` não estiver definido, o servidor gera uma senha aleatória e
a imprime no log de startup:

```bash
docker compose logs app | grep -i password
```

### Parar / limpar

```bash
./stop.sh        # pergunta se quer apagar o volume Postgres (pg_data)
```

Os dados moram no volume Docker **`pg_data`**. `docker compose down` preserva o
volume; `docker compose down -v` (ou responder "y" no `stop.sh`) o apaga.

### Rodar sem Docker (dev do backend)

Requer um Postgres acessível.

```bash
cd server
npm ci
ACCESS_PASSWORD="uma-passphrase-longa" \
DATABASE_URL="postgres://indio:indio@localhost:5432/indioflechudo" \
node index.js                # http://localhost:3000
```

---

## Passo a passo (uso)

Fluxo típico da interface, com **dados de exemplo** — nada aqui é real; troque
pela sua senha e pelas suas próprias tasks.

1. **Login** — abra `https://localhost:8444` e entre com a sua senha. No exemplo
   usamos `MinhaSenha@2026` (é apenas um placeholder de documentação; em produção
   use uma passphrase longa e única e **nunca** a versione). A mesma senha deriva
   a chave E2EE no navegador — a partir daqui tudo é cifrado no cliente.

2. **Criar uma task** — clique em **➤ Nova Task**. Cada task é uma conversa
   isolada (ex.: *"Ajuste no relatório de vendas"*). O próprio título é cifrado.

3. **Enviar conteúdo** — digite ou **cole** texto/print no campo inferior e envie
   (botão ➤). Para arquivos, use 📎 ou **arraste** para a janela (csv, imagens,
   xlsx, zip…). Tudo é cifrado antes de sair do navegador.

4. **Quem responde** — no seletor **🤖 Claude / 👤 Eu**:
   - **🤖 Claude**: o bridge responde automaticamente (requer o bridge rodando).
   - **👤 Eu**: você mesmo responde do outro lado.

5. **Modo agente (opcional)** — comece a mensagem com `/agente` (ou toque em
   **🪶 Agente**) para o Claude operar um repositório remoto via ferramentas
   (ler / buscar / editar / rodar), com aprovação para ações sensíveis.

6. **Bloquear** — o cadeado 🔒 (ou 5 min de inatividade) limpa a chave da memória;
   é preciso digitar a senha novamente para voltar a decifrar.

---

## Configuração (.env)

Copie de [`.env.example`](./.env.example). Variáveis do servidor:

| Variável           | Obrigatória | Default                                        | Para que serve                                                              |
|--------------------|-------------|------------------------------------------------|----------------------------------------------------------------------------|
| `ACCESS_PASSWORD`  | Recomendada | gerada aleatória e impressa no log             | Senha de login **e** semente da chave E2EE (veja aviso abaixo)             |
| `DATABASE_URL`     | **Sim**     | serviço `db` do compose                        | Conexão Postgres: `postgres://user:pass@host:5432/db`                       |
| `DATABASE_SSL`     | Não         | off                                            | `1`/`true`/`require` quando o Postgres exige TLS (provedores gerenciados)   |
| `DATABASE_POOL_MAX`| Não         | `10`                                           | Tamanho máximo do pool de conexões                                          |
| `TRUST_PROXY`      | Não         | `1` no `.env.example`                          | Ativa leitura de `X-Forwarded-For` atrás de proxy (Caddy/Fly)              |

> ⚠️ **A segurança depende inteiramente da senha.** `ACCESS_PASSWORD` é ao mesmo
> tempo a senha de login **e** a semente da chave E2EE. Use uma passphrase longa
> e única em produção e **nunca** a versione (ela mora em `.env`, que está no
> `.gitignore`). Em produção/Fly, use secrets.

---

## Como funciona o E2EE

- O cliente deriva uma chave **AES-256-GCM** a partir da senha via
  **PBKDF2-SHA256, 600.000 iterações**. A chave vive **apenas em memória** no
  navegador (a página **auto-bloqueia após 5 min** de inatividade, limpando a
  chave).
- Todo conteúdo (mensagens, nomes e bytes de arquivos, títulos) é cifrado **no
  cliente**. Formato do payload: `E1.<base64(iv)>.<base64(ciphertext||tag)>`
  (IV de 12 bytes aleatório por mensagem, tag de 16 bytes).
- O `salt` do PBKDF2 é **público por design** e servido em `GET /e2ee-salt`
  junto dos parâmetros (`{ version, algo, iterations, salt }`). Ele é gerado uma
  única vez no primeiro boot e guardado na tabela `config` do Postgres.
- O servidor só recebe/armazena ciphertext — **nunca** o plaintext nem a chave.

---

## Estrutura do repositório

```
indioflechudo/
├── server/            # Backend: Express + Socket.io + Postgres
│   ├── index.js       #   rotas HTTP, auth, sockets, handlers
│   └── db.js          #   pool pg + schema + repositório (tasks/messages/files/config)
├── public/            # Frontend (servido pelo app)
│   └── index.html     #   app single-file (E2EE no cliente, sem build)
├── bridge/            # Worker headless: responde no chat via Claude Code CLI
│   └── service/       #   install/uninstall como LaunchAgent (macOS)
├── mcp/               # MCP server (roda no Mac): expõe ferramentas do agente
├── client/            # Executor + pings (rodam na máquina do codebase/VDI)
├── docker-compose.yml # app + db (postgres:16) + caddy
├── Dockerfile         # imagem do app (node:20-alpine)
├── Caddyfile          # reverse proxy + TLS
├── start.sh / stop.sh # sobe/derruba o stack local
└── .github/workflows/ # deploy Fly
```

---

## Bridge automático (responder com o Claude)

O `bridge/` é um worker **headless** que age como "mais um cliente" do relay:
quando chega uma mensagem do lado **`input`**, ele decifra, pergunta ao
**Claude** e posta a resposta de volta como **`response`** — o outro lado só
abre o chat e lê.

- **Sem custo de API**: usa o `claude -p` (reusa sua assinatura do Claude Code).
  Chat puro roda com `--tools ""` (sem acesso a filesystem/bash).
- **Tipos de arquivo**: texto (csv, svg, ts, json…) inline; **xlsx** via
  exceljs; **zip** via adm-zip; **imagens** (png/jpg/gif/webp) via ferramenta
  Read (visão), num arquivo temporário apagado depois.
- **Memória por task**: cada task vira uma sessão do Claude Code (UUID
  determinístico). A 1ª mensagem cria; as seguintes usam `--resume`, mantendo o
  contexto mesmo após restart do worker.
- **E2EE preservado**: o bridge tem a senha, deriva a mesma chave AES e é só
  mais um cliente — o servidor continua cego.

O bridge roda **no host** (onde o `claude` está instalado e autenticado), não no
Docker. Ele fala com o relay pela porta publicada no localhost (**3998**):

```bash
cd bridge
npm ci
node --env-file=../.env bridge.js     # reusa ACCESS_PASSWORD do .env do relay
```

Overrides opcionais (modelo, binário, timeout, system prompt) em
[`bridge/.env.example`](./bridge/.env.example).

No cliente há um seletor **Responder: 🤖 Claude / 👤 Eu** — o bridge só responde
quando "🤖 Claude" está ativo. Cada mensagem mostra o autor (🤖 Claude / 👤 Você).

### Rodar como serviço (macOS — sobe no login, reinicia se cair)

```bash
./bridge/service/install-launchd.sh     # gera o plist com seus caminhos e carrega
tail -f ~/Library/Logs/indioflechudo-bridge.out.log
./bridge/service/uninstall-launchd.sh   # para remover
```

> ⚠️ O bridge tem a senha do relay (= chave E2EE). Trate-a como segredo de alto
> valor e rode o worker com privilégio mínimo.

---

## Modo agente (operar um repositório remoto)

Além do chat, o bridge pode entrar em **modo agente** (prefixo `/agente`,
`@agente` ou `@repo` numa mensagem). Nesse modo o Claude opera um repositório que
vive em **outra máquina** (ex.: a VDI corporativa) através de ferramentas MCP:

```
Claude (no Mac) ──► mcp/server.mjs (no Mac) ──relay(E2EE)──► client/executor.js (na VDI)
```

- `mcp/server.mjs` expõe as ferramentas ao Claude e encaminha cada chamada
  cifrada pelo relay.
- `client/executor.js` roda na máquina do codebase, executa a operação dentro do
  `REPO_DIR` e devolve o resultado (cifrado).
- Ferramentas: `list_dir`, `read_file`, `glob`, `grep` (leitura); `write_file`,
  `edit_file`, `run` (escrita/execução — **gated por aprovação** e por flags
  `--write` / `--run`, com allowlist de comandos).

Detalhes e payloads em [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Deploy (Fly)

O relay é feito para ser **hospedado publicamente** — é seguro porque é cego
(só ciphertext). O alvo é o **Fly.io**: o workflow
[`.github/workflows/fly-deploy.yml`](./.github/workflows/fly-deploy.yml) roda
`flyctl deploy --remote-only` em cada push na `main`.

> **Por que Fly e não ngrok?** A VDI corporativa de destino bloqueia o ngrok
> (categoria na blocklist), mas alcança `fly.dev` (app hosting) direto, sem
> proxy. Como o relay é E2EE cego, hospedá-lo em endereço público é seguro.

Para o deploy funcionar ainda faltam (veja pendências):

1. **`fly.toml`** na raiz (app Fly próprio, distinto de outros projetos).
2. Um **Postgres** (Fly Postgres ou gerenciado externo).
3. Secrets no app Fly: `ACCESS_PASSWORD`, `DATABASE_URL`
   (`DATABASE_SSL=1` se o Postgres externo exigir TLS) e `FLY_API_TOKEN` no
   GitHub Actions.

---

## Notas de segurança

- **Servidor cego**: todo dado persistido é ciphertext; chave e plaintext nunca
  saem do cliente.
- **Auth**: comparação de senha em tempo constante (`timingSafeEqual`),
  rate-limit no `/login` + **lockout escalonado por IP** (5 falhas → 30s,
  dobrando até 30 min). Sessão em cookie `httpOnly` + `SameSite=Lax`, expira em
  24h.
- **Headers**: CSP **sem origens externas** (nada de CDN), `X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- **Sem CDN**: o cliente Socket.io e o `marked` são servidos localmente (SRI).

---

## Estado atual e pendências

**Validado** (2026-07-02, end-to-end local): schema criado, login, criar task e
persistência confirmada no Postgres.

**Pendências conhecidas:**

- [ ] **`fly.toml` ausente** — o workflow de deploy existe mas falha até criá-lo
      (+ Postgres gerenciado + secrets). Deploy foi adiado por decisão do dono.
- [ ] **Rota `/dl/:name`** (download do bundle do executor) **não foi portada** —
      dependia de `data/dist` em disco; refazer servindo da imagem ou do DB.
- [ ] Os defaults de `RELAY_URL` no `client/` usam o placeholder
      `https://your-app.fly.dev` — troque pela URL Fly real quando existir.

---

## Licença

Uso pessoal/interno. Sem garantias.
