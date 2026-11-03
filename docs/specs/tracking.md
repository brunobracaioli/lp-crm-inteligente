# Spec — Tracking & Atribuição

> Status: **draft v0.1** · Bounded context: `tracking` · Waves: 5 (server-side), 8 (client-side), 11 (offline conversions)
> ADR: [0004](../adr/0004-transactional-outbox-qstash.md)

## 1. Objetivo

Medir o funil completo da LP (visita → interação → lead → lead qualificado → venda) em
GA4, Google Ads e Meta, com **deduplicação** entre browser e servidor, respeitando o
consentimento (LGPD / Consent Mode v2), sem expor PII no browser e sem que nenhuma
integração externa possa derrubar ou atrasar a captação.

## 2. Arquitetura de medição

| Sinal | Origem | Destino | Dedup |
|---|---|---|---|
| `page_view`, interações | Browser (GTM) | GA4, Meta Pixel (`PageView`), Google Ads (remarketing) | — |
| `generate_lead` / `Lead` | Browser (GTM, após `202`) | GA4, Google Ads conversion, Meta Pixel `Lead` com `eventID` | `event_id` |
| `Lead` server-side | API via outbox (wave 5) | Meta CAPI (`action_source: website`) | mesmo `event_id` (= Pixel `eventID`) |
| `generate_lead` server-side (opcional) | API via outbox | GA4 Measurement Protocol (`client_id` = `_ga`) | GA4 não deduplica: **só um** dos dois por padrão — ver §5.3 |
| `QualifiedLead`, `Won` (offline) | CRM ao mudar estágio (wave 11) | Meta CAPI (`action_source: system_generated`), Google Ads (offline/enhanced conversions for leads via `gclid` + e-mail hasheado) | `event_id` determinístico (`uuidv5(lead_id + stage)`) |

## 3. Contrato do dataLayer

O dataLayer **nunca** recebe PII (nome, e-mail, telefone, empresa, mensagem). Campos
abaixo são o contrato entre o front (Codex) e o container GTM.

| Evento | Quando | Parâmetros |
|---|---|---|
| `consent_default` | Antes do GTM carregar (inline) | via `gtag('consent','default',{…denied, wait_for_update: 500})` |
| `consent_update` | Usuário decide no banner | `analytics_storage`, `ad_storage`, `ad_user_data`, `ad_personalization` |
| `form_start` | Primeiro foco em qualquer campo | `form_key` |
| `form_step_error` | Validação client-side falha no submit | `form_key`, `error_fields` (lista de **nomes** de campo), `error_count` |
| `form_submit_attempt` | Clique em enviar com client-side válido | `form_key` |
| `generate_lead` | API respondeu `202` | `form_key`, `event_id`, `area_of_expertise`, `company_size`, `lead_source` (= `utm_source` ou `direct`) |
| `form_submit_error` | API respondeu ≥ 400 | `form_key`, `error_code` (o `code` do problem+json), `http_status` |
| `cta_click` | Clique em CTA | `cta_id`, `cta_location` |
| `whatsapp_click` | Clique no botão de WhatsApp da empresa | `cta_location` |
| `scroll_depth` | 25/50/75/90% | `percent` |

Regras:
- `event_id` do `generate_lead` = `tracking.event_id` enviado à API = `eventID` do Pixel.
- Valores de enum enviados como **código** (`technology`), não label.
- `whatsapp_click` **não** é conversão de lead no v1 (vira micro-conversão secundária no Ads/GA4).

## 4. Consentimento (Consent Mode v2 + LGPD)

- Default **denied** para os 4 sinais, `wait_for_update: 500`, região `BR` (e default global igual).
- Banner próprio na LP (Codex) com "Aceitar todos", "Rejeitar" e "Personalizar"; escolha
  persistida em cookie first-party `lp_consent` (365 dias, `SameSite=Lax`, `Secure`) e
  re-perguntada quando a versão da política mudar.
