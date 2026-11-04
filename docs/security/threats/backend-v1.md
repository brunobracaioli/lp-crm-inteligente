# Threat model — Backend v1 (lead capture, outbox, banco)

> Data: 2026-11-03 · Método: STRIDE + OWASP Top 10:2025 / API Top 10:2023
> Revisar ao abrir as waves 5 (CAPI), 9 (CRM API/staff auth) e 11 (LLM — acrescentar OWASP LLM/Agentic Top 10).

## Ativos

| Ativo | Sensibilidade |
|---|---|
| PII do lead (nome, e-mail, WhatsApp, empresa, mensagem, IP, UA) | Alta (LGPD) |
| Registro de consentimento | Alta (prova legal) |
| Tokens de terceiros (Meta CAPI, GA4, QStash, Upstash, Turnstile, senha `lp_api`) | Crítica |
| Integridade do funil (conversões enviadas às plataformas de ads) | Média/alta (otimização de mídia paga) |
| Disponibilidade da captação | Alta (receita) |

## Fronteiras de confiança

1. Browser ↔ LP (Cloudflare Pages) — conteúdo estático, tags de terceiros.
2. Browser ↔ API `POST /v1/leads` — **público**.
3. QStash ↔ API `/internal/*` — autenticado por assinatura.
4. API ↔ Postgres / Redis / Turnstile / Meta / Google — saída autenticada sobre TLS.

## STRIDE

| # | Ameaça | Categoria | Mitigação | Teste |
|---|---|---|---|---|
| T1 | Bot envia milhares de leads falsos (poluição do CRM, custo, envenenamento de CAPI) | Spoofing / DoS | Turnstile server-side, honeypot, rate limit IP/e-mail/form, Vercel Firewall | AC-LC-05, 06, 08 |
| T2 | Reuso de token Turnstile capturado | Spoofing | Token single-use + `challenge_ts` ≤ 300 s + `hostname`/`action` conferidos | AC-LC-06 |
| T3 | Site de terceiro posta no endpoint usando o navegador da vítima | Spoofing | Origin allowlist server-side (não só CORS), sem cookies/credenciais | AC-LC-07 |
| T4 | SQL Injection via campos do formulário | Tampering / EoP | Queries parametrizadas, Semgrep bloqueante, role sem DDL/DELETE, RLS, CHECKs | AC-LC-13, 14; AC-DB-04 |
| T5 | Mass assignment (`stage`, `score`, `owner_user_id` no corpo) | Tampering | Zod `.strict()`, DTO público sem esses campos | AC-LC-11 |
| T6 | XSS armazenado: payload no nome/mensagem executa no CRM | Tampering / EoP | Whitelist em nomes/empresa, escape automático (React), proibição de `dangerouslySetInnerHTML`, CSP do CRM | AC-LC-14; wave 10 |
| T7 | CSV/formula injection no export | Tampering | Prefixo `'` em células iniciadas por `= + - @ \t \r` | AC-CRM-07 |
| T8 | Trojan Source / homoglyph / bidi para enganar o vendedor | Spoofing | Rejeição de `\p{Cf}` e controles; NFC | AC-LC-13 |
| T9 | Chamada forjada a `/internal/v1/outbox/dispatch` | Spoofing | Assinatura QStash (corpo bruto, `sub` = URL, `exp`) com rotação current/next | AC-TR-03 |
| T10 | Replay de mensagem QStash | Tampering | `deliveries` UNIQUE por destino + status; idempotência por `outbox_event_id` | AC-TR-04 |
| T11 | Enumeração: descobrir se um e-mail já é lead | Information disclosure | Resposta idêntica (status/corpo/latência) para novo/existente/honeypot | AC-LC-04, 05 |
| T12 | PII em logs/traces/erros | Information disclosure | pino redaction, problem+json sem eco de valores, IDs internos nos logs, scanner de logs nos testes | AC-LC-17, 18 |
| T13 | Vazamento de tokens (CAPI em query string, logs de URL) | Information disclosure | `access_token` no corpo; URL do GA4 MP redigida; gitleaks | AC-TR-06 |
| T14 | PII enviada a terceiros sem consentimento | Information disclosure (LGPD) | Gate por `consent.ad_user_data` / `analytics_storage`; SHA-256 normalizado | AC-TR-02, 06 |
| T15 | Comprometimento da API permite ler toda a base | EoP / Info disclosure | Role `lp_api` mínima, RLS FORCE, schemas fora da Data API, sem chave secreta do Supabase no runtime | AC-DB-01..04 |
| T16 | Payload gigante / campos enormes / JSON profundo | DoS | Body ≤ 16 KB antes do parse, limites por campo, `maxItems`, `maxDuration` 10 s, `statement_timeout` 3 s | AC-LC-12 |
| T17 | Exaustão de cota Turnstile/Upstash/Meta por flood | DoS | Rate limit por IP **antes** do siteverify; limite por form; alertas | AC-LC-08 |
| T18 | Indisponibilidade de terceiro derruba captação | DoS | Outbox assíncrono; timeouts; fail-open documentado no rate limit | AC-LC-18; AC-TR-05 |
| T19 | Negação de ter dado consentimento / alteração de histórico | Repudiation | `capture.consents` append-only com versão da política; audit log append-only com correlation ID | AC-DB-05 |
| T20 | Dependência maliciosa / Action comprometida | Tampering (supply chain) | Lockfile, osv-scanner, Dependabot, Actions por SHA, `permissions: contents: read` | CI wave 0 |
| T21 | Spoofing de IP via `X-Forwarded-For` para fugir do rate limit | Spoofing | `ipAddress()` da Vercel; API não fica atrás de proxy de terceiros (ADR-0002) | unit do extrator de IP |
| T22 | Envenenamento de conversões (event_id forjado pelo cliente) | Tampering | `event_id` só deduplica; `UNIQUE (workspace_id, event_id)`; CAPI só após Turnstile + persistência | AC-LC-01 |

