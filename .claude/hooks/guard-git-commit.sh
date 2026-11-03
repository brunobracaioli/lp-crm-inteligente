#!/usr/bin/env bash
# Claude Code PreToolUse hook (Bash). Keeps agents from skipping the local quality gate:
#   - blocks `git commit|push --no-verify` / `git commit -n`
#   - blocks overriding core.hooksPath on the command line
#   - blocks commit/push while the versioned hooks are not active (scripts/setup-dev.sh)
# The checks themselves live in .githooks/ + scripts/verify.sh, so they also apply to humans and Codex.
# Exit 2 = block the tool call; stderr is shown to the agent.
set -euo pipefail

command="$(jq -r '.tool_input.command // empty')"
[[ -z "$command" ]] && exit 0

# Only care about git commit / git push (including `git -c x=y commit`).
if ! grep -qE '(^|[;&|[:space:]])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+(commit|push)([[:space:]]|$)' <<<"$command"; then
  exit 0
fi

block() {
  echo "guard-git-commit: $1" >&2
  exit 2
}

if grep -qE '(^|[[:space:]])--no-verify([[:space:]]|$)' <<<"$command"; then
  block "--no-verify is not allowed. Fix what the pre-commit/pre-push gate reports (scripts/verify.sh)."
fi

if grep -qE '[[:space:]]commit([[:space:]]|$)' <<<"$command" \
  && grep -qE '(^|[[:space:]])-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$)' <<<"$command"; then
  block "'git commit -n' skips the hooks and is not allowed. If -n is part of the message, rephrase it."
fi

if grep -oiE 'core\.hooksPath([=[:space:]]+[^[:space:];&|]*)?' <<<"$command" \
  | grep -viqE '^core\.hooksPath[=[:space:]]+["'\'']?\.githooks["'\'']?$'; then
  block "pointing core.hooksPath anywhere other than .githooks is not allowed."
fi

project_dir="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
hooks_path="$(git -C "$project_dir" config --get core.hooksPath || true)"
if [[ "$hooks_path" != ".githooks" ]]; then
  block "git hooks are not active (core.hooksPath='${hooks_path}'). Run scripts/setup-dev.sh first."
fi

exit 0
