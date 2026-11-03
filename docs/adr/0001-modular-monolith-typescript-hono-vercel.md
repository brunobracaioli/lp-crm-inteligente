# ADR-0001 — Monolito modular em TypeScript (Hono) na Vercel

- Status: accepted
- Data: 2026-11-03

## Context

O backend precisa receber leads da LP, alimentar um CRM e despachar conversões para
plataformas de ads. Time pequeno, baixo volume inicial (centenas a poucos milhares de leads/dia),
deploy na Vercel já decidido. Há quatro áreas de negócio distintas (captação, CRM,
tracking, inteligência) que podem, no futuro, ter ciclos de vida próprios.

## Decision

- Um único app `apps/api` (monolito modular) com módulos por bounded context
  (`lead-capture`, `crm`, `tracking`, depois `intelligence`) + `platform` como shared kernel técnico.
- Cada módulo segue Vertical Slice Architecture com camadas `domain → application →
  infrastructure → presentation`; comunicação entre módulos **só** via `public-api.ts` ou eventos de outbox.
  Regra aplicada por lint (`eslint-plugin-boundaries` ou `dependency-cruiser`) no CI.
- `lead-capture` chama `crm.registerInboundLead` de forma síncrona, compartilhando a
  unidade de trabalho (transação), para garantir que todo `202` corresponde a um lead persistido.
- TypeScript strict com `erasableSyntaxOnly` (compatível com type stripping do Node 24), framework HTTP **Hono**
  (leve, middlewares de segurança prontos, suportado sem config na Vercel), Fluid Compute na região `gru1`.

## Consequences

- (+) Um deploy, uma pipeline, transações locais simples; extração futura facilitada pelos boundaries.
- (+) Hono é portátil (Vercel, Cloudflare Workers, Node) — sem lock-in no framework.
- (−) Acoplamento transacional entre `lead-capture` e `crm`; aceitável enquanto estiverem no mesmo banco.
  Se extraídos, substituir por evento `lead.submitted` no outbox.
- (−) Sem Next.js no backend: CRM UI (wave 10) será app separado que consome a API.
