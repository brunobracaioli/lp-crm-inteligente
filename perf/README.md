# perf — testes de carga (k6)

`lead-capture.js` valida o critério **AC-LC-19** ([lead-capture §9](../docs/specs/lead-capture.md#9-critérios-de-aceite)):
em preview na Vercel, 20 VUs por 1 minuto em `POST /v1/leads` com **p95 ≤ 800 ms** e **0% de 5xx**.
O k6 é um binário externo (`k6 version`; testado com v0.54.0) — o repositório não adiciona dependência npm
para ele.

## O que o roteiro faz

- Gera, a cada iteração, um payload válido segundo `contracts/openapi.v1.yaml` com `Idempotency-Key`,
  `X-Request-Id`, `tracking.event_id` (UUID v4) e e-mail **únicos** (`k6-<run>-<vu>-<iter>@example.com`).
  Dados sintéticos: nomes fixos, domínio reservado (RFC 2606) e telefone fictício. Nenhum dado pessoal real.
- Cenários (`SCENARIO`): `steady` (padrão, perfil do AC-LC-19), `spike` (rampa até `SPIKE_VUS`, mantém 30 s) ou
  `all` (steady seguido de spike).
- **Thresholds que reprovam a execução** (exit code 99):
  - `lead_server_errors` = 0 (qualquer 5xx ou falha de transporte);
  - `lead_unexpected_responses` < 1% (tudo que não for `202` nem `429`: `400`, `403`, `404`, `422`…);
  - p95 de `http_req_duration` **só das respostas `202`** < `P95_MS` (800 ms; 2000 ms no spike);
  - `lead_accepted` (share de `202`) ≥ `MIN_ACCEPTED_RATE` (95%) no steady. Sem isso, uma execução feita só de
    `429`/`403` rápidos ficaria "verde" sem medir o caminho aceito.
- Recusa rodar contra host que não seja loopback sem `CONFIRM_REMOTE=yes` (trava de confirmação do dono).

Variáveis (todas opcionais): `BASE_URL`, `CONFIRM_REMOTE`, `ORIGIN`, `FORM_KEY`, `TURNSTILE_TOKEN`,
`EMAIL_DOMAIN`, `CONSENT`, `VERCEL_PROTECTION_BYPASS`, `SCENARIO`, `VUS`, `DURATION_SECONDS`, `THINK_TIME_SECONDS`, `SPIKE_VUS`,
`SPIKE_THINK_TIME_SECONDS`, `P95_MS`, `SPIKE_P95_MS`, `MIN_ACCEPTED_RATE`. Valores padrão e significado no
cabeçalho do roteiro.

## Rodar localmente contra um mock (Prism)

Valida o roteiro e o payload contra o contrato; **não** mede a API real.

```bash
# terminal 1 — mock do contrato em http://127.0.0.1:4010
npx @stoplight/prism-cli mock contracts/openapi.v1.yaml -p 4010

# terminal 2 — execução curta (o Prism rejeita com 422 payload que viole o contrato)
DURATION_SECONDS=15 THINK_TIME_SECONDS=1 k6 run perf/lead-capture.js
SCENARIO=all DURATION_SECONDS=5 THINK_TIME_SECONDS=1 k6 run perf/lead-capture.js
```

Esperado: `lead_accepted` 100%, 0 5xx, todos os thresholds com ✓. Os tempos do mock (poucos ms) não dizem nada
sobre a API; só provam que o roteiro funciona.

Contra `vercel dev` (API real local, depois da Onda 4), o mesmo comando com `BASE_URL=http://localhost:3000`
vale para depuração, mas os limites de taxa abaixo se aplicam igualmente.

## Rodar no preview (Onda 6b) — exige confirmação do dono

Ação externa: só a sessão principal executa, com confirmação humana explícita do alvo. Pré-requisitos:

1. **Banco descartável.** Cada iteração grava lead, submissão, consentimentos e outbox. Use o banco do
   preview (projeto ou branch Supabase separado), **nunca** o de produção. Limpe ao final recriando o branch
   (a role `lp_api` não tem `DELETE`; limpeza manual exige `postgres`).
2. **Turnstile com chaves de teste** no preview (`TURNSTILE_SECRET_KEY` de teste, ver
   [lead-capture §6](../docs/specs/lead-capture.md#6-anti-abuso)); o roteiro envia o token dummy documentado
   pela Cloudflare (`TURNSTILE_TOKEN` para trocar). **Atenção:** confirme antes com um único `curl` que a
   resposta de teste do siteverify (hostname, action e `challenge_ts` devolvidos pelas chaves de teste) passa
   nas verificações do adapter — ver "Riscos conhecidos" abaixo.
3. **Nenhum dado sintético pode chegar a plataformas de anúncio.** O padrão `CONSENT=denied` faz toda entrega
   `skipped_no_consent`. Só use `CONSENT=granted` se o preview tiver `META_TEST_EVENT_CODE` e token de teste
   (a config já rejeita `META_TEST_EVENT_CODE` em produção) e o dono autorizar.
4. **Origin e form** do preview: `ORIGIN` deve estar em `CORS_ALLOWED_ORIGINS` do preview e em
   `allowed_origins` do formulário usado em `FORM_KEY`.
5. Proteção de deploy (Vercel Authentication) do preview precisa permitir a chamada: exporte o segredo de
   _Protection Bypass for Automation_ no shell (`VERCEL_PROTECTION_BYPASS`, enviado como
   `x-vercel-protection-bypass`); nunca em arquivo do repositório nem em linha de comando compartilhada.

```bash
BASE_URL=https://<preview>.vercel.app \
CONFIRM_REMOTE=yes \
ORIGIN=https://<origin-do-preview-da-lp> \
FORM_KEY=<frm_...> \
k6 run --summary-export=perf-result.json perf/lead-capture.js
```

`perf-result.json` é saída local (não comite). Registre no PR da 6b: commit testado, URL de preview, data e o
resumo dos thresholds.

## Riscos conhecidos que afetam a execução no preview

Detalhados no threat model ([Revisão Onda 6a](../docs/security/threats/backend-v1.md#revisão-onda-6a-2026-11-04)):

- **Rate limit por IP é 5 req / 10 min e por formulário 300 req / min** (lead-capture §6). Um único gerador de
  carga (um IP) recebe `429` a partir da 6ª requisição: o roteiro falha em `lead_accepted` **de propósito**. O
  AC-LC-19 só é mensurável com um perfil de limites relaxado **apenas no preview** (por exemplo, variáveis de
  ambiente de limite lidas pela API e válidas só em `APP_ENV=preview`) ou com bypass do rate limit por
  credencial de teste. Isso é mudança de código da API → decisão do dono e implementação na Onda 4/6b; esta
  onda não altera `apps/`. O `THINK_TIME_SECONDS` padrão (5 s) mantém o steady em ~240 req/min, abaixo do
  limite por formulário, mas não resolve o limite por IP.
- **Turnstile com chaves de teste**: a resposta do siteverify de teste traz `hostname`/`challenge_ts` próprios
  (a documentação da Cloudflare mostra `localhost` e `action: test`), e o adapter exige `hostname` ∈ origins do
  formulário, `action` igual ao do formulário e `challenge_ts` ≤ 300 s. Se o preview rejeitar o token de
  teste com `403 bot_verification_failed`, o roteiro reprova em `lead_unexpected_responses`. Valide com um
  `curl` antes da execução completa e, se necessário, abra ajuste no plano da Onda 4/7b.
- Cold start de Fluid Compute pode estourar o p95 nos primeiros segundos; rode duas vezes e compare, e
  registre a primeira como aquecimento.