- Pixel da Meta só carrega após `ad_storage = granted` (tag GTM com consent check `ad_storage`).
- Server-side: a API **só** envia CAPI/GA4 MP/Google Ads se a submissão tiver
  `consent.ad_user_data = granted` (CAPI, Ads) ou `analytics_storage = granted` (GA4 MP).
  Caso contrário a entrega é registrada como `skipped_no_consent`.

## 5. Server-side (wave 5)

### 5.1 Despacho

1. `POST /v1/leads` grava `outbox_events(lead.captured, payload {lead_id, submission_id})` na mesma transação.
2. Após commit: `qstash.publishJSON({url: PUBLIC_API_BASE_URL + '/internal/v1/outbox/dispatch', body: {outbox_event_id}, deduplicationId: outbox_event_id, retries: 5})` dentro de `waitUntil`.
3. `/internal/v1/outbox/dispatch` (auth: assinatura QStash obrigatória, ver §6) → carrega o
   evento com `FOR UPDATE SKIP LOCKED`, cria `deliveries` faltantes por destino habilitado
   (`ON CONFLICT DO NOTHING`), envia cada entrega pendente, atualiza status.
4. Se alguma entrega falhar de forma retentável → responde `500` para o QStash retentar
   (backoff exponencial do QStash). Entregas já `sent` não são reenviadas.
5. Sweeper: schedule QStash a cada 5 min → `/internal/v1/outbox/sweep` republica eventos
   `pending` com `created_at < now() - 2 min` (cobre falha de publish). Após 8 tentativas
   totais → `dead` + alerta.

### 5.2 Meta Conversions API

- `POST https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_PIXEL_ID}/events` com
  `access_token` **no corpo JSON** (nunca na query string), timeout 5 s.
- `data[0]`:
  - `event_name: "Lead"`, `event_time` = `submission.created_at` (epoch s), `event_id`,
    `action_source: "website"`, `event_source_url` = `landing_page_url`.
  - `user_data`: `em`, `ph`, `fn`, `ln`, `external_id` = SHA-256 de valores normalizados
    (e-mail minúsculo/trim; telefone E.164 só dígitos; nomes minúsculos sem acento/pontuação;
    `external_id` = `lead_id`), `client_ip_address`, `client_user_agent` (da submissão, antes
    do expurgo de 30 dias), `fbp`, `fbc` (se `fbc` ausente e `fbclid` presente, montar
    `fb.1.<created_at_ms>.<fbclid>`).
  - `custom_data`: `lead_source`, `area_of_expertise`, `company_size`, `score_band` (sem PII).
- `test_event_code` = `META_TEST_EVENT_CODE` fora de produção.
- Resposta validada por Zod (`events_received`, `fbtrace_id`). 4xx de validação → `dead`
  (não retentar); 429/5xx/timeout → retentável. `fbtrace_id` vai para `external_ref`.
- Token: System User com permissão só no Pixel/dataset; rotação semestral.

### 5.3 GA4 Measurement Protocol (opcional, desligado por default)

- Só usado se o `generate_lead` client-side estiver bloqueado por adblock em volume relevante
  (decisão por dados após wave 8). Se ligado, o client-side `generate_lead` passa a ir **só**
  via servidor para evitar dupla contagem.
- `api_secret` exigido na query string pela Google: exceção documentada — chamada
  server-to-server, URL **redigida** nos logs.

### 5.4 Google Ads

- v1: conversão client-side via GTM (tag de conversão + Enhanced Conversions **desligado**
  no browser para não expor PII ao dataLayer).
- Wave 11: *enhanced conversions for leads* / upload de conversão offline via Google Ads API
  com `gclid` e e-mail SHA-256 ao atingir `qualified` e `won`.

## 6. Endpoints internos

