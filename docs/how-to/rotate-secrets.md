# Como rotacionar os segredos da API

Procedimento por segredo, com o impacto de cada troca e a ordem que evita derrubar a captação. A senha da role
`lp_api` tem runbook próprio: [rotate-db-role-password](rotate-db-role-password.md) (não é duplicada aqui).
Inventário e contrato das variáveis: [environment](../reference/environment.md).

> **Quem executa e aprova.** Só o dono do projeto (ele tem acesso aos consoles, à Vercel e ao gerenciador de
> senhas). Rotação em produção é ação externa: nem subagents nem automações a executam, e nenhum valor passa
> pelo chat, por PR, issue ou log. `.env.local` é editado apenas pelo dono.

## Quando usar

- **Rotina**, conforme a tabela de cadência.
- **Imediatamente** em suspeita de vazamento (valor em log, em commit, em screenshot, máquina comprometida,
  ex-colaborador com acesso): segredo vazado é segredo comprometido — rotacione, não tente "limpar o histórico".
  Ordem por raio de dano: senha `lp_api` → token do Upstash → token da Meta → QStash → Turnstile → pepper.

| Segredo (variável) | Onde vive | Cadência | Impacto se errar | Janela sem proteção/serviço |
|---|---|---|---|---|
| Senha `lp_api` (`DATABASE_URL`) | Vercel; Supabase | 90 dias ([runbook](rotate-db-role-password.md)) | `503 service_unavailable` | segundos entre `\password` e o redeploy |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel; Upstash | proposta: 180 dias | rate limit **fail-open** e idempotência só no banco | da reset do token até o redeploy |
| `TURNSTILE_SECRET_KEY` | Vercel; Cloudflare | proposta: 180 dias | **fail-closed**: `503 bot_verification_unavailable` (ninguém envia) | nenhuma, se houver o período de graça |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | Vercel; Upstash | proposta: 90 dias | `401` nas rotas internas, eventos ficam `pending` | nenhuma, se a ordem for respeitada |
| `QSTASH_TOKEN` | Vercel; Upstash | proposta: 180 dias | publish falha, sweeper republica | da reset do token até o redeploy |
| `META_CAPI_ACCESS_TOKEN` | Vercel; Meta Business | 6 meses (tracking §5.2) | entregas `dead` com `meta_auth_error` | nenhuma, se revogar só depois |
| `GA4_API_SECRET` (opcional) | Vercel; GA4 | se o destino for ligado | entregas `ga4_mp` falham | nenhuma |
| `HASH_PEPPER` | Vercel | **só por suspeita** (ver abaixo) | contadores zerados; hashes antigos incomparáveis | rate limit recomeça do zero |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` (CLI/CI) | GitHub Environment protegido | trimestral (overview Q7) | só o pipeline de migration falha | n/a (fora do runtime) |

"Proposta" = cadência sugerida por esta onda, ainda não decidida em spec; o dono confirma e a registra.

## Pré-requisitos (para qualquer rotação)

- Gerenciador de senhas aberto; os valores novos nascem e ficam lá. **Guarde o valor antigo até a verificação
  terminar** — ele é o rollback.
- Janela de baixo tráfego e nenhuma campanha nova entrando no ar. Avise o canal do projeto.
- Ambientes separados: **Preview e Production têm valores distintos**. Rotacione e valide primeiro no Preview.
- Verifique o que está implantado antes: `GET /v1/health` responde `200` e não há `error`/`warn` anormal nos
  logs da última hora.
- Atualizar uma variável na Vercel **não** altera o deploy em execução: só vale após um novo deploy.

Forma de atualizar uma variável sem expor o valor (`<VAR>` e o ambiente são placeholders):

```bash
vercel env rm <VAR> production --yes     # se já existir
vercel env add <VAR> production          # cola o valor no prompt (marcar Sensitive no painel)
vercel deploy --prod                     # ou Redeploy no painel
```

## Verificação comum (depois de cada rotação)

1. `GET https://<api>/v1/health` → `200`.
2. Um envio real do formulário (de preview, com chaves de teste) → `202` e a submissão no banco.
3. Logs sem `rate limit backend unavailable`, `turnstile verification unavailable`, `qstash signature rejected`
   nem `meta capi` com `meta_auth_error` após o deploy.
4. Métricas: `ratelimit.fail_open` = 0, `antibot.failures{reason="unavailable"}` = 0,
   `auth.qstash_signature_invalid` = 0 (**[5b]**), `outbox.lag_s` normal.
5. Só então revogue o valor antigo e registre data da rotação e próxima data no gerenciador de senhas.

## Turnstile — `TURNSTILE_SECRET_KEY`

