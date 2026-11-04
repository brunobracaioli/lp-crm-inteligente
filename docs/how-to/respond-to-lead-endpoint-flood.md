# Como responder a um flood ou ataque de bots no `POST /v1/leads`

Runbook de incidente para o endpoint público de captação ([ADR-0005](../adr/0005-public-lead-endpoint-compensating-controls.md)).
Cobre três situações que parecem iguais no painel e pedem respostas diferentes: **flood sem prova humana**
(custo e ruído, nenhum lead criado), **spam que passa pelo Turnstile** (leads falsos no CRM e conversões falsas
para a Meta) e **esgotamento do limite por formulário** (usuários reais recebem `429`).

> **Quem aprova.** Ler métricas, logs e rodar `SELECT` não precisa de aprovação. **Toda mudança em produção**
> (regra de Firewall, Attack Challenge Mode, variável de ambiente, `UPDATE` no banco, mudança no Turnstile,
> pausar campanha) é ação externa e exige a confirmação explícita do dono do projeto, registrada no canal do
> incidente. Subagents e automações não executam este runbook.

## Quando usar

Qualquer um dos sinais abaixo por mais de 5 minutos, ou um alerta da Onda 6b equivalente:

| Sinal | Onde olhar | O que indica |
|---|---|---|
| Pico de `antibot.failures` (por `reason`: `invalid_token`, `token_reused`, `hostname_mismatch`…) | métricas da Vercel | Bots sem token válido: nada é gravado, mas há custo (siteverify) |
| Pico de `ratelimit.blocked` por `scope` (`ip`, `ip_daily`, `ip_bot_block`, `form`, `email`) | idem | `ip*`/`ip_bot_block`: flood de poucos IPs. `form`: muitos IPs somando > 300 req/min. `email`: alvo repetido |
| **`ratelimit.fail_open` > 0** | idem + log `warn` "rate limit backend unavailable" | Redis fora ou sem cota: o rate limit **está desligado**, só o Turnstile protege |
| `lead_capture.requests{outcome}` com `accepted` anormal; leads novos em massa no CRM com a mesma UTM/área/empresa | métricas; CRM | Spam que passou pelo Turnstile (granja de cliques, resolvedor humano) |
| `503 bot_verification_unavailable` em série; log `error` "turnstile verification unavailable" (`cause: service_error`) | logs | Segredo do Turnstile errado/rotacionado, ou Cloudflare fora (fail-closed: ninguém envia) |
| Latência/`5xx` subindo; invocações e CPU da função disparando | Vercel Observability | Saturação |
| Uso de comandos/dia do Upstash perto da cota; cota de mensagens do QStash | consoles Upstash | Risco de fail-open e de publish falho |
| Consumo anômalo de verba nos anúncios sem aumento de leads reais | gerenciador de anúncios | Tráfego pago fraudulento chegando ao formulário |

**Antes de tratar como ataque**, descarte pico legítimo: houve campanha/post novo nos últimos 30 min? Os
`429` vêm de IPs corporativos compartilhados (NAT) de um evento? A taxa de `202` segue normal enquanto o volume
sobe (tráfego bom) ou despenca (ataque)?

## Pré-requisitos

- Acesso à Vercel (projeto da API), ao console da Cloudflare (Turnstile), ao Upstash e ao Supabase.
- Acesso administrativo ao banco (role `postgres`, conexão direta; ver
  [rotate-db-role-password](rotate-db-role-password.md) passo 3 para a string de conexão). Nunca use `lp_api`
  para operar: a senha dela vive só na Vercel.
- Canal de incidente aberto (dono + quem opera). Nome do formulário afetado (`form_key`) e `workspace_id`.
- Regra de ouro: **diagnostique por IDs, contagens e códigos**. Não copie e-mail, nome, WhatsApp, IP ou
  conteúdo de `message` para o canal, planilhas ou prompts.

## Passos

### 1. Triagem (5 min, só leitura)

1. Confirme o alcance nos logs da Vercel (JSON estruturado, filtrar por `route`/`outcome`/`correlation_id`).
   A flag exata do CLI pode variar por versão (`vercel logs --help`); pelo painel: Project → Observability /
   Logs, filtro `path:/v1/leads`.
2. Classifique:
   - **A. Flood sem token válido** → `antibot.failures` e `ratelimit.blocked` altos, poucos `accepted`.
   - **B. Spam com token válido** → `accepted` alto, leads novos suspeitos.
   - **C. Cota do formulário esgotada** → `ratelimit.blocked{scope="form"}` alto, usuários legítimos com `429`.
   - **D. Dependência fora** → `503`/`fail_open`; trate a dependência (Turnstile/Redis/Postgres), não o tráfego.
