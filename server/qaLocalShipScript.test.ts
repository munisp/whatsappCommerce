/**
 * QA-041: scripts/qa-local-ship.sh. Only its REFUSALS and its plan are tested — never a real docker/ssh call. The refusals
 * are the point: each one is a mistake made once in this session (an image that lacked the fix, a mutable tag, a rollback
 * target deleted from the nodes, both replicas on one node).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "scripts", "qa-local-ship.sh");
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const out = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;

describe("ship — refuses before it touches anything", () => {
  it("refuses a missing tag", () => {
    const r = run(["ship", "server"]);
    expect(r.status).toBe(2);
    expect(out(r)).toMatch(/usage: ship/);
  });

  it("refuses 'latest' (a mutable tag is not a rollback target)", () => {
    const r = run(["ship", "server", "latest", "--expect", "x", "--dry-run"]);
    expect(r.status).toBe(2);
    expect(out(r)).toMatch(/refusing the tag 'latest'/);
  });

  it.each(["v1", "20260921-1200", "qa-local", "qa-localx", "qa-local1-old"])("refuses a tag that is not qa-local<N> (%s) — the resume gate recognises hand-shipped images by that name", (tag) => {
    const r = run(["ship", "server", tag, "--expect", "x", "--dry-run"]);
    expect(r.status).toBe(2);
    expect(out(r)).toMatch(/tag must look like qa-local<N>/);
  });

  it("refuses to ship without an --expect: 'the commit has the fix' is not evidence that the image does (QA-037)", () => {
    const r = run(["ship", "server", "qa-local9", "--dry-run"]);
    expect(r.status).toBe(2);
    expect(out(r)).toMatch(/at least one --expect/);
  });

  it.each(["Server", "ser ver", "../x", "a;b", ""])("refuses a suspicious service name (%j)", (svc) => {
    const r = run(["ship", svc, "qa-local9", "--expect", "x", "--dry-run"]);
    expect(r.status).toBe(2);
  });

  it("refuses an unknown argument rather than ignoring it", () => {
    const r = run(["ship", "server", "qa-local9", "--expect", "x", "--force"]);
    expect(r.status).toBe(2);
    expect(out(r)).toMatch(/unknown argument: --force/);
  });
});

describe("ship — the plan it prints", () => {
  const r = run(["ship", "server", "qa-local9", "--expect", "NewSymbolA", "--expect", "NewSymbolB", "--dry-run"]);
  const text = out(r);

  it("succeeds in dry-run mode and executes nothing", () => {
    expect(r.status).toBe(0);
    expect(text).toMatch(/dry run: nothing executed/);
  });

  it("verifies the artifact BEFORE it ships anything, and lists what it will look for", () => {
    expect(text.indexOf("verify the artifact")).toBeGreaterThan(-1);
    expect(text.indexOf("verify the artifact")).toBeLessThan(text.indexOf("docker save"));
    expect(text).toMatch(/NewSymbolA NewSymbolB/);
  });

  it("KEEPS the previous tag on the nodes and only removes the host's transfer copy", () => {
    expect(text).toMatch(/KEEP the previous tag/);
    expect(text).toMatch(/remove ONLY the host's transfer copy/);
  });

  it("names the full registry image it will ship", () => {
    expect(text).toContain("registry.digitalocean.com/talentgraph-auth/whatsapp-server:qa-local9");
  });
});

describe("check-spread — fails when every replica shares a node", () => {
  // A stub `kubectl` on PATH stands in for the cluster, so this is deterministic and needs no cluster.
  const stub = (nodes: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "stubkubectl-"));
    writeFileSync(join(dir, "kubectl"), `#!/bin/bash\nprintf '%s\\n' ${nodes.map((n) => `'${n}'`).join(" ")}\n`);
    chmodSync(join(dir, "kubectl"), 0o755);
    return { PATH: `${dir}:${process.env.PATH}` };
  };

  it("passes when the replicas are on different nodes", () => {
    const r = run(["check-spread", "server"], stub(["worker", "worker2"]));
    expect(r.status).toBe(0);
    expect(out(r)).toMatch(/2 running pod\(s\) on 2 node\(s\)/);
  });

  it("FAILS, and says how to fix it, when both replicas are on one node", () => {
    const r = run(["check-spread", "server"], stub(["worker", "worker"]));
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/CO-LOCATED/);
    expect(out(r)).toMatch(/delete pod/);
  });

  it("does not fail a single-replica deployment (nothing to spread)", () => {
    const r = run(["check-spread", "recon-worker"], stub(["worker"]));
    expect(r.status).toBe(0);
  });

  it("refuses without a deployment name", () => {
    expect(run(["check-spread"]).status).toBe(2);
  });
});

// The REAL flow, with docker/ssh/kubectl/gzip replaced by stubs that log every invocation. This is what catches the things a
// dry-run's printed text cannot: what is actually executed, and in what order.
describe("ship — the executed flow (stubbed docker/ssh/kubectl)", () => {
  function rig(verifyHits: number, extraArgs: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "shiprig-"));
    const log = join(dir, "calls.log");
    const stub = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
    stub("docker", `echo "docker $*" >> "${log}"
case "$1" in
  image) exit 0 ;;
  run) echo ${verifyHits} ;;          # the in-image grep, reduced to a hit count by the script
  save) echo image-bytes ;;
esac`);
    stub("gzip", "cat");
    stub("ssh", `echo "ssh $*" >> "${log}"; cat > /dev/null`);
    stub("kubectl", 'echo "whatsapp-server:qa-local8"');
    const r = spawnSync("bash", [SCRIPT, "ship", "server", "qa-local9", "--expect", "NewSymbolA", ...extraArgs], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    let calls: string[] = [];
    try { calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch { /* nothing was called */ }
    return { r, calls };
  }

  it("verifies inside the image FIRST, then ships, then loads it into kind", () => {
    const { r, calls } = rig(2);
    expect(r.status, out(r)).toBe(0);
    const idx = (needle: string) => calls.findIndex((c) => c.includes(needle));
    expect(idx("docker run")).toBeGreaterThan(-1);
    expect(idx("docker run")).toBeLessThan(idx("docker save"));
    expect(idx("docker save")).toBeLessThan(idx("kind load docker-image"));
  });

  it("REFUSES, and ships NOTHING, when the image does not contain the expected code (QA-037)", () => {
    const { r, calls } = rig(0);
    expect(r.status).toBe(2);
    expect(out(r)).toMatch(/does NOT contain 'NewSymbolA'/);
    expect(calls.some((c) => c.startsWith("docker save")), "must not save/stream an unverified image").toBe(false);
    expect(calls.some((c) => c.startsWith("ssh")), "must not touch the host").toBe(false);
  });

  it("--absent REFUSES, and ships nothing, when code that was supposed to be removed is still in the image", () => {
    const { r, calls } = rig(2, ["--absent", "RemovedSymbol"]); // the stub reports 2 hits for every search, so 'absent' must fail
    expect(r.status).toBe(2);
    expect(out(r)).toMatch(/STILL contains 'RemovedSymbol'/);
    expect(calls.some((c) => c.startsWith("docker save"))).toBe(false);
  });

  it("removes ONLY the transfer copy on the host and never deletes any tag from the nodes (the rollback target must survive)", () => {
    const { calls } = rig(1);
    const ssh = calls.filter((c) => c.startsWith("ssh")).join("\n");
    expect(ssh).not.toMatch(/crictl/);
    expect(ssh).not.toMatch(/ctr\b.*rm|images (rm|delete)/);
    const rmi = ssh.match(/docker rmi [^\n]*/g) ?? [];
    expect(rmi).toHaveLength(1);
    expect(rmi[0]).toContain("whatsapp-server:qa-local9"); // the copy it just transferred, and nothing else
    expect(ssh).not.toMatch(/qa-local8/); // the previous live tag is never named in a command that could remove it
  });

  it("says the previous tag is kept, prints the rollout command, and does not run it", () => {
    const { r, calls } = rig(1);
    expect(out(r)).toMatch(/previous tag stays on the nodes/);
    expect(out(r)).toMatch(/kubectl .* set image deploy\/server server=.*qa-local9/);
    expect(calls.some((c) => /set image|apply|patch|rollout/.test(c)), "the script itself must not change the Deployment").toBe(false);
  });
});

