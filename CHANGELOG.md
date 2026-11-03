# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem SemVer.
Contrato da API versionado à parte em `contracts/openapi.v1.yaml` (`info.version`).

## [Unreleased]

### Added

- Spec-Driven Development do projeto: specs (`docs/specs/`), ADRs 0001–0007, contrato OpenAPI,
  threat model e plano de ondas com sub-ondas paralelizáveis (`docs/plan/implementation-waves.md`).
- Onda 0 — fundação da API (`apps/api`): workspace pnpm/Node 24, TypeScript strict, Hono,
  platform kernel (config Zod, logger com redação de PII, correlation ID, erros RFC 9457,
  headers de segurança, CORS allowlist, limite de 16 KB, métricas, OTel, HMAC), `GET /v1/health`,
  ports congelados de `lead-capture`, `crm` e `tracking`, regras de boundaries por lint.
- CI (`.github/workflows/ci.yml`) com Actions pinadas por SHA, gitleaks, osv-scanner, Semgrep e
  Redocly; Dependabot; hooks locais versionados (`.githooks/`, `scripts/verify.sh`).

### Changed

- Contrato `1.0.0-draft.2`: `not_found` adicionado a `Problem.code` (compatível).

### Security

- Override de `zod` transitivo (`@vercel/cli-config`) para 4.6.7 (advisory high em `<4.6.6`).
- Risco aceito até 2027-01-31: `minimatch` moderado, só em dev via ESLint (`osv-scanner.toml`).
