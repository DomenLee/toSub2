#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ ! ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([a-f0-9]{40})$ ]]; then
  echo 'Only deploy <full main SHA> is allowed' >&2
  exit 64
fi
sha=${BASH_REMATCH[1]}
image="ghcr.io/domenlee/tosub2:$sha"
root=/opt/tosub2
compose="$root/compose.yaml"
exec 9>"$root/deploy.lock"
flock -w 30 9
latest=$(curl --fail --silent --show-error --retry 2 --max-time 30 https://api.github.com/repos/DomenLee/toSub2/commits/main | jq -er .sha)
[[ "$sha" == "$latest" ]] || { echo 'Refusing stale or non-main deployment' >&2; exit 65; }

registry=$(mktemp -d "$root/.registry.XXXXXX")
backup=''
stopped=false
changed=false
new_config_hash=''
compose_hash=$(sha256sum "$compose" | cut -d' ' -f1)
old_image=$(docker compose -p tosub2 -f "$compose" config --format json | jq -er .services.tosub2.image)
current=$(docker compose -p tosub2 -f "$compose" ps -q tosub2)
[[ -n "$current" && $(docker inspect --format '{{.Config.Image}}' "$current") == "$old_image" ]] || { rm -rf "$registry"; echo 'Running image and Compose disagree; manual review required' >&2; exit 66; }

cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && [[ -n "$backup" ]]; then
    docker compose -p tosub2 -f "$compose" logs --no-color --tail 150 tosub2 > "$backup/failure.log" 2>&1 || true
    if ! python3 "$root/bin/password-stage.py" rollback "$root" "$sha" "$backup"; then
      echo "Password changed externally; application rollback requires review. Inspect $backup" >&2
      rm -rf "$registry"
      exit "$status"
    fi
    if [[ "$changed" == true && $(sha256sum "$compose" | cut -d' ' -f1) == "$new_config_hash" ]]; then
      cp -p "$backup/compose.yaml" "$compose"
      docker compose -p tosub2 -f "$compose" up -d --no-deps --wait --wait-timeout 120 tosub2 >> "$backup/rollback.log" 2>&1 || echo "Rollback failed; inspect $backup/rollback.log" >&2
    elif [[ "$stopped" == true && $(sha256sum "$compose" | cut -d' ' -f1) == "$compose_hash" ]]; then
      docker compose -p tosub2 -f "$compose" start tosub2 >> "$backup/rollback.log" 2>&1 || echo "Restart failed; inspect $backup/rollback.log" >&2
    else
      echo "Configuration changed externally; refusing to overwrite it. Inspect $backup" >&2
    fi
    echo "Deployment failed. Backup and restricted logs: $backup" >&2
  fi
  rm -rf "$registry"
  exit "$status"
}
trap cleanup EXIT

IFS= read -r token
[[ -n "$token" ]] || { echo 'Missing short-lived GHCR credential' >&2; exit 67; }
printf '%s\n' "$token" | docker --config "$registry" login ghcr.io -u domenlee --password-stdin >/dev/null 2>&1
unset token
docker --config "$registry" pull "$image"
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "$sha" ]]
session_auth=false
if [[ $(docker image inspect --format '{{index .Config.Labels "io.tosub2.auth"}}' "$image") == session-v1 ]]; then session_auth=true; fi
if [[ -f "$root/secrets/console-password.pending" ]]; then
  [[ "$session_auth" == true ]] || { echo 'Staged password requires a session-auth image' >&2; exit 68; }
  python3 "$root/bin/password-stage.py" check "$root" "$sha" "$root/backups"
fi

docker exec -i -e TOSUB2_PROBE_MODE=idle "$current" node --input-type=module < "$root/bin/probe.mjs"

backup="$root/backups/github-$sha-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup"
cp -p "$compose" "$backup/compose.yaml"
if [[ -f "$root/.env" ]]; then cp -p "$root/.env" "$backup/environment"; fi
docker inspect --format '{{.Config.Image}} {{.Image}} {{.State.StartedAt}}' "$current" > "$backup/previous-image.txt"
docker exec sub2api-postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-sub2api}" -Fc' > "$backup/database.dump"
test -s "$backup/database.dump"
latest=$(curl --fail --silent --show-error --retry 2 --max-time 30 https://api.github.com/repos/DomenLee/toSub2/commits/main | jq -er .sha)
[[ "$sha" == "$latest" && $(sha256sum "$compose" | cut -d' ' -f1) == "$compose_hash" ]]
stopped=true
docker compose -p tosub2 -f "$compose" stop -t 45 tosub2
tar -C "$root" -czf "$backup/data.tar.gz" data
python3 - "$compose" "$old_image" "$image" "$session_auth" <<'PY'
import os
import pathlib
import re
import sys
target = pathlib.Path(sys.argv[1])
source = target.read_text()
pattern = r'(?m)^    image: ' + re.escape(sys.argv[2]) + r'$'
if len(re.findall(pattern, source)) != 1:
    raise SystemExit('Compose image entry changed; deployment refused')
temporary = target.with_suffix('.yaml.new')
updated = re.sub(pattern, '    image: ' + sys.argv[3], source)
if sys.argv[4] == 'true':
    health = r'(?m)^      test: .*$'
    if len(re.findall(health, updated)) != 1:
        raise SystemExit('Compose health check changed; deployment refused')
    updated = re.sub(health, '''      test: [CMD, node, -e, "fetch('http://127.0.0.1:4399/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]''', updated)
temporary.write_text(updated)
os.chmod(temporary, 0o600)
os.replace(temporary, target)
PY
new_config_hash=$(sha256sum "$compose" | cut -d' ' -f1)
changed=true
docker compose -p tosub2 -f "$compose" config --quiet
python3 "$root/bin/password-stage.py" apply "$root" "$sha" "$backup"
docker compose -p tosub2 -f "$compose" up -d --no-deps --pull never --wait --wait-timeout 120 tosub2
deployed=$(docker compose -p tosub2 -f "$compose" ps -q tosub2)
[[ $(docker inspect --format '{{.Config.Image}}' "$deployed") == "$image" ]]
[[ $(docker inspect --format '{{.Image}}' "$deployed") == $(docker image inspect --format '{{.Id}}' "$image") ]]
docker exec -i -e "TOSUB2_PROBE_SESSION=$session_auth" "$deployed" node --input-type=module < "$root/bin/probe.mjs"
python3 "$root/bin/password-stage.py" complete "$root" "$sha" "$backup"
echo "Deployed toSub2 main $sha; backup: $backup"
