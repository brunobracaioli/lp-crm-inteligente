#!/usr/bin/env bash
# One-time developer setup: activates the versioned git hooks and installs pinned dev tools.
# Idempotent — safe to run again after pulling changes.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

GITLEAKS_VERSION="8.30.1"
# From https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
declare -A GITLEAKS_SHA256=(
  [linux_x64]="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
  [linux_arm64]="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
)
INSTALL_DIR="${HOME}/.local/bin"
DOWNLOAD_TIMEOUT_SECONDS=60

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1 && gitleaks version 2>/dev/null | grep -q "$GITLEAKS_VERSION"; then
    echo "✓ gitleaks $GITLEAKS_VERSION already installed"
    return
  fi

  local arch
  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) echo "unsupported architecture: $(uname -m) — install gitleaks $GITLEAKS_VERSION manually" >&2; exit 1 ;;
  esac
  local platform="linux_${arch}"
  local expected="${GITLEAKS_SHA256[$platform]:-}"
  if [[ "$(uname -s)" != "Linux" || -z "$expected" ]]; then
    echo "unsupported platform — install gitleaks $GITLEAKS_VERSION manually" >&2
    exit 1
  fi

  local tarball="gitleaks_${GITLEAKS_VERSION}_${platform}.tar.gz"
  local url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${tarball}"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  echo "↓ downloading gitleaks $GITLEAKS_VERSION ($platform)"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --max-time "$DOWNLOAD_TIMEOUT_SECONDS" --output "$tmp/$tarball" "$url"

  echo "$expected  $tmp/$tarball" | sha256sum --check --quiet \
    || { echo "checksum mismatch for $tarball — aborting" >&2; exit 1; }

  tar -xzf "$tmp/$tarball" -C "$tmp" gitleaks
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$tmp/gitleaks" "$INSTALL_DIR/gitleaks"
  echo "✓ gitleaks installed at $INSTALL_DIR/gitleaks"
}

activate_hooks() {
  chmod +x .githooks/* scripts/*.sh
  git config core.hooksPath .githooks
  echo "✓ git hooks active (core.hooksPath=.githooks): pre-commit, commit-msg, pre-push"
}

install_gitleaks
activate_hooks

if ! command -v pnpm >/dev/null 2>&1 || [[ "$(command -v pnpm)" == /mnt/* ]]; then
  echo "! pnpm is missing or resolves to a Windows binary — inside WSL run: corepack enable" >&2
fi
