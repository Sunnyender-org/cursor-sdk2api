#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
compose_file="$script_dir/docker-compose.yml"
NEW_API_PORT=$(node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
export NEW_API_PORT
COMPOSE_PROJECT_NAME="cursor-sdk2api-e2e-${NEW_API_PORT}"
export COMPOSE_PROJECT_NAME

cleanup() {
  docker compose -f "$compose_file" --profile verify down --volumes --remove-orphans
}
trap cleanup EXIT

docker compose -f "$compose_file" --profile verify up -d --build gateway new-api
docker compose -f "$compose_file" --profile verify run --rm network-probe
curl --fail --silent --show-error "http://127.0.0.1:${NEW_API_PORT}/api/status" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${NEW_API_PORT}/" >/dev/null
echo "new-api compose infrastructure E2E passed"