Falhar aqui é **fail-closed**: segredo inválido faz o siteverify devolver `invalid-input-secret`, que o
adapter trata como indisponível (`503 bot_verification_unavailable`, log `error`). Por isso a ordem importa.

1. Cloudflare → Turnstile → o widget do formulário → **Rotate secret key**. Escolha o modo que **mantém a chave
   anterior válida por um período de graça** (a opção "invalidar imediatamente" é para vazamento). Confira o
   comportamento atual no painel antes de confirmar.
2. Copie a chave nova direto para o gerenciador de senhas. A `sitekey` (pública) **não muda**: a LP não precisa
   de deploy.
3. Atualize `TURNSTILE_SECRET_KEY` (Preview primeiro) e faça o redeploy.
4. Verifique (comum). Teste também um token inválido: deve dar `403 bot_verification_failed`, não `503`.
5. Deixe o período de graça expirar (ou invalide a antiga no painel) e apague o valor antigo.

Para trocar também a `sitekey` (widget novo, ex.: ataque com tokens do seu widget): crie o widget, atualize
`TURNSTILE_SITE_KEY` na LP (deploy do Codex), `TURNSTILE_SECRET_KEY` na API e `allowed_origins`/hostnames; faça
os dois deploys próximos e avise: entre eles os envios falham com `403`.

## Upstash Redis — `UPSTASH_REDIS_REST_TOKEN`

O token REST é derivado do banco Redis; reiniciá-lo invalida o antigo **na hora** (não há dois tokens de
escrita simultâneos). Entre o reset e o redeploy toda chamada ao Redis falha: o rate limit faz **fail-open**
(spec §7) e a idempotência recai no `UNIQUE` do banco. Nenhum lead se perde, mas a proteção contra abuso cai
para só o Turnstile, então faça em horário calmo e, se possível, com a regra de Firewall por IP ativa
(Onda 6b) como rede de segurança.

1. Gerenciador de senhas pronto; abra a aba de Environment Variables da Vercel já na variável.
2. Upstash → o banco Redis → **Reset password / Regenerate token** (nome do botão varia). `UPSTASH_REDIS_REST_URL`
   não muda.
3. Atualize `UPSTASH_REDIS_REST_TOKEN` e faça o redeploy imediatamente.
4. Verifique (comum), com atenção a `ratelimit.fail_open`. Os contadores `lp:rl:*` existentes continuam
   valendo (mesmo banco).
5. Rollback: não há como reativar o token antigo; gere outro e repita.

## QStash — chaves de assinatura (`QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY`)

A API aceita assinatura feita com a chave **current ou next** (`qstash-signature.ts`): é isso que permite
rotação sem queda, **desde que a ordem abaixo seja seguida**. Estado inicial: o console do QStash e a Vercel
mostram o mesmo par (`current = A`, `next = B`).

1. Confira que `current`/`next` da Vercel batem com o console (se não batem, corrija antes de rotacionar).
2. Console do QStash → **Rotate signing keys**. A partir daí o QStash assina com `B` e gera um novo `next = C`.
   A API ainda tem `A`/`B` e continua aceitando, pois `B` está no slot `next`.
3. Atualize na Vercel: `QSTASH_CURRENT_SIGNING_KEY = B` e `QSTASH_NEXT_SIGNING_KEY = C`; redeploy.
4. Verifique (comum) e dispare um evento: `auth.qstash_signature_invalid` continua 0 e há entregas.
5. Descarte `A`. **Nunca** rotacione duas vezes antes de atualizar a Vercel (a chave que assina deixaria de
   estar em qualquer slot da API).

Dependência: as rotas `/internal/v1/outbox/*` são da **Onda 5b**. Até lá a verificação roda só nos testes; as
variáveis ainda precisam ser mantidas em sincronia com o console.

## QStash — `QSTASH_TOKEN`

O token só **publica** mensagens (e agenda schedules). Reset invalida o antigo imediatamente: o publish pós-commit
falha (`OutboxPublishError`, engolido no `waitUntil`) e os eventos ficam `pending` até o sweeper republicar com
o token novo.

1. Console do QStash → **Reset token**; copie para o gerenciador de senhas.
2. Atualize `QSTASH_TOKEN` e faça o redeploy imediatamente.
3. Verifique (comum). Eventos `pending` acumulados na janela são republicados pelo sweeper (**[5b]**; sem ele,
   use o passo manual do runbook [reprocess-dead-letters](reprocess-dead-letters.md)).
4. O script de schedules (**[5b]**, `scripts/qstash-schedules.ts`) também usa o token: rode-o de novo só se o
   schedule do sweeper precisar ser recriado.

## Meta — `META_CAPI_ACCESS_TOKEN`