| Rota | Auth | Corpo |
|---|---|---|
| `POST /internal/v1/outbox/dispatch` | `Upstash-Signature` (JWT HS256 com `QSTASH_CURRENT/NEXT_SIGNING_KEY`), `iss = Upstash`, `sub` = URL exata, `exp`, `body` hash conferido sobre o **corpo bruto** | `{ "outbox_event_id": uuid }` |
| `POST /internal/v1/outbox/sweep` | idem | `{}` |

Sem assinatura válida → `401` genérico, log `warn` + métrica. Rate limit por destino não é
necessário (só QStash chama), mas body ≤ 1 KB e schema `.strict()`.

## 7. Front: tags e CSP (wave 8, Codex + GTM)

Container GTM (web):
- **Google tag** (GA4 + Ads) com Consent Mode; evento `generate_lead` → GA4 event + conversão Ads.
- **Meta Pixel** base (`PageView`) + `Lead` disparado em `generate_lead` com
  `eventID: {{DLV - event_id}}`, consent check `ad_storage`.
- Variáveis DLV para todos os parâmetros de §3; trigger por Custom Event.
- Workspace → versão publicada com nome `vN — <mudança>`; nunca publicar sem preview/QA.

CSP da LP (header via `apps/lp/_headers` no Cloudflare Pages) — baseline a ajustar no QA:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'sha256-<inline consent default>' https://www.googletagmanager.com https://*.googletagmanager.com https://connect.facebook.net https://challenges.cloudflare.com;
  connect-src 'self' https://api.<dominio> https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://www.google.com https://*.doubleclick.net https://www.facebook.com https://connect.facebook.net https://challenges.cloudflare.com;
  img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com https://www.google.com https://www.google.com.br https://*.doubleclick.net https://www.facebook.com;
  frame-src https://challenges.cloudflare.com https://www.googletagmanager.com https://td.doubleclick.net;
  style-src 'self';
  font-src 'self';
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none';
  upgrade-insecure-requests
```

Sem `unsafe-eval`. Tags "Custom HTML" no GTM são **proibidas** (exigiriam `unsafe-inline`);
usar templates da galeria. CSP é a causa nº 1 de "tag não dispara" — QA obrigatório.

## 8. Critérios de aceite

| ID | Critério | Wave |
|---|---|---|
| AC-TR-01 | Submissão com `ad_user_data=granted` gera 1 delivery `meta_capi` `sent` com `event_id` igual ao da submissão; Meta Test Events mostra o evento como "deduplicado" com o Pixel | 5 |
| AC-TR-02 | Submissão com `ad_user_data=denied` gera delivery `skipped_no_consent` e **nenhuma** chamada HTTP à Meta (MSW sem match) | 5 |
| AC-TR-03 | Request a `/internal/v1/outbox/dispatch` sem assinatura, com assinatura de outro corpo ou expirada → `401`, nenhum efeito | 5 |
| AC-TR-04 | Reprocessar o mesmo `outbox_event_id` 3× resulta em exatamente 1 envio por destino | 5 |
| AC-TR-05 | Meta 500/timeout → delivery `failed` com `attempts` incrementado e resposta 500 ao QStash; Meta 400 → `dead`, sem retry | 5 |
| AC-TR-06 | O corpo enviado à Meta contém `em/ph/fn/ln/external_id` como hex SHA-256 de 64 chars e nenhum valor em claro; `access_token` não aparece em URL nem em logs | 5 |
| AC-TR-07 | Evento `pending` sem publish é republicado pelo sweeper em ≤ 7 min | 5 |
| AC-TR-08 | Headless (Playwright) com interceptação: com consent negado, nenhum request a `facebook.com`/`google-analytics.com` com cookies de ads; com aceito, `generate_lead` e `fbq Lead` disparam 1× com o `event_id` da resposta | 8 |
| AC-TR-09 | Console do browser sem violações de CSP durante o fluxo completo | 8 |
| AC-TR-10 | `dataLayer` inspecionado após o fluxo não contém e-mail, telefone, nome nem empresa | 8 |
