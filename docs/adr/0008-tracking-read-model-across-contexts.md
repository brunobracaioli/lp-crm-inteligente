# ADR-0008 — Leitura somente-leitura de `crm` e `capture` pelo adapter do tracking

- Status: proposed
- Data: 2026-11-04

## Context

O ADR-0001 diz que módulos só conversam por `public-api.ts` ou eventos do outbox. Na Onda 5b, o
`DispatchOutboxEvent` precisa, para montar um evento da Meta CAPI, de dados que ficam em dois contextos:

- `crm.leads`: e-mail, WhatsApp, nome, área, porte, faixa de score;
- `capture.submissions`: `event_id`, consentimento, `fbp`/`fbc`/`fbclid`, IP, user agent, landing page.

O payload do outbox (`lead.captured`) carrega só IDs (database §3.7, sem PII). Por isso o tracking tem de
buscar esses dados no momento do envio. Nenhuma view ou função do banco expõe esse recorte.

Alternativas consideradas:

1. Uma query na `crm/public-api.ts`. Ela não cobre os dados de `capture`, então exigiria uma segunda API em
   `lead-capture` e uma composição entre as duas. Seriam duas funções públicas que devolvem PII crua para
   plataformas de anúncio, uma superfície maior que um SELECT auditado.
2. Copiar a PII para o payload do outbox. Isso viola a regra "outbox só com IDs" e espalha PII por mais uma
   tabela, com retenção própria.
3. Um port no tracking (`LeadConversionSourceReader`) implementado por um adapter em
   `tracking/infrastructure/` com um único SELECT somente-leitura.

## Decision

Adotamos a alternativa 3, como exceção explícita e delimitada ao ADR-0001:

- O adapter é `postgres-lead-conversion-source-reader.ts`. É o **único** ponto do tracking que lê tabelas de
  outro contexto.
- A query é parametrizada, com colunas explícitas, filtro por `workspace_id` além do RLS e
  `anonymized_at IS NULL`. Lead anonimizado retorna `null`, e nenhuma chamada sai.
- Consentimento ilegível é tratado como tudo negado (fail-closed).
- O domínio e a aplicação do tracking não conhecem `crm` nem `lead-capture`: dependem só do port.
- Mudanças de schema em `crm.leads`/`capture.submissions` que afetem as colunas lidas exigem atualizar este
  adapter e seu teste de integração (`test/integration/tracking-source-reader.test.ts`) no mesmo PR.

## Consequences

- Positivas: a PII não sai do banco antes do envio, não há API pública nova que devolva PII e o teste de
  integração cobre a query sob RLS, incluindo o caso cross-tenant.
- Negativas: existe acoplamento de schema entre contextos. Uma extração futura do tracking para um serviço
  próprio precisará trocar este adapter por uma API ou um read model publicado pelo `crm`.
- Revisitar se um segundo consumidor precisar do mesmo recorte. Nesse caso, uma view `SECURITY INVOKER`
  versionada em migration passa a ser o contrato.
