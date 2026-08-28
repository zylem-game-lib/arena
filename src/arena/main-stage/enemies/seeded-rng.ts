/**
 * Deterministic randomness for the client-local enemy simulation.
 *
 * Enemies are never stored on the server: every client spawns and drives
 * them locally. To keep the simulation visually identical across peers,
 * all AI randomness (spawn phase, attack jitter, wander targets, …) is
 * drawn from per-enemy PRNG streams seeded from values every client can
 * derive independently — the wave counter + spawn slot for wave enemies,
 * and the STDB player entity id for the per-player guest iguano.
 */

/** Small deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Mix an arbitrary list of 32-bit integers into a single seed (FNV-1a style). */
export function hashSeed(...parts: number[]): number {
	let h = 0x811c9dc5;
	for (const part of parts) {
		h ^= part >>> 0;
		h = Math.imul(h, 0x01000193);
		h ^= h >>> 15;
	}
	return h >>> 0;
}

/** Salt so arena enemy streams don't collide with other seeded systems. */
const ENEMY_SEED_BASE = 0x1904a7;

/** Extra salt distinguishing guest-iguano streams from wave streams. */
const GUEST_SEED_SALT = 0x9e37;

/**
 * RNG stream for a wave enemy. `waveIndex` is the 1-based local wave
 * counter and `slotIndex` the enemy's position in the wave order; both
 * advance identically on every client.
 */
export function createWaveEnemyRng(
	waveIndex: number,
	slotIndex: number,
): () => number {
	return mulberry32(hashSeed(ENEMY_SEED_BASE, waveIndex, slotIndex));
}

/**
 * RNG stream for the guest iguano spawned when a player joins. Keyed off
 * the player's server-assigned entity id, which every client observes.
 */
export function createGuestEnemyRng(playerEntityId: bigint): () => number {
	const lo = Number(playerEntityId & 0xffffffffn);
	const hi = Number((playerEntityId >> 32n) & 0xffffffffn);
	return mulberry32(hashSeed(ENEMY_SEED_BASE, GUEST_SEED_SALT, lo, hi));
}
