# Como aplicar o Firewall da Vercel e os alertas (Onda 6b)

As regras do WAF e os monitores de alerta são código, em `apps/api/ops/vercel/`. O script
`apps/api/scripts/vercel-ops.ts` valida os arquivos e **só imprime** os comandos da Vercel CLI. Aplicar
é ação externa: quem roda é o dono do projeto, nunca um agente.

Os schemas estão em `apps/api/scripts/vercel-ops-schema.ts`. O teste `apps/api/test/ops/vercel-ops.test.ts`
falha no CI se um arquivo sair do formato ou se um monitor observar uma métrica que o código não emite.

## Pré-requisitos

- Vercel CLI autenticada e o diretório `apps/api` linkado ao projeto da API (`vercel link`).
- Observability habilitado no projeto (monitores sobre métricas customizadas).

## Firewall (WAF)

| Regra | O que faz |
|---|---|
| `lp-leads-methods` | `/v1/leads` só aceita `POST` e `OPTIONS` (preflight CORS); o resto é negado na borda |
| `lp-leads-ip-rate` | Teto grosso por IP: 20 `POST`/min. O limite real (5 a cada 10 min por IP) continua na aplicação |
| `lp-internal-methods` | `/internal/*` (callbacks do QStash) só aceita `POST` |
| `lp-crm-ip-rate` | Teto por IP de 300 req/min na API do staff; as cotas por usuário ficam na aplicação |

1. Veja o que já existe: `vercel firewall rules list`.
2. Gere os comandos. Se alguma regra `lp-*` já existir, passe o nome em `--edit` para ela ser editada em vez de
   duplicada:

   ```bash
   cd apps/api
   node scripts/vercel-ops.ts firewall                       # primeira vez
   node scripts/vercel-ops.ts firewall --edit=lp-leads-ip-rate  # atualização de uma regra existente
   ```

3. Rode os comandos impressos. Eles ficam em **rascunho** (staged) e não afetam o tráfego.
4. Revise com `vercel firewall diff`. Se estiver certo, `vercel firewall publish --yes`; se não,
   `vercel firewall discard --yes`.
5. Confira: `curl -i -X GET https://<preview>/v1/leads` deve responder `403` da borda; `POST` continua
   chegando na função.

**Attack Mode** não é regra: é um botão do projeto. O procedimento está em
[respond-to-lead-endpoint-flood.md](respond-to-lead-endpoint-flood.md). Não use a ação `challenge` em
`/v1/leads`: o formulário envia via `fetch` e não resolve o desafio, então todo lead seria perdido.

## Monitores (alertas)

| Monitor | Sinal | Dispara quando |
|---|---|---|
| `lp-api-5xx` | `vercel.request.count` com `httpStatus >= 500` | mais de 5 em 5 min |
| `lp-antibot-failures` | `antibot.failures` (Turnstile) | mais de 50 em 5 min |
| `lp-outbox-lag` | `outbox.lag_s` (medido pelo sweeper a cada 5 min) | máximo acima de 600 s em 15 min |
| `lp-deliveries-dead` | `delivery.result` com `status:dead` | qualquer ocorrência em 15 min |
| `lp-outbox-dead` | `outbox.dead` | qualquer ocorrência em 15 min |

```bash
cd apps/api
node scripts/vercel-ops.ts monitors --project <projeto-da-api> --out /tmp/lp-monitors
# rode os `vercel monitors add ...` impressos; confira com `vercel monitors ls`
```

Para atualizar um monitor: `vercel monitors rm <id>` e adicione de novo (os nomes `lp-*` identificam os
gerenciados por código).

## Teste sintético (critério de aceite da 6b)

No preview, com os monitores ativos:

- **5xx**: derrube temporariamente o acesso ao banco (env var de preview inválida, redeploy) e envie 6 leads
  de teste; o `lp-api-5xx` deve disparar. Restaure a env var.
- **Dead letter**: o runbook [reprocess-dead-letters.md](reprocess-dead-letters.md) descreve como forçar um
  evento a esgotar as tentativas em preview; `lp-outbox-dead` deve disparar.

Os limites são o ponto de partida; ajuste depois de uma semana de tráfego real.
