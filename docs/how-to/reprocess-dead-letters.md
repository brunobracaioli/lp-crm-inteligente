# Como reprocessar dead letters do outbox e das entregas

Procedimento para diagnosticar e reenfileirar entregas de conversão (`tracking.deliveries`) e eventos do outbox
(`tracking.outbox_events`) que terminaram em `dead` ou ficaram parados. Contexto:
[ADR-0004](../adr/0004-transactional-outbox-qstash.md) e [tracking §5](../specs/tracking.md#5-server-side-wave-5).

> **Estado de implementação.** As tabelas e constraints existem desde a Onda 1; o código que as escreve
> (`DispatchOutboxEvent`, `SweepOutbox`, rotas `/internal/v1/outbox/*`, schedule do sweeper) é da **Onda 5b**.
> Passos marcados **[5b]** só funcionam depois dela. A seção de diagnóstico (só leitura) vale desde já.

> **Quem aprova.** Diagnóstico (`SELECT`) não precisa de aprovação. **Reenfileirar é uma ação externa**: o
> destino é a Meta (conversão que influencia otimização de mídia paga) e o resultado é irreversível depois do
> envio. Exige a confirmação explícita do dono do projeto, com a lista de IDs e a causa raiz corrigida.

## Quando usar

- Alerta de entregas `dead` (Onda 6b) ou de `outbox.lag_s` > 10 min com eventos `pending`/`processing` antigos.
- Depois de resolver uma causa: token da Meta expirado/revogado (`meta_auth_error`), indisponibilidade da Meta
  ou do QStash, bug de payload já corrigido e implantado, rotação de segredo
  ([rotate-secrets](rotate-secrets.md)) que deixou entregas mortas.
- **Não use** para `skipped_no_consent` nem `skipped_disabled`: não são falhas. Reenviar um `skipped_no_consent`
  violaria o consentimento registrado (LGPD, tracking §4). Nunca altere essas linhas.

## Pré-requisitos

- Acesso administrativo ao banco como `postgres` (conexão direta, ver
  [rotate-db-role-password](rotate-db-role-password.md) passo 3). Não use `lp_api`. O `postgres` ignora RLS: **todo
  comando abaixo filtra `workspace_id` explicitamente**.
- `workspace_id` e janela de tempo do incidente. Causa raiz identificada, corrigida e **implantada**.
- Regra de ouro: trabalhar **só com IDs, status e códigos**. Nenhuma consulta abaixo toca nome, e-mail, WhatsApp,
  IP ou mensagem; não faça `JOIN` com `crm.leads` para colunas pessoais.

## Passos

### 1. Diagnosticar (só leitura)

Panorama de entregas com problema, agrupadas por causa:

```sql
SELECT destination, status, last_error_code, last_http_status, count(*) AS deliveries,
       min(created_at) AS oldest, max(updated_at) AS latest, max(attempts) AS max_attempts
FROM tracking.deliveries
WHERE workspace_id = '<workspace_id>' AND status IN ('failed', 'dead')
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;
```

Eventos do outbox que não terminaram, e há quanto tempo:

```sql
SELECT status, count(*) AS events, min(created_at) AS oldest, max(attempts) AS max_attempts,
       round(extract(epoch FROM (now() - min(created_at)))) AS oldest_age_seconds
FROM tracking.outbox_events
WHERE workspace_id = '<workspace_id>' AND status IN ('pending', 'processing', 'dead')
GROUP BY 1 ORDER BY 1;
```

Eventos `processing` com `locked_until` no passado são travas órfãs (função morreu no meio); `pending` antigos
sem entregas indicam falha de publish no QStash (o sweeper deveria ter cobrido — **[5b]**).

Use `last_error_code` (código interno, nunca corpo de terceiro) para decidir:

| `last_error_code` | Significado | Reenfileirar? |
|---|---|---|
| `meta_auth_error` | Token inválido/expirado ou sem permissão (códigos 10, 102, 190, 200–299) | **Sim, depois** de corrigir o token ([rotate-secrets](rotate-secrets.md)) |
| `meta_timeout`, `meta_network`, `meta_rate_limited`, `meta_server_error`, `meta_transient_error`, `meta_invalid_response` | Falha transitória que esgotou as 8 tentativas | **Sim**, depois que a Meta estabilizar |
| `meta_rejected` | A Meta rejeitou o payload (4xx de validação) | **Não** antes de entender: bug de payload, Pixel ID errado, `event_time` fora da janela. Corrija o código (com teste), implante, só então reavalie |
| `meta_unexpected_redirect` | A Meta respondeu 3xx (nunca seguido, por segurança) | **Não**; investigue (URL/versão da Graph API) |
| `ga4_rejected`, `ga4_unavailable`, `ga4_timeout`, `ga4_network` | Destino GA4 MP (opcional) | Mesma lógica; só se o destino estiver ligado |
| `ga4_destination_disabled`, `ga4_missing_client_id` | Não é falha de entrega | **Não**: deveriam ser `skipped_*` (reporte como bug se aparecerem `dead`) |

Dois filtros de segurança antes de qualquer reenvio:

1. **Janela da Meta.** Eventos com `event_time` mais antigos que 7 dias são recusados pela Meta (limite
   documentado; confirme na documentação vigente). Entregas mais velhas que isso não devem ser reenfileiradas.
2. **Lead anonimizado.** Entrega de lead já anonimizado (LGPD) não pode ser reenviada. Conte, sem ler dado
   pessoal:

   ```sql
   SELECT count(*) FILTER (WHERE l.anonymized_at IS NOT NULL) AS anonymized,
          count(*) AS total
   FROM tracking.deliveries d
   JOIN tracking.outbox_events e ON e.workspace_id = d.workspace_id AND e.id = d.outbox_event_id
   JOIN crm.leads l ON l.workspace_id = e.workspace_id AND l.id = e.aggregate_id
   WHERE d.workspace_id = '<workspace_id>' AND d.status = 'dead' AND d.destination = 'meta_capi'
     AND d.last_error_code = '<codigo>';
   ```

### 2. Escolher o escopo (nunca "todos os dead")

Monte a lista **explícita de IDs** a reenfileirar, já aplicando os filtros acima, e guarde-a no registro do
incidente:

```sql
SELECT d.id AS delivery_id, d.outbox_event_id, d.created_at
FROM tracking.deliveries d
JOIN tracking.outbox_events e ON e.workspace_id = d.workspace_id AND e.id = d.outbox_event_id
JOIN crm.leads l ON l.workspace_id = e.workspace_id AND l.id = e.aggregate_id
WHERE d.workspace_id = '<workspace_id>' AND d.destination = 'meta_capi' AND d.status = 'dead'
  AND d.last_error_code = '<codigo>'
  AND d.created_at > now() - interval '6 days'     -- margem sobre a janela de 7 dias
  AND l.anonymized_at IS NULL
ORDER BY d.created_at LIMIT 50;
```

Comece por um **lote pequeno (até 50)** para validar o ciclo inteiro antes de liberar o resto; a Meta aplica
rate limit e um burst de milhares de eventos é novo problema.

### 3. Guardar o estado atual (para rollback)

Antes de alterar, exporte as linhas afetadas (IDs, status, tentativas, códigos — sem dado pessoal) para um
arquivo local fora do repositório:

```sql
\copy (SELECT id, outbox_event_id, status, attempts, last_http_status, last_error_code FROM tracking.deliveries WHERE workspace_id = '<workspace_id>' AND id = ANY ('{<delivery_id>,<delivery_id>}'::uuid[])) TO 'deliveries-before.csv' CSV HEADER
\copy (SELECT id, status, attempts, next_attempt_at, locked_until, processed_at FROM tracking.outbox_events WHERE workspace_id = '<workspace_id>' AND id = ANY ('{<outbox_event_id>,<outbox_event_id>}'::uuid[])) TO 'outbox-before.csv' CSV HEADER
```

### 4. Reenfileirar **[5b]**

Idempotência: `UNIQUE (outbox_event_id, destination)` garante uma única entrega por par; o dispatcher só tenta
entregas abertas (`pending`/`failed`) e **nunca** reenvia uma `sent` (AC-TR-04). Por isso o `UPDATE` abaixo mira
apenas linhas `dead` da lista aprovada. Mesmo um duplicado acidental chegaria à Meta com o mesmo `event_id`,
que ela deduplica, mas não conte com isso.

```sql
BEGIN;

-- 4.1 Entregas: voltam a abertas e ganham orçamento novo (8 tentativas totais; com attempts antigo
-- a primeira falha retentável as mataria de novo).
UPDATE tracking.deliveries
SET status = 'pending', attempts = 0, last_http_status = NULL, last_error_code = NULL
WHERE workspace_id = '<workspace_id>' AND status = 'dead' AND destination = 'meta_capi'
  AND id = ANY ('{<delivery_id>,<delivery_id>}'::uuid[]);

-- 4.2 Eventos pai: precisam voltar a ser elegíveis para o dispatcher/sweeper. Se a 5b marca o evento como
-- 'done' ou 'dead' quando há entrega morta é decisão dela: o filtro cobre os dois.
UPDATE tracking.outbox_events
SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, processed_at = NULL
WHERE workspace_id = '<workspace_id>' AND status IN ('dead', 'done')
  AND id = ANY ('{<outbox_event_id>,<outbox_event_id>}'::uuid[]);

-- 4.3 Rastro da operação (append-only; sem PII).
INSERT INTO core.audit_log
  (workspace_id, actor_type, action, resource_type, result, correlation_id, metadata)
VALUES ('<workspace_id>', 'user', 'ops.deliveries_requeued', 'delivery', 'success', gen_random_uuid(),
        '{"incident":"<id-do-incidente>","destination":"meta_capi","count":<n>,"error_code":"<codigo>"}');

COMMIT;
```

Confira os `UPDATE ... n` da saída: o número deve bater com o tamanho da lista aprovada. Se divergir,
`ROLLBACK;` e investigue.

### 5. Disparar o processamento **[5b]**

- **Caminho normal:** aguarde o sweeper (schedule a cada 5 min republica eventos `pending` com mais de 2 min;
  estes são antigos, logo elegíveis na próxima rodada). Não há nada a executar.
- **Caminho manual (fallback, ação externa):** publique você mesmo no QStash, um evento por vez, com o token
  lido do gerenciador de senhas (sem imprimi-lo). `Upstash-Deduplication-Id` evita duplicar caso o sweeper
  também publique.

  ```bash
  read -rs QSTASH_TOKEN                      # cole o token; não aparece no terminal
  export QSTASH_TOKEN
  curl --fail --silent --show-error --max-time 10 -X POST \
    "https://qstash.upstash.io/v2/publish/<PUBLIC_API_BASE_URL>/internal/v1/outbox/dispatch" \
    -H "Authorization: Bearer ${QSTASH_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Upstash-Deduplication-Id: <outbox_event_id>" \
    -H "Upstash-Retries: 5" \
    -d '{"outbox_event_id":"<outbox_event_id>"}'
  unset QSTASH_TOKEN
  ```

  A API valida a assinatura que o QStash coloca na entrega; o `curl` acima não chama a API diretamente (nunca
  contorne a assinatura chamando `/internal/*` à mão).

## Verificação

1. Reexecute o panorama do passo 1: as entregas da lista devem estar `sent` (com `external_ref` = `fbtrace_id`)
   ou, se falharem de novo, `failed`/`dead` com **o mesmo ou um novo** `last_error_code` — nunca invente
   sucesso.
2. `SELECT count(*) FROM tracking.deliveries WHERE workspace_id = '<workspace_id>' AND status = 'sent' AND id = ANY (...)`
   bate com o esperado, e nenhuma entrega `sent` foi tocada (compare `updated_at` com o CSV do passo 3).
3. Métricas `delivery.result{destination,status}` mostram `sent`; sem novos `auth`/`rate_limited`; lag do
   outbox voltou a < 10 min.
4. Meta Events Manager → Visão geral do dataset: eventos de servidor recebidos no período (para validar com
   `META_TEST_EVENT_CODE` use o Preview, não a produção).
5. Só então libere o próximo lote (repita 2–5) até zerar a lista aprovada.

## Rollback

- **Antes do passo 5** (nada foi processado): restaure os estados do CSV do passo 3 com um `UPDATE ... FROM`
  dos valores salvos ou, mais simples, `UPDATE tracking.deliveries SET status = 'dead', attempts = <valor>
  WHERE id = ANY (...)` e o equivalente em `outbox_events`, e registre outra linha `ops.deliveries_requeue_reverted`
  no `core.audit_log`.
- **Depois do envio:** não há rollback. Um evento entregue à Meta não pode ser recolhido por esta API; por isso
  o lote inicial é pequeno e a verificação vem antes do próximo. Se um lote enviou algo indevido, avise o dono
  e o gestor de tráfego (exclusão no Events Manager é manual).

## Evitar que volte

- Alerta de `dead` e `outbox.lag_s` (Onda 6b) para agir em horas, não no limite de 7 dias.
- Rotação de token na ordem "novo antes de revogar o antigo" ([rotate-secrets](rotate-secrets.md)).
- Se o reprocesso virar rotina, automatize com um comando preview-first (lista → confirmação humana →
  reenfileira) em vez de SQL à mão — decisão para a 6b/9b, não desta onda.
