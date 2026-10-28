#!/bin/sh
# Explicit offline volume backup/restore. Never removes/reuses an existing volume.
set -eu
umask 077
action=${1:-help}
if [ "$action" = help ]; then
  echo 'Usage: volume-backup.sh backup|restore UNIQUE_COMPOSE_PROJECT NEW_BACKUP_DIR LOCAL_IMAGE'
  echo 'backup requires BOTH services stopped; restore requires a NEW project and the original image ID.'
  exit 0
fi
[ "$#" = 4 ] || { echo 'Expected four arguments; use help' >&2; exit 1; }
project=$2 directory=$3 image=$4
case "$project" in ''|*[!a-z0-9_-]*|[-_]*) echo 'Use a lowercase Compose project name' >&2; exit 1;; esac
case "$action" in backup|restore) ;; *) echo 'Unknown action' >&2; exit 1;; esac
image_id=$(docker image inspect --format '{{.Id}}' "$image") # No implicit image pull.
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
if [ "$action" = backup ]; then
  [ ! -e "$directory" ] || { echo 'Backup destination must not exist' >&2; exit 1; }
  for suffix in harness-data tailnet-state; do
    volume=${project}_${suffix}
    owner=$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$volume")
    [ "$owner" = "$project" ] || { echo "Volume does not belong to project: $volume" >&2; exit 1; }
    [ -z "$(docker ps -q --filter "volume=$volume")" ] || { echo "Stop all containers using $volume before backup" >&2; exit 1; }
  done
  mkdir -m 700 "$directory"
  printf '%s\n' "$image_id" > "$directory/image-id"
  for suffix in harness-data tailnet-state; do
    docker run --rm --pull=never --network none --read-only --user 0:0 --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges \
      --mount "type=volume,source=${project}_${suffix},target=/source,readonly" --entrypoint tar "$image_id" -czf - -C /source . > "$directory/$suffix.tar.gz"
  done
  (cd "$directory" && checksum harness-data.tar.gz tailnet-state.tar.gz > SHA256SUMS)
  echo "Offline backup saved to $directory; protect it as credentials. No volumes removed."
else
  [ -d "$directory" ] && [ ! -L "$directory" ] || { echo 'Use the backup directory' >&2; exit 1; }
  [ "$(cat "$directory/image-id")" = "$image_id" ] || { echo 'Restore with the original image ID recorded in image-id' >&2; exit 1; }
  # Compare only the two fixed archive names, without trusting paths embedded in a checksum file.
  expected=$(cat "$directory/SHA256SUMS")
  actual=$(cd "$directory" && checksum harness-data.tar.gz tailnet-state.tar.gz)
  [ "$expected" = "$actual" ] || { echo 'Backup checksum mismatch' >&2; exit 1; }
  for suffix in harness-data tailnet-state; do
    if docker volume inspect "${project}_${suffix}" >/dev/null 2>&1; then echo 'Restore requires an unused project; existing volumes are never overwritten' >&2; exit 1; fi
  done
  for suffix in harness-data tailnet-state; do
    volume=${project}_${suffix}
    docker volume create --label "com.docker.compose.project=$project" --label "com.docker.compose.volume=$suffix" "$volume" >/dev/null
    docker run --rm -i --pull=never --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
      --mount "type=volume,source=$volume,target=/restore" --entrypoint tar "$image_id" -xzpf - -C /restore < "$directory/$suffix.tar.gz"
  done
  echo "Restored into new project $project. Nothing started. Keep the old Tailnet node stopped before starting this identity."
fi
