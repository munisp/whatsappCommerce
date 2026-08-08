#!/usr/bin/env node
/**
 * scripts/perf/mini-redis.mjs — minimal in-memory RESP (Redis protocol) shim
 * for local tests and load runs where a real Redis is unavailable.
 *
 * Supports the subset the platform needs (server/redis.ts -> ioredis):
 *   PING, ECHO, INFO, COMMAND, AUTH, SELECT, INCR, EXPIRE, GET, SET, SETEX,
 *   DEL, TTL, QUIT
 * Expiry is enforced lazily on access (plus a periodic sweep).
 *
 * Usage:
 *   node scripts/perf/mini-redis.mjs [--port 6379]
 *   REDIS_URL=redis://localhost:6379 NODE_ENV=test npx tsx server/_core/index.ts
 */
import net from "node:net";

const port = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 6379;
})();

/** key -> { value: string, expiresAt: number|null } */
const store = new Map();

function expired(entry) {
  return entry.expiresAt !== null && entry.expiresAt <= Date.now();
}

function getEntry(key) {
  const e = store.get(key);
  if (!e) return null;
  if (expired(e)) { store.delete(key); return null; }
  return e;
}

// Periodic sweep so expired keys don't linger.
setInterval(() => {
  for (const [k, e] of store) if (expired(e)) store.delete(k);
}, 5000).unref();

// ─── RESP encoding helpers ──────────────────────────────────────────────────
const simple = (s) => `+${s}\r\n`;
const err = (s) => `-${s}\r\n`;
const int = (n) => `:${n}\r\n`;
const bulk = (s) => (s === null ? "$-1\r\n" : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);
const array = (items) => `*${items.length}\r\n${items.join("")}`;

function execute(cmd, args) {
  switch (cmd) {
    case "PING": return args.length ? bulk(args[0]) : simple("PONG");
    case "ECHO": return bulk(args[0] ?? "");
    case "QUIT": return simple("OK");
    case "AUTH": return simple("OK");
    case "SELECT": return simple("OK");
    case "COMMAND": return array([]);
    case "INFO":
      return bulk(`# Server\r\nredis_version:7.0.0-mini\r\nconnected_clients:1\r\ndb0:keys=${store.size}\r\n`);
    case "INCR": {
      const key = args[0];
      const e = getEntry(key);
      const next = (e ? parseInt(e.value, 10) || 0 : 0) + 1;
      store.set(key, { value: String(next), expiresAt: e ? e.expiresAt : null });
      return int(next);
    }
    case "EXPIRE": {
      const e = getEntry(args[0]);
      if (!e) return int(0);
      e.expiresAt = Date.now() + parseInt(args[1], 10) * 1000;
      return int(1);
    }
    case "GET": {
      const e = getEntry(args[0]);
      return bulk(e ? e.value : null);
    }
    case "SET": {
      const key = args[0];
      const entry = { value: args[1], expiresAt: null };
      // handle SET k v EX seconds
      for (let i = 2; i + 1 < args.length + 1; i += 2) {
        if ((args[i] ?? "").toUpperCase() === "EX") entry.expiresAt = Date.now() + parseInt(args[i + 1], 10) * 1000;
        if ((args[i] ?? "").toUpperCase() === "PX") entry.expiresAt = Date.now() + parseInt(args[i + 1], 10);
      }
      store.set(key, entry);
      return simple("OK");
    }
    case "SETEX": {
      store.set(args[0], { value: args[2], expiresAt: Date.now() + parseInt(args[1], 10) * 1000 });
      return simple("OK");
    }
    case "DEL": {
      let n = 0;
      for (const k of args) if (getEntry(k)) { store.delete(k); n++; }
      return int(n);
    }
    case "TTL": {
      const e = getEntry(args[0]);
      if (!e) return int(-2);
      if (e.expiresAt === null) return int(-1);
      return int(Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000)));
    }
    default:
      return err(`ERR unknown command '${cmd}'`);
  }
}

function handleConnection(socket) {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Parse complete RESP arrays from the buffer.
    for (;;) {
      const parsed = parseCommand(buffer);
      if (!parsed) break; // need more data
      const [argv, rest] = parsed;
      buffer = rest;
      const cmd = argv[0]?.toUpperCase() ?? "";
      const reply = execute(cmd, argv.slice(1));
      socket.write(reply);
      if (cmd === "QUIT") socket.end();
    }
  });
  socket.on("error", () => socket.destroy());
}

/** Parse one RESP array of bulk/simple strings. Returns [args, rest] or null. */
function parseCommand(buf) {
  if (buf.length === 0) return null;
  // Inline command (e.g. "PING\r\n") — some clients use this.
  if (buf[0] !== 0x2a /* * */) {
    const nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    const line = buf.subarray(0, nl).toString().trim().split(/\s+/).filter(Boolean);
    return [line, buf.subarray(nl + 2)];
  }
  const nl = buf.indexOf("\r\n");
  if (nl < 0) return null;
  const count = parseInt(buf.subarray(1, nl).toString(), 10);
  if (!Number.isFinite(count)) return null;
  let offset = nl + 2;
  const args = [];
  for (let i = 0; i < count; i++) {
    if (offset >= buf.length) return null;
    if (buf[offset] !== 0x24 /* $ */) return null;
    const eol = buf.indexOf("\r\n", offset);
    if (eol < 0) return null;
    const len = parseInt(buf.subarray(offset + 1, eol).toString(), 10);
    const start = eol + 2;
    if (start + len + 2 > buf.length) return null;
    args.push(buf.subarray(start, start + len).toString());
    offset = start + len + 2;
  }
  return [args, buf.subarray(offset)];
}

const server = net.createServer(handleConnection);
server.listen(port, () => {
  console.log(`[mini-redis] RESP shim listening on 127.0.0.1:${port} (INCR/EXPIRE/GET/SET/...)`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
