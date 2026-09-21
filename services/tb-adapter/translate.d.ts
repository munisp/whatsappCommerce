export class HttpError extends Error {
  constructor(status: number, code: string, message?: string);
  status: number;
  code: string;
}
export const U128_MAX: bigint;
export const AMOUNT_MAX: bigint;
export const TB: Readonly<{ PENDING: number; POST_PENDING: number; VOID_PENDING: number }>;
export const BRIDGE: Readonly<{ POSTED: number; PENDING: number; POST_PENDING: number; VOID_PENDING: number }>;
export function parseId(raw: unknown, label?: string): bigint;
export function parseAmount(raw: unknown, label?: string): bigint;
export interface TbTransfer {
  id: bigint; debit_account_id: bigint; credit_account_id: bigint; amount: bigint; pending_id: bigint;
  user_data_128: bigint; user_data_64: bigint; user_data_32: number; timeout: number; ledger: number; code: number;
  flags: number; timestamp: bigint;
}
export function toTbTransfer(t: unknown): { transfer: TbTransfer; kind: "pending" | "posted" | "post" | "void" };
export function toTbAccount(a: unknown): Record<string, bigint | number>;
export function classifyResult(name: string): { kind: "ok" | "exists" | "missing_account" | "not_found" | "conflict" | "invalid"; status: number };
export function balanceNumber(v: bigint, label: string): number;
