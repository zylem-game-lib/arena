/// <reference types="@zylem/assets" />

import { Vector3 } from 'three';
import { type UpdateContext } from '@zylem/game-lib/core';
import type { ArenaDbConnection } from '../../networking/arena-stdb-client';
import type {
	ArenaMainStageHandle,
	AvatarRecord,
} from '../main-stage';
import type { ReportAttackHit } from '../combat-controller';
import { createIguanoEnemyActor } from '../../characters/iguano-enemy';
import {
	spawnParticleBurst,
	type StageAddTarget,
} from '../../characters/attack-effects';
import {
	avatarWorldPosition,
	IGUANO_FOOT_OFFSET,
	type BehaviorEnv,
	type EnemyActorEntity,
	type EnemyEntry,
	type NearestAvatar,
} from './shared';
import { createGuestEnemyRng, createWaveEnemyRng } from './seeded-rng';
import {
	clearProjectiles,
	spawnLobProjectile,
	updateProjectiles,
	type ProjectileList,
} from './projectiles';
import {
	clearMines,
	spawnProximityMineAt,
	updateProximityMines,
	type MineList,
} from './mines';
import {
	ALL_IGUANO_KINDS,
	IGUANO_BEHAVIORS,
	KIND_MAX_HP,
	type IguanoKind,
} from './kinds';

const WAVE_KIND_ORDER: readonly IguanoKind[] = ALL_IGUANO_KINDS;
const ENEMIES_PER_WAVE = WAVE_KIND_ORDER.length;
const WAVE_RESPAWN_DELAY = 3;

/**
 * Poll cadence (seconds) for bootstrapping the shared wave counter when
 * the `arena_wave` singleton hasn't arrived yet (fresh database or the
 * initial subscription is still in flight).
 */
const WAVE_INIT_POLL_INTERVAL = 2;

/** Deterministic registry key for a wave enemy. Identical on all clients. */
function waveEnemyKey(waveIndex: number, slotIndex: number): string {
	return `wave:${waveIndex}:${slotIndex}`;
}

/** Deterministic registry key for a per-player guest iguano. */
function guestEnemyKey(playerEntityId: bigint): string {
	return `guest:${playerEntityId}`;
}

/**
 * Per-shooter projectile tuning. Lives here (rather than in `kinds/shooter.ts`)
 * because the orchestrator owns the projectile pool / stage handle and just
 * forwards the spawn call into the behaviour `env`.
 */
const LOB_TUNING = {
	horizSpeed: 11,
	upBias: 7,
	gravity: -28,
	lifetime: 9,
	damage: 7,
	hitRadius: 1.05,
} as const;

/** Per-planter mine tuning. Same rationale as `LOB_TUNING`. */
const MINE_TUNING = {
	armDelay: 0.55,
	lifetime: 28,
	triggerRadius: 1.5,
	damage: 22,
	visualRadius: 0.42,
} as const;

/** Compass ring radius for the wave-spawn anchor layout. */
const WAVE_RING_RADIUS = 14;

/**
 * Anchor candidates around the bowl: 8 evenly-spaced compass points at
 * `WAVE_RING_RADIUS`, starting at +X (East) and going counter-clockwise.
 * `y` is sampled from the heightfield at spawn time — these literals are
 * just the planar XZ ring.
 */
const ENEMY_ANCHORS_XZ: ReadonlyArray<{ x: number; z: number }> =
	Array.from({ length: 8 }, (_, i) => {
		const angle = (i / 8) * Math.PI * 2;
		return {
			x: Math.cos(angle) * WAVE_RING_RADIUS,
			z: Math.sin(angle) * WAVE_RING_RADIUS,
		};
	});

export interface CreateEnemiesOptions {
	handle: ArenaMainStageHandle;
	conn: ArenaDbConnection;
}

export interface EnemiesHandle {
	attachAvatar(entityId: bigint, record: AvatarRecord): void;
	detachAvatar(entityId: bigint): void;
	resolveAttackHit: ReportAttackHit;
	spawnGuestIguanoForNewPlayer(playerEntityId: bigint): void;
	reset(): void;
}

