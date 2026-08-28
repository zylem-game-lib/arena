import { Vector3 } from 'three';
import {
	avatarWorldPosition,
	faceDirection,
	playEnemyOneShot,
	syncIguanoLocomotion,
	teleportEnemyActor,
	xzDistSq,
	type BehaviorEnv,
	type EnemyEntry,
	type IguanoBehavior,
} from '../shared';

/** Runner kamikaze: sprint + AoE explosion on proximity. */
const RUNNER_APPROACH_SPEED = 10;
const RUNNER_DETONATE_RADIUS = 2.1;
const RUNNER_BLAST_RADIUS = 3.4;
const RUNNER_BLAST_DAMAGE = 34;

const _curScratch = new Vector3();
const _dirScratch = new Vector3();
const _nextScratch = new Vector3();
const _faceScratch = new Vector3();
const _avatarScratch = new Vector3();

/**
 * Detonate the runner: emit a particle burst, damage everyone inside the
 * blast radius, swap to the death animation, and despawn locally. Idempotent
 * via `runnerCommitted`.
 */
function explodeRunner(
	entry: EnemyEntry,
	worldPos: Vector3,
	env: BehaviorEnv,
): void {
	if (entry.runnerCommitted) return;
	entry.runnerCommitted = true;
	env.spawnParticleBurst(worldPos, {
		color: '#ff5522',
		count: 16,
		duration: 0.08,
		speed: [6, 14],
		size: [0.12, 0.4],
		yOffset: 0.4,
	});
	const blastR2 = RUNNER_BLAST_RADIUS * RUNNER_BLAST_RADIUS;
	for (const av of env.avatars.values()) {
		const pt = avatarWorldPosition(av, _avatarScratch);
		if (!pt) continue;
		const dx = pt.x - worldPos.x;
		const dz = pt.z - worldPos.z;
		if (dx * dx + dz * dz > blastR2) continue;
		const dy = pt.y - worldPos.y;
		if (dx * dx + dy * dy + dz * dz <= blastR2) {
			env.damagePlayer(av, RUNNER_BLAST_DAMAGE);
		}
	}
	playEnemyOneShot(entry, 'runDestruct');
	env.killEnemy(entry);
}

/**
 * Runner archetype: charges directly at the nearest avatar and detonates on
 * contact. No attack cooldown; the explosion is single-shot.
 */
export const RUNNER_BEHAVIOR: IguanoBehavior = {
	kind: 'runner',
	maxHp: 18,
	update(entry, delta, env) {
		if (entry.runnerCommitted) return;
		entry.time += delta;
		const cur = entry.actor.body?.translation?.() ?? entry.anchor;
		const tgt = env.nearestAvatar(cur);
		const curV = _curScratch.set(cur.x, cur.y, cur.z);
		if (!tgt) {
			syncIguanoLocomotion(entry, false);
			return;
		}
		const planar = xzDistSq(tgt.pos, curV);

		if (planar <= RUNNER_DETONATE_RADIUS * RUNNER_DETONATE_RADIUS) {
			explodeRunner(entry, curV, env);
			return;
		}

		const dir = _dirScratch
			.set(tgt.pos.x - curV.x, 0, tgt.pos.z - curV.z)
			.normalize()
			.multiplyScalar(RUNNER_APPROACH_SPEED * delta);
		const nextX = curV.x + dir.x;
		const nextZ = curV.z + dir.z;
		const next = _nextScratch.set(
			nextX,
			env.groundedY(nextX, nextZ),
			nextZ,
		);
		entry.anchor.y = next.y;

		const prevX = curV.x;
		const prevZ = curV.z;
		teleportEnemyActor(entry, next);
		const after = entry.actor.body?.translation?.() ?? next;
		const moved = xzDistSq({ x: prevX, y: 0, z: prevZ }, after) > 1e-6;
		syncIguanoLocomotion(entry, moved);

		const q = entry.actor.body?.translation?.() ?? next;
		faceDirection(
			entry,
			_faceScratch.set(tgt.pos.x - q.x, 0, tgt.pos.z - q.z),
		);
	},
};
