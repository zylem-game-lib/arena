import { Color, Vector3 } from 'three';
import { createSphere } from '@zylem/game-lib/entity';
import type { ArenaMainStageHandle, AvatarRecord } from '../main-stage';
import {
	spawnParticleBurst,
	type StageAddTarget,
} from '../../characters/attack-effects';
import { avatarWorldPosition } from './shared';

interface SphereEntityLike {
	uuid: string;
	group:
		| {
				position: { x: number; y: number; z: number };
		  }
		| null
		| undefined;
	body?:
		| {
				setTranslation(
					v: { x: number; y: number; z: number },
					wake: boolean,
				): void;
				translation(): { x: number; y: number; z: number };
		  }
		| undefined;
}

/**
 * Active proximity mine planted by an iguano planter. Like projectiles, the
 * sim runs locally on every client; only the local player's own hit reaches
 * the network via the `damagePlayer` callback.
 */
export interface ProximityMine {
	entity: SphereEntityLike;
	/** Seconds until the mine can hurt players after spawn. */
	armTimer: number;
	lifetime: number;
}

export interface MineTuning {
	armDelay: number;
	lifetime: number;
	triggerRadius: number;
	damage: number;
	visualRadius: number;
}

export type MineList = ProximityMine[];

const _minePos = new Vector3();
const _avatarScratch = new Vector3();

/**
 * Spawn a translucent mine sphere just above `pos` and register it for the
 * proximity-trigger sim. The sphere is added to `stage` immediately.
 */
export function spawnProximityMineAt(
	stage: ArenaMainStageHandle['stage'],
	mines: MineList,
	pos: Vector3,
	tuning: MineTuning,
): void {
	const sphere = createSphere({
		name: 'arena-planter-mine',
		radius: tuning.visualRadius,
		position: { x: pos.x, y: pos.y + 0.06, z: pos.z },
		material: { color: new Color(0xb4ff77), opacity: 0.55 },
		collision: { static: false },
	});
	stage.add(sphere as unknown as Parameters<typeof stage.add>[0]);
	mines.push({
		entity: sphere as unknown as SphereEntityLike,
		armTimer: tuning.armDelay,
		lifetime: tuning.lifetime,
	});
}

/**
 * Step every active mine: count down the arm timer / lifetime, detonate on
 * proximity (after arming), and apply blast damage to overlapping avatars.
 */
export function updateProximityMines(
	stage: ArenaMainStageHandle['stage'],
	burstStage: StageAddTarget,
	mines: MineList,
	avatars: ReadonlyMap<bigint, AvatarRecord>,
	damagePlayer: (av: AvatarRecord, amount: number) => void,
	tuning: MineTuning,
	delta: number,
): void {
	const triggerR2 = tuning.triggerRadius * tuning.triggerRadius;
	const blastRadius = tuning.triggerRadius + 0.6;
	const blastR2 = blastRadius * blastRadius;
	// Planar early-out uses a slightly larger XZ radius so elevated avatars
	// still get a full 3D test when close enough in plan.
	const xzEarlyR2 = blastR2;

	for (let i = mines.length - 1; i >= 0; i -= 1) {
		const m = mines[i]!;
		m.lifetime -= delta;
		if (m.armTimer > 0) {
			m.armTimer = Math.max(0, m.armTimer - delta);
		}
		const minePos = m.entity.body?.translation?.() ?? {
			x: m.entity.group?.position.x ?? 0,
			y: m.entity.group?.position.y ?? 0,
			z: m.entity.group?.position.z ?? 0,
		};
		_minePos.set(minePos.x, minePos.y, minePos.z);

		let detonate = false;
		if (m.armTimer <= 0 && m.lifetime > 0) {
			for (const av of avatars.values()) {
				const pt = avatarWorldPosition(av, _avatarScratch);
				if (!pt) continue;
				const dx = pt.x - _minePos.x;
				const dz = pt.z - _minePos.z;
				if (dx * dx + dz * dz > triggerR2) continue;
				const dy = pt.y - _minePos.y;
				if (dx * dx + dy * dy + dz * dz <= triggerR2) {
					detonate = true;
					break;
				}
			}
		}

		if (detonate) {
			spawnParticleBurst(burstStage, _minePos, {
				color: '#b4ff44',
				count: 14,
				duration: 0.06,
				speed: [4, 12],
				size: [0.1, 0.28],
				yOffset: 0.2,
			});
			for (const av of avatars.values()) {
				const pt = avatarWorldPosition(av, _avatarScratch);
				if (!pt) continue;
				const dx = pt.x - _minePos.x;
				const dz = pt.z - _minePos.z;
				if (dx * dx + dz * dz > xzEarlyR2) continue;
				const dy = pt.y - _minePos.y;
				if (dx * dx + dy * dy + dz * dz <= blastR2) {
					damagePlayer(av, tuning.damage);
				}
			}
		}

		if (detonate || m.lifetime <= 0) {
			if (stage.wrappedStage && m.entity.uuid) {
				stage.wrappedStage.removeEntityByUuid(m.entity.uuid);
			}
			mines.splice(i, 1);
		}
	}
}

/** Best-effort cleanup used by `EnemiesHandle.reset()`. */
export function clearMines(
	stage: ArenaMainStageHandle['stage'],
	mines: MineList,
): void {
	for (const m of mines) {
		if (stage.wrappedStage && m.entity.uuid) {
			stage.wrappedStage.removeEntityByUuid(m.entity.uuid);
		}
	}
	mines.length = 0;
}
