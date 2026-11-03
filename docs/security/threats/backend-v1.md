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
