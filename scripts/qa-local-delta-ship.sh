#!/usr/bin/env bash
# QA-042: ship a CHANGE, not an image, when the link to the cluster host is slow.
#
#   scripts/qa-local-delta-ship.sh rust <service> <tag> --expect <text> [--expect ...]      # ledger-bridge | recon-worker
#   scripts/qa-local-delta-ship.sh server <tag> <base-tag> --expect <text> [--absent <text>] [...]
#
# WHY: `scripts/qa-local-ship.sh` streams the whole image (`docker save | ssh docker load`). That is fine at the ~0.5 MB/s this
# link usually manages and hopeless at the ~23 KB/s it managed on 2026-09-21 (a Tailscale DERP relay with a ~3 s round trip):
# 18 MB in 13 minutes, ~280 MB of images to go. What actually changed was two 10 MB binaries and a 15 MB dist/ — 11 MB
# compressed. So: send only that, and rebuild the image ON THE HOST from a base that is already there.
#   rust:   runtime stage of rust/<svc>/Dockerfile (debian:bookworm-slim + apt libssl) + your binary.
#   server: the PREVIOUS server image, exported from a kind node's containerd (no network), with /app/dist replaced.
# It then verifies the artifact by CONTENT on the host-built image (what the laptop-built one was checked for), loads it into
# kind, and removes only what it created. It never removes a tag from the nodes. It does NOT change any Deployment.
#
# STATUS, honestly: the equivalent one-off host scripts were what actually shipped qa-local3/4 and qa-local8 on 2026-09-21/22.
# This consolidated version has had its REFUSALS and its --dry-run plan tested (server/qaLocalShipScript.test.ts) but has NOT
# itself been run end to end — the first real use should be watched.
#
# LIMITS, honestly: the host builds a slightly different image than your laptop did (same binary/dist, host-side base
# layers). That is acceptable for a dev cluster and would not be for a release — releases come from CI.
# Two traps this script encodes, both found the hard way: the kind nodes' /tmp is a tmpfs, so `docker cp` from it fails (the
# tar is streamed with `docker exec cat`); and /app is root-owned while the image runs as `node`, so removing /app/dist needs USER root.
set -euo pipefail

REGISTRY="${REGISTRY:-registry.digitalocean.com/talentgraph-auth}"
HOST="${SHIP_HOST:-newwaveclaw@america}"
NODE="${KIND_NODE:-newwave-dev-worker}"
KIND_CLUSTER="${KIND_CLUSTER:-newwave-dev}"
die() { echo "error: $*" >&2; exit 2; }

kind_of="${1:-}"; shift || true
expects=(); absents=()
parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --expect) [ $# -ge 2 ] || die "--expect needs a value"; expects+=("$2"); shift 2 ;;
      --absent) [ $# -ge 2 ] || die "--absent needs a value"; absents+=("$2"); shift 2 ;;
      --dry-run) DRY=1; shift ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}
DRY=0
tag_ok() { [[ "$1" =~ ^qa-local[0-9]+$ ]] || die "tag must look like qa-local<N> (got '$1')"; [ "$1" != latest ] || die "refusing 'latest'"; }

