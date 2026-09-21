#!/usr/bin/env bash
# QA-041: ship a locally-built image to the dev cluster's nodes, the way this session learned to do it — and refuse the
# ways it went wrong. Two subcommands:
#
#   scripts/qa-local-ship.sh ship <service> <tag> --expect <text> [--expect <text> ...] [--absent <text> ...] [--path <dir-or-file>] [--dry-run]
#   scripts/qa-local-ship.sh check-spread <deployment>
#
# `ship` (1) REFUSES an image that does not contain the code you think it does (QA-037: the source had the fix, the image
# did not, and I reported it deployed) — and, with --absent, one that still contains code you REMOVED (a stale layer or a
# cached build would ship it), (2) streams it to the cluster host compressed (the link is ~0.5 MB/s), (3) loads it
# into the kind nodes, (4) removes only the transfer copy on the host — it NEVER deletes a tag from the nodes, so the
# previous version stays available for a rollback (a `kubectl rollout undo` needs the old image present, and with
# imagePullPolicy: Never nothing can fetch it). It prints, and does not run, the command that rolls the Deployment: the
# rollout stays a deliberate step. NEVER `kubectl apply` a repo manifest to do it — the repo pins registry tags and would
# revert the image; use `kubectl set image` or a targeted JSON patch.
#
# `check-spread` fails when all pods of a Deployment sit on one node (a soft topology spread on two ~97%-requested
# workers has silently co-located both replicas after rollouts more than once).
set -euo pipefail

REGISTRY="${REGISTRY:-registry.digitalocean.com/talentgraph-auth}"
HOST="${SHIP_HOST:-newwaveclaw@america}"
KIND_CLUSTER="${KIND_CLUSTER:-newwave-dev}"
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-newwave-dev}"
NS="${NS:-whatsapp-commerce}"

die() { echo "error: $*" >&2; exit 2; }

cmd="${1:-}"; shift || true
case "$cmd" in
  ship)
    service="${1:-}"; tag="${2:-}"; [ -n "$service" ] && [ -n "$tag" ] || die "usage: ship <service> <tag> --expect <text> [...] [--path <p>] [--dry-run]"
    shift 2
    expects=(); absents=(); path="/app"; dry=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --expect) [ $# -ge 2 ] || die "--expect needs a value"; expects+=("$2"); shift 2 ;;
        --absent) [ $# -ge 2 ] || die "--absent needs a value"; absents+=("$2"); shift 2 ;;
        --path)   [ $# -ge 2 ] || die "--path needs a value"; path="$2"; shift 2 ;;
        --dry-run) dry=1; shift ;;
        *) die "unknown argument: $1" ;;
      esac
    done
    [[ "$service" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "service must be lowercase letters, digits and dashes: '$service'"
    [ "$tag" != "latest" ] || die "refusing the tag 'latest': a mutable tag is the opposite of a rollback target"
    [[ "$tag" =~ ^qa-local[0-9]+$ ]] || die "tag must look like qa-local<N> (got '$tag'): scripts/fluxResumePreflight.ts recognises hand-shipped images by that name"
    [ ${#expects[@]} -gt 0 ] || die "give at least one --expect <text> that ONLY the new code contains; 'the commit has the fix' is not evidence that the IMAGE does"
    image="$REGISTRY/whatsapp-$service:$tag"

    echo "plan: $image"
    echo "  1. verify the artifact contains: ${expects[*]}${absents[*]:+ and does NOT contain: ${absents[*]}}   (searching $path inside the image)"
    echo "  2. docker save | gzip -1 | ssh $HOST 'gunzip | docker load'"
    echo "  3. ssh $HOST kind load docker-image $image --name $KIND_CLUSTER; then remove ONLY the host's transfer copy"
    echo "  4. KEEP the previous tag on the nodes (rollback target); print the rollout command, do not run it"
    if [ "$dry" = 1 ]; then echo "(dry run: nothing executed)"; exit 0; fi

    docker image inspect "$image" >/dev/null 2>&1 || die "image $image is not built locally"
    for e in "${expects[@]}"; do
      hits=$(docker run --rm --entrypoint sh "$image" -c "grep -rlF -- \"\$1\" \"\$2\" 2>/dev/null | wc -l" _ "$e" "$path" | tr -d '[:space:]')
      [ "${hits:-0}" -gt 0 ] || die "the image does NOT contain '$e' under $path — refusing to ship an artifact that lacks the change"
      echo "  verified: '$e' found in $hits file(s)"
    done
    for a in "${absents[@]+"${absents[@]}"}"; do
      hits=$(docker run --rm --entrypoint sh "$image" -c "grep -rlF -- \"\$1\" \"\$2\" 2>/dev/null | wc -l" _ "$a" "$path" | tr -d '[:space:]')
      [ "${hits:-0}" -eq 0 ] || die "the image STILL contains '$a' ($hits file(s) under $path) — code that was removed is in the artifact; refusing to ship"
      echo "  verified: '$a' is absent"
    done
    docker save "$image" | gzip -1 | ssh "$HOST" 'gunzip | docker load'
    ssh "$HOST" "kind load docker-image '$image' --name '$KIND_CLUSTER' && docker rmi '$image' >/dev/null"
    current=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get deploy "$service" -o jsonpath='{.spec.template.spec.containers[*].image}' 2>/dev/null || true)
    echo "shipped. currently running: ${current:-unknown}. That previous tag stays on the nodes (rollback target)."
    echo "roll out (deliberately, and NOT via kubectl apply of a repo manifest):"
    echo "  kubectl --context $KUBE_CONTEXT -n $NS set image deploy/$service $service=$image"
    echo "  kubectl --context $KUBE_CONTEXT -n $NS rollout status deploy/$service"
    echo "  scripts/qa-local-ship.sh check-spread $service"
    ;;

  check-spread)
    dep="${1:-}"; [ -n "$dep" ] || die "usage: check-spread <deployment>"
    nodes=$(kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods -l "app.kubernetes.io/name=$dep" --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}')
    total=$(printf '%s\n' "$nodes" | grep -c . || true)
    distinct=$(printf '%s\n' "$nodes" | sort -u | grep -c . || true)
    echo "$dep: $total running pod(s) on $distinct node(s)"; printf '%s\n' "$nodes" | sort | uniq -c | sed 's/^/  /'
    if [ "$total" -gt 1 ] && [ "$distinct" -le 1 ]; then
      echo "CO-LOCATED: every replica is on one node — a single node loss is a full outage." >&2
      echo "fix: kubectl --context $KUBE_CONTEXT -n $NS delete pod <one-of-them>   (it reschedules onto the other node)" >&2
      exit 1
    fi
    ;;

  *) die "usage: $0 ship|check-spread ..." ;;
esac
