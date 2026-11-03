# ADR-0002 — LP no Cloudflare Pages, API na Vercel, Turnstile como anti-bot

- Status: accepted
- Data: 2026-11-03

## Context

A LP é estática (feita pelo Codex) e precisa de CDN global, proteção DDoS e anti-bot.
A API roda na Vercel. Colocar a Vercel atrás do proxy da Cloudflare ("nuvem laranja")
duplica camadas de cache/WAF, quebra a detecção de IP real e o firewall da Vercel, e a
Vercel desaconselha esse arranjo.

## Decision

- LP em **Cloudflare Pages** em `www.<dominio>` (proxy Cloudflare ativo, headers via `_headers`).
- API na **Vercel** em `api.<dominio>`, registro DNS na Cloudflare em modo **DNS-only** (nuvem cinza).
  Proteção de borda da API = Vercel Firewall (DDoS automático + regras custom + rate limit) — wave 6.
- **Cloudflare Turnstile** (modo managed) no formulário, verificado server-side pela API a cada submissão.
- Chamada LP → API é cross-origin: CORS com allowlist explícita, sem credenciais.

## Consequences

- (+) Cada plataforma faz o que faz melhor; IP real do cliente disponível na Vercel (`ipAddress()`).
- (+) Turnstile independe do proxy — funciona com a API fora da Cloudflare.
- (−) Preflight CORS adiciona um round-trip (mitigado com `Access-Control-Max-Age: 600`).
- (−) Duas superfícies de configuração (Cloudflare e Vercel) — ambas em IaC (`_headers`, `vercel.json`).
