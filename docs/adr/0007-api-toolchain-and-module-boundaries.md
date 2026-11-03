# ADR-0007 — Toolchain da API e enforcement de boundaries

- Status: accepted
- Data: 2026-11-03

## Context

A Onda 0 precisava de alias de import, regra de boundaries entre módulos (ADR-0001), build e
política de dependências. O texto original da spec citava alias `@/` e "`eslint-plugin-boundaries`
ou `dependency-cruiser`". Na implementação apareceram restrições concretas:

- Alias `@/` via `tsconfig.paths` depende do bundler; não sabemos se o builder da Vercel para Hono
  resolve `paths`, e o Node 24 (type stripping) não resolve.
- TypeScript 7 (nativo) é o `latest` no npm, mas `typescript-eslint` 8.72 exige `typescript <6.1`.
- Em padrões estilo gitignore (`group` do `no-restricted-imports`), um `#` no início é comentário:
  regras escritas com `#/...` ficavam desligadas sem aviso.
- Ondas paralelas (1 ∥ 2 ∥ 3, 5a ∥ 4) não podem disputar `package.json`/lockfile.

## Decision

- **Alias `#/`** via `imports` do `apps/api/package.json` (`"#/*": "./src/*"`), com extensão `.ts`
  explícita. Resolvido nativamente por Node 24, TypeScript (`nodenext`), Vitest e esbuild.
- **TypeScript 6.0.x pinado** até o typescript-eslint suportar o 7.
- **Boundaries com `no-restricted-imports` + `regex`** em `apps/api/eslint.config.ts`: módulo só
  importa outro via `public-api.ts`; `domain/` só importa o próprio domínio e `#/shared`, sem I/O
  nem Zod; `application/` não importa infra, presentation, drivers nem `#/platform` (exceto
  `#/platform/crypto`); proibidos imports `../`. Verificado com arquivos de violação na Onda 0.
  Exceção documentada: `libphonenumber-js` é permitido no domínio (biblioteca pura, lead-capture §4.1).
- **`#/shared`** é o shared kernel puro (Result, IDs com brand, Clock, UnitOfWork/Transaction
  opaca, AuditLogWriter, vocabulários do perfil do lead). Não tem I/O nem dependência externa.
- **Build = bundle de verificação com esbuild** (`dist/index.js`): prova que o entrypoint resolve
  e sobe. O deploy continua a cargo do builder da Vercel; a Onda 4 valida o preview.
- **Supply chain no pnpm** (`pnpm-workspace.yaml`): `minimumReleaseAge` de 7 dias, versões exatas
  (`savePrefix: ''`), `strictPeerDependencies`, `onlyBuiltDependencies`. As dependências das ondas
  1–5 são instaladas na Onda 0.
- **ESLint com config em TS** carregada pelo Node nativo (`--flag unstable_native_nodejs_ts_config`),
  sem `jiti`.
- **Logger** redige PII na saída: cada linha JSON passa por `redactDeep` antes de ser escrita,
  porque o pino não aplica `formatters` aos bindings de `child()`.

## Consequences

- (+) Nenhum alias depende de plugin de bundler; mesma resolução em teste, dev e build.
- (+) Boundaries quebram o CI. Ondas paralelas não mexem no lockfile.
- (−) `#/` em vez do `@/` da spec original (o plano já foi atualizado).
- (−) A flag do ESLint é `unstable_`: se mudar de nome, trocar no script `lint` ou adicionar `jiti`.
- (−) A redação na saída custa um `JSON.parse` por linha de log. Aceitável no volume v1.
- Risco aberto: confirmar na Onda 4 que o builder da Vercel resolve os `imports` `#/` no deploy.
