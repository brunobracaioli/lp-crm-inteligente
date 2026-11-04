# ADR-0009 — Exceções delimitadas ao append-only de `core.audit_log` e `crm.lead_activities`

- Status: proposed
- Data: 2026-11-04

## Context

A Onda 1 fez `core.audit_log` e `crm.lead_activities` append-only com um trigger que recusa qualquer
`UPDATE` ou `DELETE`, para qualquer role. A Onda 6b precisa de duas escritas que esse trigger impede:

- a retenção de 12 meses do audit log (database §6) apaga entradas antigas;
- a anonimização do titular (LGPD, `crm.anonymize_lead`) precisa apagar o corpo das notas e a PII dos payloads
  das atividades. Sem isso, o "direito à eliminação" deixaria o texto livre das notas intacto (threat model
  `crm-staff-auth.md`, G4).

Alternativas consideradas:

1. Desligar o trigger dentro das funções (`ALTER TABLE … DISABLE TRIGGER`). Exige DDL em tempo de execução e
   desliga a proteção para qualquer escrita concorrente durante a transação.
2. Guardar notas fora de `lead_activities` e nunca apagar o audit log. Resolve só metade do problema, muda o
   modelo de dados das ondas 2–4 e contradiz a retenção definida.
3. Manter um trigger por operação, que só abre exceção quando uma flag local da transação está ligada e o dado
   alterado cabe no recorte permitido.

## Decision

Adotamos a alternativa 3 (migration `20261104100000_retention_and_anonymization.sql`):

- `core.audit_log`: `DELETE` só é aceito com `app.retention_purge = on` e apenas para linhas com mais de
  12 meses. `UPDATE` continua sempre recusado.
- `crm.lead_activities`: `UPDATE` só é aceito com `app.lead_anonymization = on` e apenas na coluna `data`.
  `DELETE` continua sempre recusado.
- As flags são ligadas com `set_config(…, true)` (locais à transação) somente pelas funções `SECURITY DEFINER`
  de expurgo e de anonimização, que as desligam ao terminar.
- O `lp_api` não tem `UPDATE`/`DELETE` nessas tabelas, então ligar a flag por conta própria não lhe dá nada.
  Para um role com privilégio de escrita, a flag forjada só abre o mesmo recorte: outra coluna ou uma linha
  recente do audit log continuam recusadas (coberto em `007_retention`, `008_anonymize_lead`, `retention.test.ts` e `anonymize-lead.test.ts`).

## Consequences

- A retenção e a eliminação do titular funcionam sem DDL em tempo de execução e sem janela sem proteção.
- O append-only passa a ser "append-only, exceto estes dois recortes", e qualquer novo recorte exige nova
  migration e revisão deste ADR.
- O dono do schema (role de migration) continua capaz de alterar as tabelas com DDL; isso já era verdade e
  segue fora do alcance do runtime.
- A eliminação reescreve `data` das atividades: o histórico mantém tipo, data e ator, mas perde o conteúdo,
  como exige a finalidade da anonimização.
