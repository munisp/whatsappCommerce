#!/usr/bin/env python3
# === W54 CILIUM ===
"""Static YAML/schema sanity for k8s/base and k8s/cilium. No cluster needed."""
import sys, glob, os

try:
    import yaml
except ImportError:
    sys.exit("pyyaml required (pip install pyyaml)")

KNOWN_KINDS = {
    ("v1", "Namespace"), ("v1", "Service"), ("v1", "PersistentVolumeClaim"),
    ("v1", "ConfigMap"), ("apps/v1", "Deployment"), ("apps/v1", "StatefulSet"),
    ("cilium.io/v2", "CiliumNetworkPolicy"),
    ("cilium.io/v2", "CiliumClusterwideNetworkPolicy"),
    ("cilium.io/v2alpha1", "CiliumL2AnnouncementPolicy"),
    ("cilium.io/v2alpha1", "CiliumLoadBalancerIPPool"),
    ("external-secrets.io/v1beta1", "ExternalSecret"),
}
CNP_SPEC_FIELDS = {"endpointSelector", "ingress", "egress", "description", "nodeSelector", "ingressDeny", "egressDeny"}
RULE_FIELDS = {"fromEndpoints", "toEndpoints", "fromEntities", "toEntities",
               "toPorts", "toFQDNs", "toCIDR", "fromCIDR", "fromRequires", "toRequires", "icmps"}
TOPORTS_FIELDS = {"ports", "rules", "terminatingTLS", "originatingTLS", "serverNames", "listener"}
FQDN_FIELDS = {"matchName", "matchPattern"}

errors = []
def err(f, msg): errors.append(f"{f}: {msg}")

def check_cnp(path, doc):
    spec = doc.get("spec")
    if not isinstance(spec, dict):
        return err(path, f"{doc.get('metadata',{}).get('name')}: missing spec")
    for k in spec:
        if k not in CNP_SPEC_FIELDS:
            err(path, f"CNP {doc['metadata']['name']}: unknown spec field '{k}'")
    for direction in ("ingress", "egress"):
        rules = spec.get(direction) or []
        if not isinstance(rules, list):
            err(path, f"CNP {doc['metadata']['name']}: {direction} not a list"); continue
        for r in rules:
            for k in r:
                if k not in RULE_FIELDS:
                    err(path, f"CNP {doc['metadata']['name']}: {direction} unknown rule field '{k}'")
            for tp in r.get("toPorts") or []:
                for k in tp:
                    if k not in TOPORTS_FIELDS:
                        err(path, f"CNP {doc['metadata']['name']}: toPorts unknown field '{k}'")
                for p in tp.get("ports") or []:
                    if "port" not in p or "protocol" not in p:
                        err(path, f"CNP {doc['metadata']['name']}: toPorts port entry missing port/protocol")
                http_rules = (tp.get("rules") or {}).get("http") or []
                for h in http_rules:
                    if not any(k in h for k in ("method", "path", "host", "headers")):
                        err(path, f"CNP {doc['metadata']['name']}: http rule without method/path/headers")
            for fq in r.get("toFQDNs") or []:
                for k in fq:
                    if k not in FQDN_FIELDS:
                        err(path, f"CNP {doc['metadata']['name']}: toFQDNs unknown field '{k}'")

def check_deploy(path, doc):
    name = doc["metadata"]["name"]
    spec = doc.get("spec", {}).get("template", {}).get("spec", {})
    for c in spec.get("containers", []):
        res = c.get("resources") or {}
        if not (res.get("requests") and res.get("limits")):
            err(path, f"{name}/{c.get('name')}: missing resources requests/limits")
        sc = c.get("securityContext") or {}
        if sc.get("runAsNonRoot") is not True:
            err(path, f"{name}/{c.get('name')}: securityContext.runAsNonRoot != true")

files = sorted(glob.glob("k8s/base/*.yaml") + glob.glob("k8s/cilium/*.yaml"))
if not files:
    sys.exit("no files found (run from repo root)")
ndocs = 0
for f in files:
    try:
        docs = [d for d in yaml.safe_load_all(open(f)) if d]
    except yaml.YAMLError as e:
        err(f, f"YAML parse error: {e}"); continue
    if not docs:
        err(f, "no documents"); continue
    for d in docs:
        ndocs += 1
        for field in ("apiVersion", "kind", "metadata"):
            if field not in d:
                err(f, f"doc missing required field '{field}'"); break
        else:
            if not d["metadata"].get("name"):
                err(f, f"{d['kind']}: metadata.name missing")
            if (d["apiVersion"], d["kind"]) not in KNOWN_KINDS:
                err(f, f"unknown apiVersion/kind {d['apiVersion']}/{d['kind']}")
            if d["kind"] in ("CiliumNetworkPolicy", "CiliumClusterwideNetworkPolicy"):
                check_cnp(f, d)
            if d["kind"] == "Deployment":
                check_deploy(f, d)

print(f"checked {len(files)} files, {ndocs} documents")
if errors:
    print(f"\n{len(errors)} ERROR(S):")
    for e in errors: print(" -", e)
    sys.exit(1)
print("ALL CHECKS PASSED")