case "$kind_of" in
  rust)
    svc="${1:-}"; tag="${2:-}"; [ -n "$svc" ] && [ -n "$tag" ] || die "usage: rust <service> <tag> --expect <text> ..."; shift 2; parse_flags "$@"
    case "$svc" in ledger-bridge) port=8095 ;; recon-worker) port="" ;; *) die "rust service must be ledger-bridge or recon-worker" ;; esac
    tag_ok "$tag"; [ ${#expects[@]} -gt 0 ] || die "give at least one --expect (the binary must contain what you think it does)"
    image="$REGISTRY/whatsapp-$svc:$tag"
    echo "plan: rebuild $image on $HOST from the binary in the local image $image"
    echo "  1. extract /$svc from the LOCAL image, and check the binary contains: ${expects[*]}"
    echo "  2. upload only that binary (gzip -9), ~4 MB"
    echo "  3. on the host: docker build (debian:bookworm-slim + $svc), verify by content, kind load, remove the host copy"
    [ "$DRY" = 1 ] && { echo "(dry run: nothing executed)"; exit 0; }
    work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
    docker image inspect "$image" >/dev/null 2>&1 || die "image $image is not built locally"
    cid=$(docker create "$image"); docker cp "$cid:/$svc" "$work/$svc"; docker rm -f "$cid" >/dev/null
    for e in "${expects[@]}"; do grep -qF -- "$e" "$work/$svc" || die "the binary does NOT contain '$e' — refusing to ship"; echo "  verified locally: '$e'"; done
    gzip -9 -c "$work/$svc" | ssh "$HOST" "mkdir -p /tmp/qa-delta && gunzip > /tmp/qa-delta/$svc && chmod +x /tmp/qa-delta/$svc"
    ssh "$HOST" 'bash -s' -- "$svc" "$image" "${port:-}" "$NODE" "$KIND_CLUSTER" "${expects[@]}" <<'REMOTE'
set -euo pipefail
svc="$1"; image="$2"; port="$3"; node="$4"; kc="$5"; shift 5
D=/tmp/qa-delta/ctx-$svc; mkdir -p "$D"; cp /tmp/qa-delta/$svc "$D/$svc"
{ echo 'FROM debian:bookworm-slim'
  echo 'RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*'
  echo "COPY $svc /$svc"; [ -n "$port" ] && echo "EXPOSE $port"; echo "ENTRYPOINT [\"/$svc\"]"; } > "$D/Dockerfile"
docker build -q -t "$image" "$D" >/dev/null
for e in "$@"; do
  h=$(docker run --rm --entrypoint sh "$image" -c 'grep -cF -- "$1" "$2"' _ "$e" "/$svc" | tr -d '[:space:]')
  [ "${h:-0}" -gt 0 ] || { echo "host-built image lacks '$e' — NOT loading"; exit 3; }; echo "  verified on host: '$e'"
done
kind load docker-image "$image" --name "$kc" >/dev/null
docker rmi "$image" >/dev/null 2>&1 || true; rm -rf "$D" "/tmp/qa-delta/$svc"
echo "loaded $image into the kind nodes (previous tags untouched)"
REMOTE
    echo "roll out (deliberately, NOT via kubectl apply of a repo manifest):"
    echo "  kubectl -n whatsapp-commerce set image deploy/$svc $svc=$image   # then: scripts/qa-local-ship.sh check-spread $svc"
    ;;

  server)
    tag="${1:-}"; base="${2:-}"; [ -n "$tag" ] && [ -n "$base" ] || die "usage: server <new-tag> <base-tag> --expect <text> ..."; shift 2; parse_flags "$@"
    tag_ok "$tag"; tag_ok "$base"; [ ${#expects[@]} -gt 0 ] || die "give at least one --expect"
    image="$REGISTRY/whatsapp-server:$tag"; baseimg="$REGISTRY/whatsapp-server:$base"
    echo "plan: rebuild $image on $HOST = $baseimg (from the node's containerd) with /app/dist replaced by the dist/ inside the local $image"
    echo "  1. extract /app/dist from the LOCAL image and check it contains: ${expects[*]}${absents[*]:+ and NOT: ${absents[*]}}"
    echo "  2. upload only dist/ (tar.gz), ~4 MB"
    echo "  3. on the host: export the base from kind's containerd (stream, /tmp there is a tmpfs), docker build, verify, kind load, clean up"
    [ "$DRY" = 1 ] && { echo "(dry run: nothing executed)"; exit 0; }
    work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
    docker image inspect "$image" >/dev/null 2>&1 || die "image $image is not built locally"
    cid=$(docker create "$image"); docker cp "$cid:/app/dist" "$work/dist"; docker rm -f "$cid" >/dev/null
    for e in "${expects[@]}"; do grep -rqF -- "$e" "$work/dist" || die "dist does NOT contain '$e' — refusing to ship"; echo "  verified locally: '$e'"; done
    for a in "${absents[@]+"${absents[@]}"}"; do ! grep -rqF -- "$a" "$work/dist" || die "dist STILL contains '$a' — refusing to ship"; echo "  verified locally: '$a' absent"; done
    COPYFILE_DISABLE=1 tar -czf - -C "$work" dist | ssh "$HOST" 'mkdir -p /tmp/qa-delta && rm -rf /tmp/qa-delta/dist && tar -xzf - -C /tmp/qa-delta 2>/dev/null'
    ssh "$HOST" 'bash -s' -- "$image" "$baseimg" "$NODE" "$KIND_CLUSTER" "${expects[@]}" <<'REMOTE'
set -euo pipefail
image="$1"; base="$2"; node="$3"; kc="$4"; shift 4
D=/tmp/qa-delta/ctx-server; mkdir -p "$D"; rm -rf "$D/dist"; cp -r /tmp/qa-delta/dist "$D/dist"
docker exec "$node" ctr -n k8s.io images export /tmp/base-sv.tar "$base"
docker exec "$node" cat /tmp/base-sv.tar | docker load >/dev/null      # NOT `docker cp`: the node's /tmp is a tmpfs
docker exec "$node" rm -f /tmp/base-sv.tar
printf 'FROM %s\nUSER root\nRUN rm -rf /app/dist\nCOPY --chown=node:node dist /app/dist\nUSER node\n' "$base" > "$D/Dockerfile"
docker build -q -t "$image" "$D" >/dev/null
for e in "$@"; do
  h=$(docker run --rm --entrypoint sh "$image" -c 'grep -rlF -- "$1" /app/dist 2>/dev/null | wc -l' _ "$e" | tr -d '[:space:]')
  [ "${h:-0}" -gt 0 ] || { echo "host-built image lacks '$e' — NOT loading"; exit 3; }; echo "  verified on host: '$e'"
done
kind load docker-image "$image" --name "$kc" >/dev/null
docker rmi "$image" "$base" >/dev/null 2>&1 || true; rm -rf /tmp/qa-delta
echo "loaded $image into the kind nodes (previous tags untouched)"
REMOTE
    echo "roll out: kubectl -n whatsapp-commerce set image deploy/server server=$image   # then: scripts/qa-local-ship.sh check-spread server"
    ;;

  *) die "usage: $0 rust|server ..." ;;
esac
