#!/usr/bin/env bash
# Local quality gate — mirrors the CI gates from docs/plan/implementation-waves.md (Onda 0).
#
# Usage:
#   scripts/verify.sh staged   # fast gate on the staged changes (git pre-commit hook)
#   scripts/verify.sh full     # whole repo: lint, typecheck, test, build, secrets, OpenAPI (pre-push / manual)
#
# Exit code 0 = every gate passed (or was skipped with a reason); non-zero = at least one gate failed.
set -euo pipefail

MODE="${1:-full}"
if [[ "$MODE" != "staged" && "$MODE" != "full" ]]; then
  echo "usage: scripts/verify.sh [staged|full]" >&2
  exit 64
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FAILURES=0
step() { printf '\n▶ %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
skip() { printf '  – skipped: %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# Files in scope: staged (added/copied/modified/renamed) or every tracked file.
list_files() {
  if [[ "$MODE" == "staged" ]]; then
    git diff --cached --name-only --diff-filter=ACMR
  else
    git ls-files
  fi
}

# Content to scan for one file: only the added lines (staged) or the whole tracked file (full).
file_content() {
  local file="$1"
  if [[ "$MODE" == "staged" ]]; then
    git diff --cached -U0 --diff-filter=ACMR -- "$file" | grep '^+' | grep -v '^+++' || true
  else
    cat -- "$file"
  fi
}

mapfile -t FILES < <(list_files)

if [[ "$MODE" == "staged" && ${#FILES[@]} -eq 0 ]]; then
  echo "verify: nothing staged."
  exit 0
fi

# ---------------------------------------------------------------------------
step "Forbidden files (.env, keys, venv, local settings, dumps)"
FORBIDDEN_FILE_REGEX='(^|/)\.env(\..+)?$|\.(pem|key|p12|pfx|jks)$|(^|/)id_(rsa|ecdsa|ed25519)|(^|/)(venv|\.venv|node_modules)/|(^|/)settings\.local\.json$|\.(dump|bak|backup)$|\.sql\.gz$'
bad_files=()
for f in "${FILES[@]}"; do
  [[ "$f" == *.env.example ]] && continue
  if [[ "$f" =~ $FORBIDDEN_FILE_REGEX ]]; then
    bad_files+=("$f")
  fi
done
if [[ ${#bad_files[@]} -gt 0 ]]; then
  fail "files that must never be committed: ${bad_files[*]}"
  printf '    unstage with: git restore --staged -- <file>\n' >&2
else
  ok "no forbidden files"
fi

# ---------------------------------------------------------------------------
step "Secret scan (gitleaks)"
if command -v gitleaks >/dev/null 2>&1; then
  if [[ "$MODE" == "staged" ]]; then
    gitleaks_args=(git --staged --no-banner --redact --exit-code 1)
  else
    gitleaks_args=(git --no-banner --redact --exit-code 1)
  fi
  if gitleaks "${gitleaks_args[@]}" >/dev/null 2>&1; then
    ok "no secrets found"
  else
    fail "gitleaks found possible secrets — details: gitleaks ${gitleaks_args[*]} -v"
    printf '    a leaked secret is compromised: rotate it, do not just remove it from the diff.\n' >&2
  fi
else
  # Fail closed: committing without a secret scan is not allowed.
  fail "gitleaks not installed — run scripts/setup-dev.sh"
fi

# ---------------------------------------------------------------------------
step "Forbidden code patterns (fast feedback; Semgrep in CI is authoritative)"
# Production source only; tests and scripts may use console.
CODE_FILE_REGEX='^(apps|packages)/[^/]+/src/.*\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$'
TEST_FILE_REGEX='\.(test|spec)\.[cm]?[jt]sx?$|/__tests__/|/test/'
declare -A PATTERNS=(
  ['sql\.unsafe[[:space:]]*\(']='sql.unsafe is forbidden — use tagged templates (ADR-0003)'
  ['dangerouslySetInnerHTML']='dangerouslySetInnerHTML is forbidden'
  ['(^|[^.[:alnum:]_])eval[[:space:]]*\(|new[[:space:]]+Function[[:space:]]*\(']='eval / new Function is forbidden'
  ['console\.(log|debug|info|trace)[[:space:]]*\(']='console.* in production code — use the structured logger'
)
pattern_hits=0
for f in "${FILES[@]}"; do
  [[ "$f" =~ $CODE_FILE_REGEX ]] || continue
  [[ "$f" =~ $TEST_FILE_REGEX ]] && continue
  [[ -f "$f" ]] || continue
  content="$(file_content "$f")"
  [[ -z "$content" ]] && continue
  for pattern in "${!PATTERNS[@]}"; do
    if grep -qE -- "$pattern" <<<"$content"; then
      fail "$f: ${PATTERNS[$pattern]}"
      pattern_hits=$((pattern_hits + 1))
    fi
  done
done
# Unresolved merge conflict markers, any file type.
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  if file_content "$f" | grep -qE '^\+?(<<<<<<<|>>>>>>>)( |$)'; then
    fail "$f: unresolved merge conflict marker"
    pattern_hits=$((pattern_hits + 1))
  fi
done
[[ $pattern_hits -eq 0 ]] && ok "no forbidden patterns"

# ---------------------------------------------------------------------------
workspace_title="lint · typecheck · test"
[[ "$MODE" == "full" ]] && workspace_title+=" · build"
step "Workspace: $workspace_title"
has_code_changes=true
if [[ "$MODE" == "staged" ]]; then
  has_code_changes=false
  for f in "${FILES[@]}"; do
    if [[ ! "$f" =~ \.md$ && ! "$f" =~ ^docs/ ]]; then
      has_code_changes=true
      break
    fi
  done
fi

if [[ ! -f package.json ]]; then
  skip "no package.json yet (workspace is created in Onda 0)"
elif [[ "$has_code_changes" == false ]]; then
  skip "only docs/markdown staged"
else
  PNPM_BIN="$(command -v pnpm || true)"
  if [[ -z "$PNPM_BIN" ]]; then
    fail "pnpm not found — enable it with: corepack enable"
  elif [[ "$PNPM_BIN" == /mnt/* ]]; then
    fail "pnpm resolves to a Windows binary ($PNPM_BIN) — inside WSL run: corepack enable"
  elif [[ ! -d node_modules ]]; then
    fail "dependencies not installed — run: pnpm install --frozen-lockfile"
  else
    scripts=(lint typecheck test)
    [[ "$MODE" == "full" ]] && scripts+=(build)
    for script in "${scripts[@]}"; do
      if pnpm -r --if-present run "$script"; then
        ok "pnpm -r $script"
      else
        fail "pnpm -r $script"
      fi
    done
  fi
fi

# ---------------------------------------------------------------------------
step "OpenAPI contract lint (redocly)"
contract_changed=true
if [[ "$MODE" == "staged" ]]; then
  contract_changed=false
  for f in "${FILES[@]}"; do
    [[ "$f" == contracts/* ]] && contract_changed=true && break
  done
fi
if [[ "$contract_changed" == false ]]; then
  skip "contracts/ not changed"
elif [[ ! -x node_modules/.bin/redocly ]]; then
  # No `npx` here on purpose: a hook must not download unpinned code.
  skip "@redocly/cli not installed as devDependency yet (Onda 0)"
elif node_modules/.bin/redocly lint contracts/openapi.v1.yaml; then
  ok "contracts/openapi.v1.yaml"
else
  fail "redocly lint contracts/openapi.v1.yaml"
fi

# ---------------------------------------------------------------------------
echo
if [[ $FAILURES -gt 0 ]]; then
  echo "verify ($MODE): $FAILURES gate(s) failed." >&2
  exit 1
fi
echo "verify ($MODE): all gates passed."
