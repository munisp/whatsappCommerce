/**
 * Customer accounts for one store. Not the staff login: separate table, separate cookie, and the token is
 * bound to the store's tenant, so signing in at one shop means nothing at another.
 */
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { storeAccounts, storePasswordResets, type StoreAccount } from "../../../drizzle/schema";
import { getSessionCookieOptions } from "../../_core/cookies";
import { ENV } from "../../_core/env";
import type { Db } from "./store";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 30;
const RESET_MINUTES = 60;

/** Per-store cookie name, so two shops open in one browser don't overwrite each other. */
export function storeCookieName(tenantId: string): string {
  return `wa_store_${createHash("sha256").update(tenantId).digest("hex").slice(0, 12)}`;
}

function secret() {
  if (!ENV.cookieSecret) throw new Error("Session secret is not configured");
  return new TextEncoder().encode(`store-account:${ENV.cookieSecret}`);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(derived, expected);
}

/** Compared against when the email is unknown, so a missing account takes as long as a wrong password. */
const DUMMY_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;

export async function issueSession(res: Response, req: Request, tenantId: string, accountId: string) {
  const token = await new SignJWT({ sub: accountId, tid: tenantId })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(`store:${tenantId}`)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
  res.cookie(storeCookieName(tenantId), token, { ...getSessionCookieOptions(req), maxAge: SESSION_DAYS * 86_400_000 });
}

export function clearSession(res: Response, req: Request, tenantId: string) {
  res.clearCookie(storeCookieName(tenantId), { ...getSessionCookieOptions(req), maxAge: -1 });
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The signed-in customer of this store, or null. Requires the token's audience and the row's tenant to match. */
export async function currentAccount(db: Db, req: Request, tenantId: string): Promise<StoreAccount | null> {
  const token = readCookie(req, storeCookieName(tenantId));
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: `store:${tenantId}`, algorithms: ["HS256"] });
    if (payload.tid !== tenantId || typeof payload.sub !== "string") return null;
    const [account] = await db.select().from(storeAccounts)
      .where(and(eq(storeAccounts.id, payload.sub), eq(storeAccounts.tenantId, tenantId))).limit(1);
    return account ?? null;
  } catch {
    return null;
  }
}

export const findByEmail = async (db: Db, tenantId: string, email: string) => {
  const [row] = await db.select().from(storeAccounts)
    .where(and(eq(storeAccounts.tenantId, tenantId), sql`lower(${storeAccounts.email}) = ${email.trim().toLowerCase()}`)).limit(1);
  return row ?? null;
};

export async function authenticate(db: Db, tenantId: string, email: string, password: string): Promise<StoreAccount | null> {
  const account = await findByEmail(db, tenantId, email);
  const ok = await verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);
  return account && ok ? account : null;
}

export async function createAccount(db: Db, tenantId: string, input: { email: string; name: string; phone?: string | null; password: string; marketingOptIn?: boolean }) {
  const id = randomUUID();
  await db.insert(storeAccounts).values({
    id, tenantId, email: input.email.trim().toLowerCase(), name: input.name.trim(), phone: input.phone?.trim() || null,
    passwordHash: await hashPassword(input.password), marketingOptIn: input.marketingOptIn === true,
  });
  return id;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createPasswordReset(db: Db, tenantId: string, accountId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(storePasswordResets).values({
    tokenHash: hashToken(token), tenantId, accountId, expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000),
  });
  return token;
}

/** Single use, expiring, and only valid at the store that issued it. */
export async function consumePasswordReset(db: Db, tenantId: string, token: string, newPassword: string): Promise<boolean> {
  const passwordHash = await hashPassword(newPassword);
  const [claimed] = await db.update(storePasswordResets).set({ usedAt: new Date() })
    .where(and(
      eq(storePasswordResets.tokenHash, hashToken(token)),
      eq(storePasswordResets.tenantId, tenantId),
      isNull(storePasswordResets.usedAt),
      gt(storePasswordResets.expiresAt, new Date()),
    )).returning({ accountId: storePasswordResets.accountId });
  if (!claimed) return false;
  await db.update(storeAccounts).set({ passwordHash, updatedAt: new Date() })
    .where(and(eq(storeAccounts.id, claimed.accountId), eq(storeAccounts.tenantId, tenantId)));
  return true;
}
