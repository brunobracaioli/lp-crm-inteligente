# ADR-0005 — `POST /v1/leads` como exceção pública com controles compensatórios

- Status: accepted
- Data: 2026-11-03

## Context

A política é *deny by default*: todo endpoint exige autenticação. O formulário da LP é
preenchido por visitantes anônimos — não existe identidade a autenticar. Credenciais
embutidas no front seriam públicas e, portanto, não são autenticação.

## Decision

`POST /v1/leads` (e `GET /v1/health`) são declarados no OpenAPI com `security: []` e
`x-public-justification`. Controles compensatórios obrigatórios, nesta ordem:

1. Origin allowlist (global e por formulário) + CORS sem credenciais.
2. Guards de transporte (método, `Content-Type`, corpo ≤ 16 KB).
3. Rate limit por IP (HMAC) e bloqueio por falhas de bot.
4. **Prova humana**: Turnstile verificado server-side (hostname, action, idade, uso único).
5. Validação estrita (`.strict()`, whitelist por campo) → honeypot → idempotência → rate limit por e-mail.
6. Endpoint só **cria**; nunca retorna dados do lead nem indica se ele já existia.

## Consequences

- (+) Exceção explícita, revisável e testada (AC-LC-05..12).
- (−) Turnstile vira dependência crítica: indisponibilidade → 503 (fail-closed), aceita-se perda temporária de conversão em troca de não aceitar bots.
