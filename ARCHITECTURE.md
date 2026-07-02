# Arquitetura — indioflechudo

Referência técnica do relay E2EE. Visão de produto e como rodar estão no
[README](./README.md).

---

## 1. Componentes

```
┌──────────────────┐        ┌───────────────────────────┐        ┌──────────────────┐
│  Navegador        │  HTTPS │  Relay (servidor cego)     │  HTTPS │  Navegador/VDI    │
│  public/index.html│◄──────►│  server/index.js (Express) │◄──────►│  public/index.html│
│  - PBKDF2→AES-GCM │  WSS   │  server/db.js  (Postgres)  │  WSS   │  - PBKDF2→AES-GCM │
└──────────────────┘        └────────────┬──────────────┘        └──────────────────┘
                                          │
                                   ┌──────▼───────┐
                                   │ PostgreSQL 16│  tasks · messages · files(bytea) · config
                                   └──────────────┘

Automação (opcional, tudo cliente E2EE — o relay continua cego):
  bridge/bridge.js   (host/Mac)  → responde no chat via `claude -p`
  mcp/server.mjs     (host/Mac)  → expõe ferramentas do agente ao Claude
  client/executor.js (VDI/codebase) → executa as ferramentas no repositório remoto
```

- **app** (Docker): serve `public/` e a API; termina em `:3000` no container,
  publicado em `127.0.0.1:3998`.
- **db** (Docker): `postgres:16-alpine`, volume `pg_data`.
- **caddy** (Docker): reverse proxy + TLS (`:8444` HTTPS, `:8081` HTTP→HTTPS).

---

## 2. Schema Postgres (`server/db.js`)

Substitui a persistência JSON do projeto original. Só ciphertext é armazenado.

### `tasks`
| Coluna       | Tipo   | Notas                          |
|--------------|--------|--------------------------------|
| `id`         | TEXT PK|                                |
| `title`      | TEXT   | NOT NULL (cifrado no cliente)  |
| `status`     | TEXT   | `open` \| `archived`           |
| `created_at` | TEXT   | ISO 8601                       |
| `updated_at` | TEXT   | ISO 8601                       |

### `messages`  (índice em `(task_id, seq)`)
| Coluna       | Tipo      | Notas                                             |
|--------------|-----------|---------------------------------------------------|
| `seq`        | BIGSERIAL PK | ordem                                          |
| `id`         | TEXT      | id da mensagem (`msg-<rand>`)                      |
| `task_id`    | TEXT      | FK → `tasks(id)` ON DELETE CASCADE                 |
| `side`       | TEXT      | `input` \| `response`                             |
| `type`       | TEXT      | `text` \| `file`                                  |
| `text`       | TEXT      | ciphertext (texto) ou metadados (arquivo)         |
| `author`     | TEXT      | `human` \| `claude`                               |
| `respond_by` | TEXT      | `human` \| `claude` (quando `side=input`)         |
| `agent_mode` | BOOLEAN   | default `false`                                   |
| `file_name`  | TEXT      | nome sanitizado (quando `type=file`)              |
| `file_size`  | BIGINT    | tamanho                                           |
| `file_path`  | TEXT      | `task-<taskId>/<fileName>`                         |
| `timestamp`  | TEXT      | ISO 8601                                          |

### `files`  (PK composta `(task_id, name)`)
| Coluna    | Tipo   | Notas                              |
|-----------|--------|------------------------------------|
| `task_id` | TEXT   | FK → `tasks(id)` ON DELETE CASCADE |
| `name`    | TEXT   | nome sanitizado                    |
| `size`    | BIGINT | tamanho do binário cifrado         |
| `data`    | BYTEA  | **binário cifrado (E2EE)**         |

### `config`  (chave/valor)
| Coluna  | Tipo    | Notas                                          |
|---------|---------|------------------------------------------------|
| `key`   | TEXT PK | ex.: `e2ee_salt`                               |
| `value` | TEXT    | ex.: salt base64 (32 bytes, criado no 1º boot) |

---

## 3. Rotas HTTP (`server/index.js`)

| Método | Rota                            | Auth | Descrição                                   |
|--------|---------------------------------|------|---------------------------------------------|
| POST   | `/login`                        | —    | Autentica; devolve cookie de sessão         |
| GET    | `/auth-check`                   | —    | Valida a sessão atual                       |
| GET    | `/e2ee-salt`                    | —    | Salt + params PBKDF2 (público)              |
| GET    | `/tasks`                        | ✔    | Lista tasks (com última mensagem)           |
| POST   | `/tasks`                        | ✔    | Cria task                                    |
| PATCH  | `/tasks/:id`                    | ✔    | Atualiza título/status                       |
| DELETE | `/tasks/:id`                    | ✔    | Remove task (cascata: mensagens + arquivos) |
| POST   | `/tasks/:id/upload`             | ✔    | Upload (multipart → `bytea`)                |
| GET    | `/tasks/:id/files`              | ✔    | Lista arquivos (nome, tamanho)              |
| GET    | `/tasks/:id/files/:filename`    | ✔    | Baixa binário cifrado                       |
| DELETE | `/tasks/:id/files`              | ✔    | Limpa todos os arquivos da task             |
| DELETE | `/tasks/:id/files/:filename`    | ✔    | Remove um arquivo                           |

Limites: body JSON 5 MB; upload até 25 MB (server) / 10 MB plaintext (front).