3. Medidas de impacto (somente contagens; rodar como `postgres`, sempre com `workspace_id`):

   ```sql
   -- Leads/submissões por hora nas últimas 24 h
   SELECT date_trunc('hour', created_at) AS hour, count(*) AS submissions
   FROM capture.submissions
   WHERE workspace_id = '<workspace_id>' AND created_at > now() - interval '24 hours'
   GROUP BY 1 ORDER BY 1;

   -- Concentração por origem (ip_hmac é HMAC; não é o IP) e por campanha
   SELECT ip_hmac, utm_source, utm_campaign, count(*) AS submissions
   FROM capture.submissions
   WHERE workspace_id = '<workspace_id>' AND created_at > now() - interval '2 hours'
   GROUP BY 1, 2, 3 HAVING count(*) >= 3 ORDER BY submissions DESC LIMIT 20;
   ```

### 2. Contenção — do menos ao mais intrusivo

Aplique um nível por vez, meça 5 minutos e só então suba. Cada passo precisa do OK do dono.

**Nível 1 — Firewall da Vercel (regra custom).** Painel: Project → Firewall → Configure → Add Rule.
Prefira _rate limit_ por IP para `POST /v1/leads` (ex.: 20 req/min) e _deny_ com expiração para IPs, ASNs ou
países claramente atacantes (que não sejam público-alvo). O rate limit da aplicação (5 req/10 min por IP) é a
segunda camada; o Firewall protege antes de gastar invocação. Depois da Onda 6b a regra vive como código:
uma regra criada no painel durante o incidente **deve** ser reconciliada no repositório depois (IaC).

**Nível 2 — Fechar a torneira do formulário atingido (kill switch por banco, reversível).**

```sql
UPDATE core.forms SET status = 'paused'
WHERE workspace_id = '<workspace_id>' AND form_key = '<frm_...>' AND status = 'active';
```

O endpoint passa a responder `404 form_not_found` para esse `form_key`; nada é gravado e o Turnstile nem é
consultado. É a contenção mais rápida contra o cenário B, mas **derruba também os leads reais**: combine com o
dono o texto que a LP mostrará (o front trata `404` como erro genérico). Confirme na Onda 4 que a busca de
formulário não é cacheada em memória; se for, o efeito só vale após o TTL.

**Nível 3 — Turnstile.** Cloudflare → Turnstile → widget do formulário: confira se a lista de hostnames
permitidos contém só os domínios da LP e revise a analítica (taxa de resolução, picos de tokens). Se o ataque
usa tokens gerados pelo seu próprio widget, crie um widget novo e rotacione o par de chaves seguindo
[rotate-secrets](rotate-secrets.md) (a `sitekey` da LP muda → exige novo deploy da LP, Codex). Não afrouxe o
Turnstile para "deixar passar" mais gente durante o incidente.

**Nível 4 — Attack Challenge Mode da Vercel.** Último recurso. Ele desafia o navegador com uma página de
verificação; um `fetch()` cross-origin da LP **não consegue resolver esse desafio**, então na prática ele
corta a captação por completo, e pode barrar o QStash em `/internal/*` (entregas ficam em retry). Antes de
depender dele, a Onda 6b precisa testar o comportamento com `fetch()` e definir a exceção de `/internal/*`
(assinatura QStash continua sendo a autenticação). Ative com prazo de término combinado.

**Redis sem cota ou fora (`fail_open`).** Aumente a cota/plano no console do Upstash ou aguarde o reset diário,
e ative o Nível 1 como substituto do rate limit enquanto durar. Os limites (5/10 min, 30/dia, 300/min, 3/h) são
constantes no código, não há botão de emergência: mudar exige PR.

**Conversões para a Meta (cenário B).** Para impedir que leads falsos virem eventos `Lead` de CAPI, desligue o
destino removendo `META_CAPI_ACCESS_TOKEN` da Vercel e fazendo redeploy (as entregas passam a
`skipped_disabled`) — **[5b]** comportamento a confirmar quando o dispatcher existir. Eventos já enviados não
podem ser recolhidos: avise o gestor de tráfego para excluí-los do público de otimização no Events Manager.

### 3. Dados: separar spam de lead real (cenário B)

1. Liste candidatos **por ID**, usando sinais objetivos (mesmo `ip_hmac`, mesma campanha, rajada de tempo,
   `antibot.challenge_age_s` quase zero). Nunca por conteúdo de campo pessoal.

   ```sql
   SELECT s.lead_id, count(*) AS submissions, min(s.created_at) AS first_seen
   FROM capture.submissions s
   WHERE s.workspace_id = '<workspace_id>' AND s.ip_hmac = '<ip_hmac_do_cluster>'
     AND s.created_at > now() - interval '24 hours'
   GROUP BY s.lead_id ORDER BY first_seen;
   ```