## Riscos residuais aceitos

| Risco | Justificativa | Revisão |
|---|---|---|
| Humanos reais (fazendas de clique) passam pelo Turnstile | Custo de mitigação adicional alto; score + revisão do vendedor filtram | após 30 dias de dados |
| Rate limit fail-open quando Upstash cai | Perder leads reais custa mais; Turnstile segue obrigatório | wave 6 |
| `GA4_API_SECRET` na query string (exigência da Google) | Chamada server-to-server, URL redigida em logs | se GA4 MP for ligado |
| Token estático do Supabase CLI no CI | Sem OIDC disponível; GitHub Environment protegido + rotação | trimestral |

## Revisão Onda 6a (2026-11-04)

> Método: leitura do código em `apps/api/src/`, das migrations/pgTAP em `supabase/`, de `.github/` e da
> configuração, contra a tabela STRIDE acima. Base: commit `58d960c` (ondas 0, 1, 2, 3 e 5a integradas; a
> Onda 4 — rota, repositórios Postgres e composition root — **ainda não existe** em `apps/api/src/`:
> `presentation/` está vazio e `index.ts` só monta `/v1/health`). "Implementado" abaixo significa _existe como
> componente testado_; a ameaça só fica mitigada de ponta a ponta quando a Onda 4/5b ligar o componente à
> rota. Nada foi executado contra ambiente remoto.

### Situação das mitigações (T1–T22)