---

## 4. Eventos Socket.io

### Cliente → Servidor
| Evento                     | Payload                                                             | Persistido |
|----------------------------|--------------------------------------------------------------------|------------|
| `task:join`                | `taskId`                                                            | —          |
| `task:leave`               | —                                                                  | —          |
| `message:send`             | `{ taskId, text, side?, author?, respondBy?, agentMode? }`         | **sim**    |
| `task:status`              | `{ taskId, phase }` (`working`\|`reading`\|`thinking`\|`writing`\|`done`) | não  |
| `messages:clear`           | `taskId`                                                            | efeito     |
| `agent:join`               | —                                                                  | —          |
| `agent:rpc`                | `{ id, ... }` (opaco/E2EE)                                          | não        |
| `agent:rpc:result`         | `{ id, ... }` (opaco/E2EE)                                          | não        |
| `agent:approval:request`   | `{ id, taskId, ... }` (opaco/E2EE)                                  | não        |
| `agent:approval:response`  | `{ id, ... }` (opaco/E2EE)                                          | não        |
| `agent:event`              | `{ taskId, enc, ... }` (opaco/E2EE)                                 | não        |

### Servidor → Cliente
| Evento              | Escopo                    |
|---------------------|---------------------------|
| `task:history`      | cliente que entrou        |
| `message:new`       | sala `task:<id>`          |
| `task:created` / `task:updated` / `task:deleted` | broadcast |
| `task:status`       | sala `task:<id>`          |
| `messages:cleared`  | sala `task:<id>`          |
| `agent:*`           | sala `agent:main` ou `task:<id>` |

Os eventos `agent:*` carregam payload cifrado (opaco para o servidor) e suportam
o [modo agente](#6-modo-agente).

---

## 5. Segurança

### E2EE
- PBKDF2-SHA256, **600.000 iterações** → chave **AES-256-GCM**.
- IV de 12 bytes aleatório por mensagem; tag de 16 bytes.
- Envelope: `E1.<base64(iv)>.<base64(ct||tag)>`.
- Chave só em memória do navegador; **auto-lock em 5 min** de inatividade.
- Salt público em `GET /e2ee-salt`, persistido em `config.e2ee_salt`.

### Autenticação
- Senha comparada com `crypto.timingSafeEqual` (tempo constante; faz comparação
  dummy quando o tamanho difere, para não vazar comprimento).
- `express-rate-limit` no `/login` (10 tentativas / 60s).
- **Lockout escalonado por IP**: a partir de 5 falhas, 30s dobrando a cada nova
  falha, até o teto de 30 min; envia `Retry-After`; limpa no sucesso.
- **`isTrustedLocal`**: requisição sem `X-Forwarded-For` é considerada local
  confiável (host/rede Docker/bridge) e isenta do guard de brute-force — por
  isso `TRUST_PROXY=1` atrás de Caddy/Fly é importante.
- Sessão: token hex de 32 bytes em cookie `httpOnly` + `SameSite=Lax`, TTL 24h,
  guardada em memória (limpeza horária).

### Headers / CSP
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:;
  connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
```

### Modelo de ameaças (resumo)
- O relay (e quem tiver acesso ao Postgres) vê **apenas ciphertext** e metadados
  mínimos (tamanhos, timestamps, ordem). Não vê conteúdo nem chave.
- Toda a força criptográfica depende de `ACCESS_PASSWORD`. Comprometê-la
  compromete tudo.
- O bridge/executor, por terem a senha, são clientes confiáveis: trate seus
  hosts e o `.env` como segredos de alto valor.

---

## 6. Modo agente

Permite o Claude operar um repositório em **outra máquina** via ferramentas MCP,
sempre por cima do relay E2EE.

```
Claude (Mac) ──stdio──► mcp/server.mjs (Mac) ──agent:rpc (E2EE)──► relay
                                                                     │
                          client/executor.js (VDI/codebase) ◄───────┘
                          executa no REPO_DIR e devolve agent:rpc:result (E2EE)
```

- **Ativação**: prefixo `/agente`, `@agente` ou `@repo` numa mensagem; a task
  então "gruda" no modo agente.
- **Ferramentas**: `list_dir`, `read_file`, `glob`, `grep` (leitura);
  `write_file`, `edit_file`, `run` (mutação/execução).
- **Guardas do executor**:
  - Escrita só com `--write` (ou `AGENT_WRITE=1`); execução só com `--run` (ou
    `AGENT_RUN=1`), com **allowlist** do primeiro token do comando.
  - Caminhos validados para nunca escapar do `REPO_DIR`.
  - Aprovação interativa (`agent:approval:*`) para ações sensíveis.
  - Caps: leitura até 400 KB/arquivo; grep/glob até 300 resultados.

---

## 7. Deploy

- **Local**: `docker compose` (app + db + caddy) — veja o README.
- **Produção**: Fly.io. `.github/workflows/fly-deploy.yml` roda
  `flyctl deploy --remote-only` no push da `main` (precisa do secret
  `FLY_API_TOKEN`).
- **Pendências**: falta `fly.toml`, um Postgres gerenciado e os secrets
  (`ACCESS_PASSWORD`, `DATABASE_URL`, `DATABASE_SSL` se aplicável). Ver
  [README → Estado atual e pendências](./README.md#estado-atual-e-pendências).