// scripts/qa-local-delta-ship.sh — only its refusals and its plan are tested; it has not been run end to end (see its header).
describe("delta ship — refusals and plan", () => {
  const DELTA = join(__dirname, "..", "scripts", "qa-local-delta-ship.sh");
  const drun = (args: string[]) => spawnSync("bash", [DELTA, ...args], { encoding: "utf8" });
  const dout = (r: ReturnType<typeof drun>) => `${r.stdout}${r.stderr}`;

  it.each([
    [["rust", "ledger-bridge", "latest", "--expect", "x", "--dry-run"], /refusing 'latest'|tag must look like/],
    [["rust", "ledger-bridge", "v9", "--expect", "x", "--dry-run"], /tag must look like qa-local<N>/],
    [["rust", "ledger-bridge", "qa-local9", "--dry-run"], /at least one --expect/],
    [["rust", "event-processor", "qa-local9", "--expect", "x", "--dry-run"], /must be ledger-bridge or recon-worker/],
    [["server", "qa-local9", "latest", "--expect", "x", "--dry-run"], /refusing 'latest'|tag must look like/],
    [["rust", "ledger-bridge", "qa-local9", "--expect", "x", "--bogus"], /unknown argument: --bogus/],
    [["nonsense"], /usage:/],
  ])("refuses %j", (args, why) => {
    const r = drun(args as string[]);
    expect(r.status).toBe(2);
    expect(dout(r)).toMatch(why as RegExp);
  });

  it("prints a plan that verifies locally BEFORE uploading, and executes nothing in dry-run", () => {
    const r = drun(["rust", "recon-worker", "qa-local9", "--expect", "NewSymbol", "--dry-run"]);
    expect(r.status).toBe(0);
    const text = dout(r);
    expect(text.indexOf("extract /recon-worker from the LOCAL image")).toBeLessThan(text.indexOf("upload only that binary"));
    expect(text).toMatch(/dry run: nothing executed/);
  });

  it("the server plan says it exports the base from the node (no network) and names the tmpfs trap", () => {
    const r = drun(["server", "qa-local9", "qa-local7", "--expect", "NewSymbol", "--absent", "OldSymbol", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(dout(r)).toMatch(/tmpfs/);
    expect(dout(r)).toMatch(/NOT: OldSymbol/);
  });
});