| # | Situação | Evidência (arquivo) | Pendência / dono |
|---|---|---|---|
| T1 | Parcial | Turnstile `modules/lead-capture/infrastructure/turnstile-verifier.ts`; rate limit IP/e-mail/form + bloqueio por falhas `…/upstash-rate-limiter.ts`; honeypot e ordem dos passos em `…/application/submit-lead.ts` | Wiring na rota: **Onda 4**. Vercel Firewall e alertas: **Onda 6b** |
| T2 | Implementado (adapter) | `turnstile-verifier.ts`: `hostname`, `action`, `challenge_ts` ≤ 300 s, `timeout-or-duplicate` → `token_reused` | Ligar na rota: Onda 4. Ver N2 (chaves de teste) |
| T3 | Implementado (use case + CORS) | Allowlist global `platform/http-security/cors.ts`; Origin por formulário `modules/lead-capture/domain/origin.ts` usado no passo 5 de `submit-lead.ts` | Rota: Onda 4 |
| T4 | Parcial | Regras Semgrep `.semgrep/rules.yml` (bloqueantes no CI); role `lp_api` sem DDL/`DELETE`, RLS FORCE e CHECKs em `supabase/migrations/20261103220000_core_schema.sql` com pgTAP `supabase/tests/003_privileges.test.sql` e `004_constraints.test.sql` | Repositórios parametrizados e AC-LC-14 em integração: **Onda 4** |
| T5 | Implementado (domínio) | `modules/lead-capture/domain/submission.ts` (`rejectUnknownKeys` → `not_allowed`), teste AC-LC-11 em `apps/api/test/submit-lead.test.ts` | — |
| T6 | Parcial | Whitelist de nomes/empresa em `domain/rules.ts`; proibição de `dangerouslySetInnerHTML` no Semgrep | Escape no CRM e CSP do CRM: **Onda 10** |
| T7 | Pendente | — | Neutralização no export CSV: **Onda 9b** (AC-CRM-07) |
| T8 | Implementado (domínio) | `modules/lead-capture/domain/text.ts` (`isWellFormed`, NFC, rejeição de controle/formato via `FORBIDDEN_CHARACTERS` em `domain/rules.ts`) | — |
| T9 | Implementado (verificador) | `modules/tracking/infrastructure/qstash-signature.ts` (HS256, `iss`, `sub` = URL, `exp`/`nbf`, hash do corpo bruto, chave `current` ou `next`) | Rotas `/internal/v1/outbox/*`: **Onda 5b** |
| T10 | Parcial | `UNIQUE (outbox_event_id, destination)` (migration); `Delivery.isOpen` em `modules/tracking/domain/delivery.ts` | Dispatcher/sweeper e AC-TR-04: **Onda 5b** |
| T11 | Parcial | Mesmo corpo `202` para novo/existente/replay/honeypot em `submit-lead.ts` (R2) | Latência: ver N7. Medir no preview (Onda 4/6b) |
| T12 | Parcial | `platform/logger/redact.ts` + `logger.ts` (redação na saída), `platform/errors/problem.ts` (sem eco de valores), `error-handler.ts` | Scanner de logs AC-LC-17 e AC-LC-18 na integração: Onda 4. Ver N6 |
| T13 | Implementado | `meta-capi-client.ts` (`access_token` no corpo, `redirect: 'error'`, nada de token em log); `ga4-mp-client.ts` (`redactCollectUrl`, `redirect: 'manual'`); gitleaks no CI e no hook | AC-TR-06 ponta a ponta: Onda 5b |
| T14 | Implementado (domínio) | `modules/tracking/domain/consent-policy.ts` (`decideConsent`, `fieldAllowance`), `application/prepare-server-conversion.ts` (consentimento antes de qualquer hash) | Persistir `skipped_no_consent` no dispatcher: **Onda 5b** |
| T15 | Implementado (banco); runtime pendente | Role e RLS na migration + `supabase/tests/002_rls_isolation.test.sql` e `003_privileges.test.sql`; `platform/config/env.ts` não declara `service_role`; `SUPABASE_ACCESS_TOKEN`/`SUPABASE_DB_PASSWORD` fora do runtime | Cliente `postgres` com TLS `verify-full` e `set_config`: **Onda 4** |
| T16 | Parcial | `platform/http-security/body-limit.ts` (16 KB antes do parse), limites por campo em `domain/rules.ts`, `apps/api/vercel.json` (`maxDuration` 10), `statement_timeout` 3 s na role | Prazo total da requisição: ver N5 |
| T17 | Parcial | IP checado antes do siteverify em `submit-lead.ts`; alertas ainda não existem | Alertas e Firewall: **Onda 6b**. Ver N3 |
| T18 | Parcial | Timeouts: Turnstile 3 s, Redis 1 s, Meta/GA4/QStash 5 s; fail-open com métrica `ratelimit.fail_open` | Outbox assíncrono: Onda 5b |
| T19 | Implementado (banco) | Triggers append-only em `capture.consents`, `crm.lead_activities`, `core.audit_log` + pgTAP (AC-DB-05); `audit.append` e `consents.appendMany` em `submit-lead.ts` | Retenção do `audit_log` vs trigger: **Onda 6b** (ver N8) |
| T20 | Implementado | `.github/workflows/ci.yml` (Actions por SHA, `permissions: contents: read`), `osv-scanner`, `.github/dependabot.yml` (npm + actions), `pnpm-workspace.yaml` (`minimumReleaseAge` 7 dias) | SBOM e pin do ZAP por digest: **Onda 6b** |
| T21 | Implementado (extrator) | `platform/net/client-ip.ts` (só `x-real-ip` via `ipAddress()`, canonicalização, /64 para IPv6) | `trustVercelProxy: true` e tratamento de IP `null`: **Onda 4** (ver N4) |
| T22 | Implementado (use case) | `submit-lead.ts` (colisão de `event_id` → novo id do servidor), `UNIQUE (workspace_id, event_id)` | CAPI só após persistência: Onda 5b |

Riscos residuais aceitos acima continuam válidos. Um deles muda de estado: "Rate limit fail-open quando Upstash
cai" tem a métrica `ratelimit.fail_open` implementada, mas **o alerta e a rede de segurança do Firewall ainda
não existem** (6b); a "revisão na wave 6" passa a ser critério de saída da 6b.

### Novas ameaças e lacunas encontradas