2. Revisão humana do dono ou de quem ele indicar (no CRM da Onda 9b/10, ou direto no banco enquanto não
   existir). Não há `lost_reason` de spam: o vocabulário atual (`crm.md` §4) tem `invalid_contact` e `other`;
   adicionar `spam` é migration (escritor único, Onda 6b/9b).
3. Marcação só com lista explícita de IDs aprovada, em transação e com registro no audit log:

   ```sql
   BEGIN;
   UPDATE crm.leads SET stage = 'lost', lost_reason = 'invalid_contact', version = version + 1
   WHERE workspace_id = '<workspace_id>' AND stage = 'new' AND id = ANY ('{<lead_id>,<lead_id>}'::uuid[]);

   INSERT INTO core.audit_log
     (workspace_id, actor_type, action, resource_type, result, correlation_id, metadata)
   VALUES ('<workspace_id>', 'user', 'ops.leads_marked_spam', 'lead', 'success', gen_random_uuid(),
           '{"incident":"<id-do-incidente>","count":<n>,"reason":"flood_cluster"}');
   COMMIT;
   ```

   Não apague nada: `lp_api` nem tem `DELETE`, e `capture.consents` é prova legal. Se o titular real pedir
   remoção, use a anonimização (`crm.anonymize_lead`, Onda 6b).
4. Confira se o spam já gerou entregas e, se sim, em que estado (**[5b]**):

   ```sql
   SELECT d.destination, d.status, count(*)
   FROM tracking.deliveries d
   WHERE d.workspace_id = '<workspace_id>' AND d.created_at > now() - interval '24 hours'
   GROUP BY 1, 2 ORDER BY 1, 2;
   ```

### 4. Comunicação

| Quando | Quem | Mensagem |
|---|---|---|
| Início (qualquer nível ≥ 1) | Dono do projeto | Sinal observado, cenário (A–D), nível aplicado, horário, `form_key` |
| Captação degradada ou pausada (níveis 2 e 4) | Dono → marketing/comercial | Leads podem não chegar entre `<hora>` e `<hora>`; reabrir quando o dono liberar |
| Tráfego pago suspeito | Dono → gestor de tráfego | Pausar campanhas/conjuntos envolvidos; preservar relatórios para pedido de ressarcimento |
| Leads falsos enviados à Meta | Dono → gestor de tráfego | Lista de janelas de tempo afetadas (sem PII) |
| Fim | Canal do incidente | Linha do tempo, impacto (leads reais perdidos: contar `404`/`429` legítimos), ações de follow-up |

Um flood **não** é, por si só, incidente de segurança de dados pessoais (LGPD art. 48). Se aparecer evidência
de acesso a dados (credencial vazada, consulta anômala ao banco, token de terceiro exposto), pare aqui, trate
como incidente de segurança e rotacione os segredos afetados ([rotate-secrets](rotate-secrets.md)).

## Verificação

- `antibot.failures` e `ratelimit.blocked` voltam ao patamar de antes do pico; `ratelimit.fail_open` = 0.
- Um envio real de uma rede limpa (aba anônima, rede móvel) devolve `202` e a submissão aparece no banco.
- Latência p95 < 800 ms e nenhum `5xx` nos últimos 15 min; lag do outbox < 10 min (**[5b]**:
  `outbox.lag_s`).
- Nenhum cluster novo na consulta de concentração do passo 1.

## Rollback (desfazer a contenção)

Na ordem inversa, cada item com o OK do dono, e só depois da verificação acima:

1. Nível 4: desligue o Attack Challenge Mode.
2. Nível 2: `UPDATE core.forms SET status = 'active' WHERE workspace_id = '<workspace_id>' AND form_key = '<frm_...>' AND status = 'paused';`
3. Nível 1: remova as regras temporárias (ou deixe expirar). Regras que se mostraram úteis viram PR de
   Firewall como código.
4. Recoloque `META_CAPI_ACCESS_TOKEN` (valor do gerenciador de senhas) e faça redeploy, se foi removido.
5. Retome campanhas pausadas.

## Depois do incidente

- Linha do tempo e métricas no registro do incidente (sem PII); decisão do que muda: limites, alertas,
  `lost_reason` de spam, Firewall como código.
- Atualize o [threat model](../security/threats/backend-v1.md) se surgiu vetor novo; ADR se mudou estrutura.
- Reconcilie qualquer mudança feita pelo painel com o repositório.