function moduloPositiveBigint(a: bigint, m: bigint): number {
	const r = ((a % m) + m) % m;
	return Number(r);
}

/**
 * Wire the enemies subsystem into the arena main stage.
 *
 * Enemy simulation (AI, motion, HP) runs locally on every client, seeded
 * deterministically (see `seeded-rng.ts`) so peers see the same spawn
 * layout and motion. The server holds no enemy state beyond a lightweight
 * liveness ledger: the shared `arena_wave` counter keeps wave numbering
 * (and therefore enemy keys + RNG seeds) aligned across clients, and the
 * `enemy_registry` table records which enemies exist / have been killed so
 * a kill on one client despawns the enemy everywhere and late joiners
 * skip already-dead enemies.
 */
export function createEnemies(opts: CreateEnemiesOptions): EnemiesHandle {
	const { handle, conn } = opts;
	const stage = handle.stage;
	const burstStage = stage as unknown as StageAddTarget;
	const sampleGroundHeight = handle.sampleGroundHeight;

	const enemies = new Map<string, EnemyEntry>();
	const avatars = new Map<bigint, AvatarRecord>();
	const projectiles: ProjectileList = [];
	const proximityMines: MineList = [];
	const guestIguanoSpawnedForPlayerEntity = new Set<bigint>();

	/** Wave index this client has spawned locally. 0 = not bootstrapped. */
	let currentWave = 0;
	let waveInitPollTimer = 0;
	let waveRespawnTimer = 0;

	function nearestAvatar(pos: {
		x: number;
		y: number;
		z: number;
	}): NearestAvatar | null {
		let bestId: bigint | null = null;
		let bestDevice = '';
		let bestDistSq = Infinity;
		const bestPos = new Vector3();
		for (const [entityId, av] of avatars) {
			const p = avatarWorldPosition(av);
			if (!p) continue;
			const dx = p.x - pos.x;
			const dy = p.y - pos.y;
			const dz = p.z - pos.z;
			const d = dx * dx + dy * dy + dz * dz;
			if (d < bestDistSq) {
				bestDistSq = d;
				bestId = entityId;
				bestDevice = av.deviceId;
				bestPos.copy(p);
			}
		}
		if (bestId === null) return null;
		return { entityId: bestId, deviceId: bestDevice, pos: bestPos };
	}

	function centroidOfAvatarsXZ(): Vector3 | null {
		let sx = 0;
		let sz = 0;
		let n = 0;
		let yAvg = 0;
		for (const av of avatars.values()) {
			const p = avatarWorldPosition(av);
			if (!p) continue;
			sx += p.x;
			yAvg += p.y;
			sz += p.z;
			n += 1;
		}
		if (!n) return null;
		return new Vector3(sx / n, yAvg / n, sz / n);
	}

	/**
	 * Enemy damage sink: only the local player's client forwards its own
	 * hits to the server. Every peer runs the same sim, so gating on
	 * `isLocal` is what prevents N clients from applying the same hit N
	 * times.
	 */
	function damagePlayer(av: AvatarRecord, amount: number): void {
		if (!av.isLocal) return;
		void conn.reducers.damagePlayer({
			deviceId: av.deviceId,
			amount,
		});
	}

	function removeEnemyEntry(entry: EnemyEntry): void {
		if (!enemies.delete(entry.enemyKey)) return;
		if (stage.wrappedStage && entry.actor.uuid) {
			stage.wrappedStage.removeEntityByUuid(entry.actor.uuid);
		}
	}

	/**
	 * Apply local damage; on death, despawn locally and report the kill to
	 * the registry so every other client (and late joiners) despawn it too.
	 */
	function damageEnemyLocal(entry: EnemyEntry, amount: number): void {
		if (!entry.alive) return;
		entry.hp = Math.max(0, entry.hp - amount);
		if (entry.hp > 0) return;
		entry.alive = false;
		removeEnemyEntry(entry);
		void conn.reducers.reportEnemyKill({ enemyKey: entry.enemyKey });
	}

	function killEnemy(entry: EnemyEntry): void {
		damageEnemyLocal(entry, entry.hp);
	}

	/**
	 * Despawn triggered by a peer's kill arriving through the registry.
	 * No re-report: the row is already dead on the server.
	 */
	function removeKilledByPeer(enemyKey: string): void {
		const entry = enemies.get(enemyKey);
		if (!entry) return;
		entry.alive = false;
		removeEnemyEntry(entry);
	}

	/** True when the registry says this enemy was already killed. */
	function isRegisteredDead(enemyKey: string): boolean {
		const row = conn.db.enemy_registry.enemy_key.find(enemyKey);
		return row != null && !row.alive;
	}

	/** Heightfield-aware Y resolver shared by every behaviour `update`. */
	function groundedY(x: number, z: number): number {
		return sampleGroundHeight(x, z) + IGUANO_FOOT_OFFSET;
	}

	const env: BehaviorEnv = {
		avatars,
		sampleGroundHeight,
		nearestAvatar,
		centroidOfAvatarsXZ,
		burstStage,
		spawnLobProjectile: (from, toward) =>
			spawnLobProjectile(stage, projectiles, from, toward, LOB_TUNING),
		spawnProximityMineAt: (pos) =>
			spawnProximityMineAt(stage, proximityMines, pos, MINE_TUNING),
		killEnemy,
		damagePlayer,
		spawnParticleBurst: (worldPos, spec) =>
			spawnParticleBurst(burstStage, worldPos, spec),
		avatarWorldPosition,
		groundedY,
	};

	function buildEnemyActor(anchor: {
		x: number;
		y: number;
		z: number;
	}): EnemyActorEntity {
		return createIguanoEnemyActor(anchor) as unknown as EnemyActorEntity;
	}

	/**
	 * Spawn one enemy in the local sim and register it with the server's
	 * liveness ledger (idempotent — the first client's insert wins). All
	 * randomness (initial phase, attack jitter, later behaviour draws)
	 * comes from the supplied deterministic `rng` stream so every client
	 * builds the same enemy.
	 */
	function spawnEnemyLocal(
		enemyKey: string,
		iguanoKind: IguanoKind,
		anchorXZ: { x: number; z: number },
		rng: () => number,
	): EnemyEntry {
		const groundY = groundedY(anchorXZ.x, anchorXZ.z);
		const anchor = new Vector3(anchorXZ.x, groundY, anchorXZ.z);
		const actor = buildEnemyActor(anchor);
		stage.add(actor as unknown as Parameters<typeof stage.add>[0]);

		const maxHp = KIND_MAX_HP[iguanoKind];
		const entry: EnemyEntry = {
			enemyKey,
			iguanoKind,
			actor,
			alive: true,
			hp: maxHp,
			maxHp,
			rng,
			anchor,
			phase: rng() * Math.PI * 2,
			time: 0,
			attackCooldown: 0.4 + rng() * 0.6,
		};
		enemies.set(entry.enemyKey, entry);
		void conn.reducers.registerEnemy({ enemyKey });
		return entry;
	}

	/**
	 * Spawn the given wave locally: one enemy of every archetype around
	 * the bowl, skipping any the registry already marks as killed (late
	 * joiners) or that this client already has.
	 */
	function spawnWave(nextWaveIndex: number): void {
		currentWave = nextWaveIndex;
		waveRespawnTimer = 0;
		for (let i = 0; i < ENEMIES_PER_WAVE; i += 1) {
			const enemyKey = waveEnemyKey(nextWaveIndex, i);
			if (enemies.has(enemyKey)) continue;
			if (isRegisteredDead(enemyKey)) continue;
			const iguanoKind = WAVE_KIND_ORDER[i]!;
			const anchor = ENEMY_ANCHORS_XZ[i % ENEMY_ANCHORS_XZ.length]!;
			spawnEnemyLocal(
				enemyKey,
				iguanoKind,
				anchor,
				createWaveEnemyRng(nextWaveIndex, i),
			);
		}
	}

	function syncWave(row: { waveIndex: number }): void {
		if (row.waveIndex === currentWave) return;
		spawnWave(row.waveIndex);
	}

	conn.db.arena_wave.onInsert((_ctx, row) => {
		syncWave(row);
	});
	conn.db.arena_wave.onUpdate((_ctx, _old, row) => {
		syncWave(row);
	});

	conn.db.enemy_registry.onInsert((_ctx, row) => {
		if (!row.alive) removeKilledByPeer(row.enemyKey);
	});
	conn.db.enemy_registry.onUpdate((_ctx, _old, row) => {
		if (!row.alive) removeKilledByPeer(row.enemyKey);
	});

	stage.onUpdate(({ delta }: UpdateContext<any>) => {
		if (currentWave === 0) {
			// Bootstrap: adopt the shared wave counter once it arrives, or
			// ask the server to create it on a fresh database. The reducer
			// is first-wins, so every client can safely request it.
			waveInitPollTimer -= delta;
			if (waveInitPollTimer <= 0) {
				waveInitPollTimer = WAVE_INIT_POLL_INTERVAL;
				const row = conn.db.arena_wave.id.find(0);
				if (row) {
					syncWave(row);
				} else {
					void conn.reducers.advanceWave({ fromWave: 0 });
				}
			}
		} else if (enemies.size === 0) {
			// Wave cleared everywhere (kills propagate through the
			// registry). Ask the server to advance; the `fromWave` guard
			// makes simultaneous requests from multiple clients advance
			// the counter exactly once.
			waveRespawnTimer -= delta;
			if (waveRespawnTimer <= 0) {
				waveRespawnTimer = WAVE_RESPAWN_DELAY;
				void conn.reducers.advanceWave({ fromWave: currentWave });
			}
		} else {
			waveRespawnTimer = 0;
		}

		for (const entry of enemies.values()) {
			if (!entry.alive || entry.runnerCommitted) continue;
			IGUANO_BEHAVIORS[entry.iguanoKind].update(entry, delta, env);
		}

		updateProjectiles(stage, projectiles, avatars, damagePlayer, delta);
		updateProximityMines(
			stage,
			burstStage,
			proximityMines,
			avatars,
			damagePlayer,
			MINE_TUNING,
			delta,
		);
	});

	return {
		attachAvatar(entityId, record) {
			avatars.set(entityId, record);
		},
		detachAvatar(entityId) {
			avatars.delete(entityId);
		},
		spawnGuestIguanoForNewPlayer(playerEntityId) {
			if (guestIguanoSpawnedForPlayerEntity.has(playerEntityId)) return;
			guestIguanoSpawnedForPlayerEntity.add(playerEntityId);
			const enemyKey = guestEnemyKey(playerEntityId);
			if (enemies.has(enemyKey)) return;
			if (isRegisteredDead(enemyKey)) return;
			// Kind + anchor derive from the player's server-assigned entity
			// id, so every client spawns the same guest at the same spot.
			const n = BigInt(ALL_IGUANO_KINDS.length);
			const kindIdx = moduloPositiveBigint(playerEntityId, n);
			const iguanoKind = ALL_IGUANO_KINDS[kindIdx]!;
			const span = BigInt(ENEMY_ANCHORS_XZ.length);
			const anchIdx = moduloPositiveBigint(playerEntityId, span);
			const anchor = ENEMY_ANCHORS_XZ[anchIdx]!;
			spawnEnemyLocal(
				enemyKey,
				iguanoKind,
				anchor,
				createGuestEnemyRng(playerEntityId),
			);
		},
		resolveAttackHit(info) {
			const radiusSq = (1.5 + 0.5) ** 2;
			for (const entry of enemies.values()) {
				if (!entry.alive) continue;
				const pos = entry.actor.body?.translation?.();
				if (!pos) continue;
				const dx = pos.x - info.position.x;
				const dy = pos.y - info.position.y;
				const dz = pos.z - info.position.z;
				if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
				damageEnemyLocal(entry, info.damage ?? 5);
			}
		},
		reset() {
			for (const entry of enemies.values()) {
				if (stage.wrappedStage && entry.actor.uuid) {
					stage.wrappedStage.removeEntityByUuid(entry.actor.uuid);
				}
			}
			enemies.clear();
			avatars.clear();
			clearProjectiles(stage, projectiles);
			clearMines(stage, proximityMines);
			guestIguanoSpawnedForPlayerEntity.clear();
		},
	};
}
