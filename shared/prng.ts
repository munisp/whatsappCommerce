/**
 * shared/prng.ts — deterministic seeded PRNG for SIMULATION code paths.
 *
 * Business logic must never use unseeded Math.random(): it makes runs
 * non-reproducible and tests flaky. Simulation/preview endpoints instead draw
 * from a mulberry32 generator seeded from stable identifiers (campaign id,
 * simulation id, base timestamp) so the same input always yields the same
 * output. Same construction as server/services/banditLimits.ts.
 */

/** Deterministic PRNG (mulberry32). Returns a function producing [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → uint32 seed, so string ids can seed the PRNG. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Convenience: seeded PRNG from a string id. */
export function seededRng(seed: string | number): () => number {
  return mulberry32(typeof seed === "number" ? seed : seedFromString(seed));
}
