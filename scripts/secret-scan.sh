#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(git rev-parse --show-toplevel)

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks dir "$repo_dir" --config "$repo_dir/.gitleaks.toml" --redact --no-banner
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  exec docker run --rm \
    -v "$repo_dir:/repo:ro" \
    -w /repo \
    ghcr.io/gitleaks/gitleaks:v8.28.0 \
    dir . --config .gitleaks.toml --redact --no-banner
fi

echo "secret scan requires gitleaks or a running Docker daemon" >&2
exit 2
