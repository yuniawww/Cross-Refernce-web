#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

image_tag=cross-reference-linux-deps:local
archive=linux-node-modules-ubuntu2204-amd64.tar.gz
temp_dir=$(mktemp -d)
container_id=

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

docker info >/dev/null
docker buildx build --platform linux/amd64 --target dependencies --load --tag "$image_tag" .
docker run --rm --platform linux/amd64 "$image_tag" \
  node -e 'const fs = require("node:fs"); const p = require("puppeteer"); fs.mkdirSync("/app/tmp", {recursive: true}); (async () => {const b = await p.launch({headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"]}); const page = await b.newPage(); await page.setContent("<title>linux-ready</title>"); if (await page.title() !== "linux-ready") process.exitCode = 1; await b.close()})().catch(e => {console.error(e); process.exit(1)})'

container_id=$(docker create --platform linux/amd64 "$image_tag")
docker cp "$container_id:/app/node_modules" "$temp_dir/node_modules"
tar -C "$temp_dir" -czf "$temp_dir/$archive" node_modules
mv "$temp_dir/$archive" "$archive"

echo "Created $archive"