| # | Severidade | Descrição | Evidência | Dono / ação |
|---|---|---|---|---|
| N1 | Alta (critério de aceite) | **AC-LC-19 não é mensurável com os limites atuais.** O limite por IP é 5 req/10 min e 30/dia, e o por formulário 300 req/min; um gerador de carga (1 IP) recebe `429` a partir da 6ª requisição, e 20 VUs a 1 req/s passam de 300/min. O k6 (`perf/lead-capture.js`) falha de propósito em `lead_accepted` | `upstash-rate-limiter.ts` (`LIMITS`, constantes sem override); lead-capture §6 e §9 | **Dono + Onda 4/6b**: decidir o perfil de limites do preview (ex.: valores lidos de env só com `APP_ENV=preview`, nunca em produção, com teste) ou bypass autenticado de teste. Exige código; fora do escopo desta onda |
| N2 | Alta (bloqueia 4/7b/6b) | **Chaves de teste do Turnstile podem ser rejeitadas pelo próprio adapter.** A Cloudflare documenta que a resposta de teste traz `hostname` próprio (exemplo: `localhost`), `action: test` e `challenge_ts` fixo; o adapter exige `hostname` ∈ origins do formulário, `action` = a do formulário e `challenge_ts` ≤ 300 s. O plano e a spec assumem que `curl` no preview "com chave de teste retorna 202" | `turnstile-verifier.ts` (`evaluateChallenge`); lead-capture §6 (linha "Ambientes"); documentação Cloudflare Turnstile (Testing) | **Onda 4**: validar com 1 chamada real ao siteverify antes de depender disso; se confirmado, relaxar `hostname`/`action`/idade **somente** quando o segredo for uma chave de teste conhecida e `APP_ENV != production`, com teste, ou usar ambiente de teste com widget real |
| N3 | Média | **Esgotamento da cota do formulário por muitos IPs.** `checkForm` consome o limite de 300 req/min **antes** do Turnstile; ~600 IPs enviando 1 req a cada 2 min bastam para devolver `429` a visitantes reais (negação de serviço da captação, mesmo sem nenhum lead criado) | `submit-lead.ts` (passo 5 antes do 6) | **Onda 6b**: regra de Firewall por IP + alerta em `ratelimit.blocked{scope="form"}`; considerar contar a cota do formulário só após Turnstile válido (muda a ordem da spec §2: decisão do dono) |
| N4 | Média | **IP desconhecido compartilha um único balde.** Sem IP resolvido, `UNKNOWN_CLIENT_IP` vira uma identidade só: 5 envios/10 min para todo mundo e 10 falhas de bot bloqueiam todos por 1 h. Na Vercel o IP existe, mas com `trustVercelProxy: false` (dev/teste) é sempre `null` | `submit-lead.ts` (`ipKey`), `client-ip.ts` (`resolveClientIp`) | **Onda 4**: `trustVercelProxy: true` em preview/produção; decidir o tratamento de `null` (já listado no `NOTES.md`) com teste |
| N5 | Média | **Sem prazo total da requisição.** O pior caso soma chamadas sequenciais (Redis 1 s × até 5, Turnstile 3 s, Postgres 3 s × vários comandos) e passa dos `maxDuration` 10 s da função: o timeout da plataforma devolve resposta **sem** os headers de segurança, sem liberar a claim de idempotência e fora do formato problem+json | `submit-lead.ts`, `apps/api/vercel.json` | **Onda 4**: deadline interno (ex.: 8 s) que aborta e devolve `503` com `Retry-After`; medir p99 no k6 (6b) |
| N6 | Média | **Redação de log por nome de chave não cobre campos de texto livre ou quase-PII.** `message`, `company`, `job_title`, `company_website` e `hp` não casam com `SENSITIVE_KEY`; hoje ninguém os loga, mas basta um `logger.info({ fields })` para vazar. A garantia é só convenção + scanner AC-LC-17 | `platform/logger/redact.ts` | **Onda 4**: scanner AC-LC-17 sobre a suíte de integração; acrescentar as chaves ao padrão (mudança em `platform/`, escritor único) |
| N7 | Baixa | **Latência do honeypot é constante (350 ms)**, estimada e não medida; se o caminho aceito for bem mais lento ou rápido, o honeypot e o `202` real se distinguem por tempo (T11/R2) | `submit-lead.ts` (`HONEYPOT_SIMULATED_LATENCY_MS`) | **Onda 4/6b**: medir o p50 do caminho aceito no preview (k6) e ajustar |
| N8 | Média (LGPD) | **Retenção ainda não opera**: IP/UA ficam além dos 30 dias prometidos, o `DELETE` mensal do `audit_log` conflita com o trigger append-only, e `crm.anonymize_lead` ainda não existe (deve cobrir notas, `first_touch`/`last_touch` e `crm.lead_insights`). Enquanto isso o titular não tem exclusão viável | `docs/reference/database-schema.md` (decisão 7); `NOTES.md` | **Onda 6b** (migration, escritor único) e **9b** (endpoint) |
| N9 | Média | **Endpoints internos serão públicos na internet** (mesmo domínio da API) e protegidos só pela assinatura; a spec manda corpo ≤ 1 KB e `.strict()`, mas o limite global hoje é 16 KB e não há rate limit para tentativas inválidas (custo de verificação JWT por requisição) | `app.ts` (só `bodyLimit16k`), tracking §6 | **Onda 5b**: limite de 1 KB nas rotas internas, `401` genérico + métrica; **6b**: regra de Firewall limitando `/internal/*` |
| N10 | Média | **Respostas geradas pela plataforma não passam pelo middleware Hono** (Firewall deny/challenge, `429` do Firewall, timeout da função, `404` da plataforma): não carregam os 8 headers do AC-LC-16 nem problem+json. O `apps/api/vercel.json` atual não declara `headers`, embora o plano da Onda 0 cite isso. O ZAP (regras `FAIL` de header em `security/zap/zap-rules.tsv`) vai acusar essas respostas na 6b | `platform/http-security/security-headers.ts`; `apps/api/vercel.json` | **Onda 4/6b**: avaliar `headers` no `vercel.json` (escritor único do arquivo) e aceitar, documentado, o que a plataforma não permitir |
| N11 | Média | **Operação de dead letters e de segredos é SQL manual como `postgres` (ignora RLS)**: acesso administrativo concentrado, sem trilha além do `INSERT` manual em `core.audit_log` e sem aprovação dupla. Reprocessar um `skipped_no_consent` por engano violaria o consentimento | `docs/how-to/reprocess-dead-letters.md` | **Onda 6b/9b**: comando preview-first com confirmação humana; MFA e usuário nominal para o acesso admin; até lá o runbook proíbe tocar `skipped_*` |
| N12 | Baixa | **O `in_progress` da idempotência dura 24 h por padrão**: uma função que morre depois do `claim` bloqueia retentativas com `409 idempotency_in_progress` por até 24 h (a retentativa legítima usa a mesma chave). Já listado no `NOTES.md` | `upstash-idempotency-store.ts` (`IDEMPOTENCY_TTL_SECONDS`) | **Onda 4**: `inProgressTtlSeconds ≈ 60` |
| N13 | Baixa | **A rotação do `HASH_PEPPER` não tem sobreposição** (um único pepper): rotacionar zera contadores e quebra a correlação de `ip_hmac` | `platform/crypto/hashing.ts`; `docs/how-to/rotate-secrets.md` | Aceito; rotacionar só por suspeita. Reavaliar se a política exigir rotação periódica |
| N14 | Baixa | **Destino GA4 desligado devolve `permanent_failure`** (`ga4_destination_disabled`) no cliente, enquanto spec e banco preveem `skipped_disabled`; se o dispatcher não mapear, aparecerão `dead` falsos | `ga4-mp-client.ts`; tracking §5.3; database §3.8 | **Onda 5b**: mapear para `skipped_disabled` |

### Divergências entre spec e código observadas

- `fieldAllowance` (`consent-policy.ts`) é **mais restritivo** que tracking §5.2: `fbp`/`fbc` só vão à Meta com
  `ad_storage = granted`; a spec descreve o envio sem essa condição. O código está correto do ponto de vista de
  privacidade: atualizar a spec (Onda 5b).
- `Permissions-Policy` em 000 §5.1 é `()` mínima; o código envia uma lista explícita de recursos negados
  (`security-headers.ts`). Compatível, mas a spec deve citar o valor real.
- Lead-capture §9 (AC-LC-19) e §6 (limites) se contradizem na prática (N1).
- O plano da Onda 4 diz "`curl` com chave de teste retorna `202`", o que depende de N2.

### Conclusão da revisão

Nenhum controle previsto foi encontrado ausente por engano: o que falta está atribuído a uma onda (4, 5b, 6b,
9b, 10). Os itens que podem **bloquear critérios de aceite** são N1 e N2; os que podem **causar indisponibilidade
ou vazamento se esquecidos na Onda 4** são N3–N6 e N12. Revisitar este modelo ao fechar a Onda 4 (rota viva),
a 5b (rotas internas) e a 6b (retenção, Firewall, alertas).
