# Gates de qualidade locais (pre-commit, commit-msg, pre-push)

Antecipa o item "Pre-commit com gitleaks" da Onda 0 (`docs/plan/implementation-waves.md`).
O CI continua sendo a barreira oficial; os hooks dão feedback antes do push.

## Instalar (uma vez por clone)

```bash
scripts/setup-dev.sh
```

Instala o gitleaks **8.30.1** (checksum SHA-256 conferido) em `~/.local/bin` e ativa
`git config core.hooksPath .githooks`. No WSL, rode também `corepack enable` para não usar o
`pnpm` do Windows.

## Node 24 e pnpm pinado

Os hooks usam o `node`/`pnpm` do PATH. O projeto exige Node 24 (`.nvmrc`) e o pnpm do
`packageManager` (via corepack):

```bash
nvm install 24 && nvm alias default 24   # se o nvm reclamar de `prefix`, rode: nvm use --delete-prefix 24
corepack enable                          # cria o shim do pnpm dentro do Node 24
pnpm install --frozen-lockfile
```

Confira com `which pnpm`: não pode apontar para `/mnt/c/...` (binário do Windows).

## O que roda

| Hook | Comando | Verifica |
|------|---------|----------|
| `pre-commit` | `scripts/verify.sh staged` | arquivos proibidos (`.env*`, chaves, `venv/`, `settings.local.json`, dumps) · gitleaks no staged · padrões proibidos nas linhas adicionadas de `apps/*/src` e `packages/*/src` (`sql.unsafe`, `dangerouslySetInnerHTML`, `eval`/`new Function`, `console.*`) · marcadores de conflito · `pnpm -r lint/typecheck/test` (se houver código staged) · `redocly lint` (se `contracts/` mudou) |
| `commit-msg` | `.githooks/commit-msg` | Conventional Commits, header ≤ 72 caracteres |
| `pre-push` | `scripts/verify.sh full` | tudo acima no repo inteiro + gitleaks no histórico + `pnpm -r build` |

Etapas sem pré-requisito (sem `package.json`, sem `@redocly/cli` instalado) aparecem como
`skipped` com o motivo. O gitleaks ausente **falha** (fail closed).

Rodar manualmente, a qualquer momento: `scripts/verify.sh full`.

## Agentes (Claude Code)

`.claude/settings.json` registra `.claude/hooks/guard-git-commit.sh` (PreToolUse/Bash), que
bloqueia `--no-verify`, `git commit -n`, `core.hooksPath` apontando para outro lugar e
commit/push com os hooks desativados. Também nega leitura/escrita de `.env*` pelos agentes.

## Quando um gate falha

- **gitleaks**: segredo vazado é segredo comprometido — rotacione, não basta remover do diff.
  Falso positivo: adicione o fingerprint em `.gitleaksignore` com justificativa no PR.
- **padrão proibido**: corrija o código; as regras vêm do `CLAUDE.md`/`AGENTS.md`.
- Não use `--no-verify`.
