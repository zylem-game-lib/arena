import { Vector3 } from 'three';
import {
	faceDirection,
	moveTowardXZ,
	playEnemyOneShot,
	syncIguanoLocomotion,
	teleportEnemyActor,
	xzDistSq,
	type IguanoBehavior,
} from '../shared';

/** Planter: plants client-local proximity mines (`damage_player` only). */
const PLANTER_MOVE_SPEED = 3.6;
const PLANT_INTERVAL = 2.9;

const _destScratch = new Vector3();
const _curScratch = new Vector3();
const _faceScratch = new Vector3();
const _mineScratch = new Vector3();

/**
 * Planter archetype: hovers around the avatar centroid (or its anchor when no
 * players are present) and periodically drops a proximity mine at its feet.
 */
export const PLANTER_BEHAVIOR: IguanoBehavior = {
	kind: 'planter',
	maxHp: 36,
	update(entry, delta, env) {
		entry.time += delta;
		const cen = env.centroidOfAvatarsXZ();
		const cur = entry.actor.body?.translation?.() ?? entry.anchor;

		let dest: Vector3;
		if (!cen) {
			dest = _destScratch.set(
				entry.anchor.x + Math.cos(entry.time * 0.4 + entry.phase) * 2,
				entry.anchor.y,
				entry.anchor.z + Math.sin(entry.time * 0.4 + entry.phase) * 2,
			);
		} else {
			dest = _destScratch
				.copy(cen)
				.sub(entry.anchor)
				.multiplyScalar(0.55)
				.add(entry.anchor);
		}
		dest.y = env.groundedY(dest.x, dest.z);

		const curV = _curScratch.set(cur.x, cur.y, cur.z);
		const step = PLANTER_MOVE_SPEED * delta;
		const next = moveTowardXZ(curV, dest, step, env.groundedY);
		entry.anchor.y = next.y;

		const moved = xzDistSq(curV, next) > 1e-5;
		teleportEnemyActor(entry, next);
		syncIguanoLocomotion(entry, moved);
		if (cen) {
			faceDirection(entry, _faceScratch.copy(cen).sub(next));
		}

		entry.attackCooldown -= delta;
		if (entry.attackCooldown <= 0) {
			const foot = entry.actor.body?.translation?.() ?? next;
			env.spawnProximityMineAt(
				_mineScratch.set(foot.x, foot.y, foot.z),
			);
			playEnemyOneShot(entry, 'planting');
			entry.attackCooldown = PLANT_INTERVAL * (0.85 + entry.rng() * 0.25);
		}
	},
};
