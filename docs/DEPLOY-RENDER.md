# Deploy no Render (grátis) + Postgres no Neon

Alternativa ao Fly para hospedar o relay publicamente. O Render dá HTTPS e um
subdomínio (`*.onrender.com`) automaticamente; o Postgres fica no **Neon** (free,
não expira). O relay é E2EE/cego, então hospedar em endereço público é seguro.

> ⚠️ **Limitações do plano free do Render:** o serviço **hiberna após ~15 min**
> de inatividade (cold start de ~1 min na volta). Contorno na etapa 5 (pinger).
> Por isso o Postgres fica no Neon (não no Render, cujo Postgres free expira em
> 90 dias).

O que já está pronto no repo: `render.yaml` (blueprint Docker), rota `/healthz`,
e a porta lida de `PORT` (injetada pelo Render).

---

## 1. Postgres no Neon (grátis)

1. Crie uma conta em **neon.tech** e um projeto (região próxima dos devs).
2. Copie a **connection string** (formato `postgres://user:pass@ep-xxx.neon.tech/dbname?sslmode=require`).
3. Guarde — vira o `DATABASE_URL` no Render (etapa 2). **Não** cole no git nem aqui.

> O schema é criado sozinho no primeiro boot (o app roda `initSchema()`).

## 2. Web Service no Render

1. Conta em **render.com** → **New → Blueprint** e conecte o repositório
   `gleidsonbalcazar/indioflechudo`. O Render lê o `render.yaml`.
   (Ou **New → Web Service → Docker**, apontando para o mesmo repo.)
2. Quando pedir os secrets (`sync:false`), preencha:
   - **ACCESS_PASSWORD** — uma passphrase longa e única (login + chave E2EE).
   - **DATABASE_URL** — a string do Neon da etapa 1.
   - (`DATABASE_SSL=1` e `TRUST_PROXY=1` já vêm do blueprint.)
3. **Create** → o Render builda a imagem (Dockerfile) e sobe. A URL fica algo como
   `https://indioflechudo.onrender.com`.

## 3. Validar

```bash
curl -s https://SEU-APP.onrender.com/healthz          # {"ok":true}
curl -s https://SEU-APP.onrender.com/e2ee-salt         # salt + params PBKDF2
```

Abra a URL no navegador → tela de login (tema Brasa) → entre com o `ACCESS_PASSWORD`.

## 4. Confirmar o alcance pela VDI (importante)

`render.com` abrir na VDI **não garante** que `*.onrender.com` abre. Da VDI, rode:

```
node corp-ping.js http://SEU-PROXY:8080 https://SEU-APP.onrender.com
```

(baixe o `corp-ping.js` da própria URL: `/dl/corp-ping.js`, ou veja `/onboard`).
Se der `CONNECT 200` + salt, o caminho está livre.

## 5. Manter acordado (contorna a hibernação)

O free hiberna após ~15 min. Um pinger grátis mantém de pé:

- Em **cron-job.org** ou **UptimeRobot** (free), crie um monitor que faz GET em
  `https://SEU-APP.onrender.com/healthz` a cada **10 minutos**.
- Isso mantém o serviço quente (dentro das ~750 h/mês do free de 1 serviço).

## 6. Apontar bridge/executor para o Render

No `.env` do host (bridge/mcp) e no comando do executor na VDI, use a URL nova:

```
RELAY_URL=https://SEU-APP.onrender.com
```

A página `/onboard` da URL nova já mostra os comandos com o endereço certo.

---

## Notas

- **Caddy não é usado** no Render (o Render termina o TLS). O `docker-compose`/Caddy
  continuam válidos só para rodar **local**.
- **Cold start**: a primeira conexão após hibernar leva ~1 min; o pinger evita.
- **Upgrade**: o plano **Starter (US$7/mês)** remove a hibernação, se o cold start
  incomodar.
- **Migração de dados**: o relay é cego; não há histórico legado em claro para
  migrar. Começa limpo no Neon.
