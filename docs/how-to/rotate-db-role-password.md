# Como definir e rotacionar a senha da role `lp_api`

A role `lp_api` é criada pela migration `core_schema` **sem senha** (ADR-0003). A senha nasce e é rotacionada
fora das migrations: ela nunca entra em código, migration, seed, commit, log ou chat. Use este procedimento
na criação do banco, a cada 90 dias e **imediatamente** se houver suspeita de vazamento.

## Antes de começar

- Acesso administrativo ao banco (role `postgres`, senha do painel do Supabase) — só você, o dono do projeto.
- `psql` e o CA do Supabase (painel → Database → SSL), para `sslmode=verify-full`.
- Acesso ao projeto na Vercel e um gerenciador de senhas aberto.
- Horário de baixo tráfego: existe uma janela curta (segundos) em que conexões novas falham (ver passo 4).

## Passos (produção ou preview)

1. **Gere a senha** e guarde direto no gerenciador de senhas (não imprima no terminal compartilhado):

   ```bash
   openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n'
   ```

   O alfabeto URL-safe evita escapes na `DATABASE_URL`.

2. **Prepare o valor novo na Vercel sem ativá-lo**: Project Settings → Environment Variables (marque
   *Sensitive*) ou `vercel env add DATABASE_URL production` e cole o valor no prompt. O deploy em execução
   continua com o valor antigo até o próximo deploy.

   ```text
   postgresql://lp_api.<project_ref>:<senha>@<pooler-host>:6543/postgres?sslmode=verify-full
   ```

   Pooler Supavisor em *transaction mode* (porta 6543), usuário `lp_api.<project_ref>`. O CA vai em
   `DATABASE_CA_CERT` e não muda na rotação. `.env.local` é editado só pelo dono do projeto.

3. **Troque a senha no banco** com `\password`, que faz o hash SCRAM no cliente (a senha em texto puro nunca
   chega ao servidor nem aos logs). Conecte como `postgres` na conexão direta (ou no pooler em modo session,
   porta 5432, se a rede for só IPv4):

   ```bash
   psql "postgresql://postgres@db.<project_ref>.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=<ca.pem>"
   ```

   ```text
   postgres=> \password lp_api
   Enter new password for user "lp_api":      <cole a senha do passo 1>
   Enter it again:                            <cole novamente>
   ```

   Não use `ALTER ROLE lp_api PASSWORD '...'` no SQL Editor: o texto fica em histórico e logs de query.

4. **Faça o redeploy imediatamente** para a API ler a nova variável (`vercel deploy --prod` ou *Redeploy* no
   painel). Entre os passos 3 e 4 as conexões novas falham com `503 service_unavailable` (`Retry-After`); o
   front reenvia com a mesma `Idempotency-Key`, então nenhum lead é perdido. Conexões já abertas continuam
   até serem recicladas.

5. **Verifique** com a senha nova (via `psql` com `PGPASSWORD` lido do gerenciador, ou pelo health check da
   API depois que a wave 4 existir):

   ```sql
   SELECT current_user, current_setting('statement_timeout') AS stmt_timeout, current_setting('search_path') AS path;
   -- esperado: lp_api | 3s | ""
   SELECT count(*) FROM crm.leads;          -- esperado: 0 (sem app.workspace_id, a RLS não mostra linhas)
   SELECT pg_sleep(4);                       -- esperado: ERROR canceling statement due to statement timeout
   ```

6. **Revogue o antigo**: depois de confirmar o deploy novo saudável, apague o valor antigo do gerenciador de
   senhas e registre a data da rotação (próxima em 90 dias).

Se o deploy novo falhar na autenticação, rode `\password lp_api` de novo com a senha do passo 1 e confira se o
valor salvo na Vercel é o mesmo (erro comum: espaço ou quebra de linha colados junto).

## Suspeita de vazamento

Trate a senha como comprometida (não tente "limpar" histórico). No `psql` como `postgres`:

```sql
ALTER ROLE lp_api NOLOGIN;                                              -- corta novas conexões
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'lp_api';
```

Depois siga os passos 1–5 e, ao final, reabilite o login: `ALTER ROLE lp_api LOGIN;`. Revise o audit log
(`core.audit_log`) e os logs do Supabase do período exposto. Lembre que `lp_api` não tem `DELETE`, DDL nem
`BYPASSRLS`: o dano possível fica limitado a `SELECT`/`INSERT`/`UPDATE` no workspace que o atacante conseguir
selecionar.

## Banco local (`supabase start`)

O banco local não tem senha para `lp_api`. Para testar a API contra ele, defina uma senha descartável (só vale
para esse banco):

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54722/postgres"
```

```text
postgres=> \password lp_api
```

`DATABASE_URL` local: `postgresql://lp_api:<senha-local>@127.0.0.1:54722/postgres` (sem TLS no loopback).
Roles são globais ao cluster e **sobrevivem ao `supabase db reset`**, então a senha local também sobrevive;
`supabase stop --no-backup` apaga o volume e a role.

No CI, o job de integração cria a stack efêmera e define uma senha aleatória por execução, mascarada nos logs
(`::add-mask::`), nunca reaproveitada entre jobs.

## O que nunca fazer

- Colocar a senha em migration, seed, `config.toml`, código, issue, PR ou conversa com agente.
- Usar `service_role`/chave secreta do Supabase na API como atalho (ADR-0003).
- Compartilhar a `DATABASE_URL` de produção com ambientes de preview: cada ambiente da Vercel tem o seu valor.