O token é de _System User_ com permissão só no Pixel/dataset (tracking §5.2). Tokens antigos continuam válidos
até serem revogados, então dá para rotacionar sem janela de falha.

1. Meta Business Settings → Users → System Users → o usuário da integração → **Generate token** com o mesmo app
   e **somente** o escopo necessário a CAPI; associe-o apenas ao dataset do Pixel. Copie para o gerenciador.
2. **Preview primeiro**: defina o token novo, `META_TEST_EVENT_CODE=<TESTxxxx>` (a config rejeita esse código em
   produção) e envie um lead de teste; confirme o evento em Events Manager → Test Events.
3. Produção: atualize `META_CAPI_ACCESS_TOKEN` e faça o redeploy. Confirme um envio real com
   `deliveries.status = 'sent'` e `external_ref` (`fbtrace_id`) preenchido (**[5b]**).
4. **Só então** revogue o token antigo na Meta e apague-o do gerenciador.
5. Se revogou cedo demais ou o token novo está errado: as entregas dessa janela viram `dead` com
   `last_error_code = 'meta_auth_error'`. Corrija o token e reprocesse conforme
   [reprocess-dead-letters](reprocess-dead-letters.md) (dentro da janela de 7 dias da Meta para `event_time`).

## GA4 — `GA4_API_SECRET` (somente se o destino estiver ligado)

GA4 Admin → Data streams → o stream → Measurement Protocol API secrets → **Create**; atualize a variável,
redeploy, verifique um evento (DebugView) e então **delete** o secret antigo. A Google exige o secret na query
string: a API redige a URL nos logs, mas confira que nenhum log/proxy a registra.

## `HASH_PEPPER` — só por suspeita de vazamento

O pepper alimenta o HMAC-SHA256 de IP e e-mail (chaves de rate limit no Redis e `capture.submissions.ip_hmac`).
**O código aceita um único pepper (não há sobreposição current/next)**, então a troca é um corte seco, com
efeitos que você precisa aceitar antes:

- Todos os contadores de rate limit e bloqueios por falhas de bot **zeram** (as chaves mudam): um atacante
  ativo ganha cota nova. Evite durante flood ([respond-to-lead-endpoint-flood](respond-to-lead-endpoint-flood.md))
  e tenha o Firewall como rede.
- Os `ip_hmac` e e-mails hasheados gravados antes **deixam de ser comparáveis** com os novos: correlação
  antifraude entre o antes e o depois é perdida. Registre no incidente a data e hora do corte.
- Não afeta: idempotência (chave = UUID do cliente; o hash do payload é SHA-256 simples, sem pepper), dedupe de
  leads (por e-mail em claro no banco) nem os hashes SHA-256 enviados à Meta (sem pepper).
- Deploys em andamento convivem alguns segundos com o valor antigo; não há inconsistência de dados, só de
  contadores.

Passos: `openssl rand -base64 32` direto para o gerenciador de senhas (mín. 32 bytes; o boot falha com menos) →
atualize `HASH_PEPPER` (Preview primeiro) → redeploy → verificação comum → apague o antigo. Não faça rotação de
rotina deste valor.

## CLI e CI (Supabase)

`SUPABASE_ACCESS_TOKEN` e `SUPABASE_DB_PASSWORD` nunca estão no runtime (ADR-0003). A cada trimestre
(overview Q7): Supabase → Account → Access Tokens → crie um token novo de menor escopo → atualize o secret do
**GitHub Environment protegido** → rode o job de migration em modo de verificação → revogue o antigo. A senha do
usuário `postgres` (painel Database → Reset database password) segue o mesmo padrão e afeta apenas a CLI/CI e o
acesso administrativo manual; não é a senha da `lp_api`.

## Em caso de vazamento confirmado

1. Rotacione primeiro o segredo vazado, **sem esperar janela de baixo tráfego**; aceite a degradação descrita
   acima. Para a `lp_api`, corte o login antes (`ALTER ROLE lp_api NOLOGIN`, ver o runbook dela).
2. Revise logs e `core.audit_log` do período exposto; verifique uso indevido nos consoles (Meta Events Manager,
   Upstash, Cloudflare).
3. Se houve acesso a dados pessoais, abra o procedimento de incidente de segurança (LGPD art. 48) com o dono.
4. Registre linha do tempo; corrija a causa (como o valor chegou ao lugar errado) e, se for o caso, a regra do
   gitleaks.

## Rollback

Rotação é troca de valor, não de versão do código: o rollback é recolocar o valor antigo (guardado até a
verificação) e fazer redeploy, **exceto** onde o provedor invalida na hora (Upstash, `QSTASH_TOKEN`,
Turnstile "invalidar imediatamente", Meta após revogar): nesses casos gere um valor novo e repita.
