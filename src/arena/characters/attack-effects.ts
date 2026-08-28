import {
	AdditiveBlending,
	CanvasTexture,
	LinearFilter,
	SRGBColorSpace,
	type ColorRepresentation,
	type Texture,
} from 'three';
import { createParticleSystem, type ZylemParticleSystem } from '@zylem/game-lib/entity';
import { particlePresets } from '@zylem/game-lib/behavior';

/**
 * Lightweight authoring shape used by each character file to declare the
 * particle burst that accompanies an attack or special. Shipping as an
 * options bag (rather than a pre-built effect) keeps per-character data
 * declarative: colour, count, life, etc. are plain numbers in the character
 * file and the arena builds the actual {@link ZylemParticleSystem} on demand.
 */
export interface ParticleBurstSpec {
	/** Base preset. `burst` for sparks, `smoke` for slow drifting clouds. */
	kind?: 'burst' | 'smoke';
	/** Core colour; also used as the soft-circle texture colour by default. */
	color: ColorRepresentation;
	/** Number of particles emitted. */
	count?: number;
	/** Emitter duration (seconds). */
	duration?: number;
	/** Per-particle lifetime range (seconds). */
	life?: readonly [number, number];
	/** Initial speed range (units/sec). */
	speed?: readonly [number, number];
	/** Per-particle size range (world units). */
	size?: readonly [number, number];
	/**
	 * Optional override for the soft-circle texture colour. Defaults to
	 * `color`. Set to `null` to draw an untextured preset billboard.
	 */
	textureColor?: ColorRepresentation | null;
	/**
	 * World-space vertical offset applied when spawning the burst (meters
	 * above the actor's origin). Useful to lift an attack spark to torso
	 * height or drop a slam burst at the feet.
	 */
	yOffset?: number;
}

const textureCache = new Map<string, Texture>();

/**
 * Hard cap on concurrent particle-system entities. Combat + mine + runner
 * bursts can otherwise stack until GPU overdraw tanks the frame. When the
 * cap is hit we destroy the oldest live system before spawning a new one.
 */
const MAX_ACTIVE_PARTICLE_SYSTEMS = 10;

/** Soft ceilings so authored specs can't overwhelm fill-rate even under the cap. */
const MAX_PARTICLE_COUNT = 18;
const MAX_SMOKE_COUNT = 14;

type TrackedParticleSystem = ZylemParticleSystem & {
	markedForRemoval?: boolean;
	nodeDestroy?: (ctx: { me: unknown; globals: Record<string, unknown> }) => void;
};

const activeSystems: TrackedParticleSystem[] = [];

/**
 * All spark colours used by character movesets + enemy FX. Pre-building these
 * during stage load avoids mid-fight canvas work and keeps the particle
 * atlas path on the synchronous (already-ready) branch.
 */
export const PARTICLE_WARMUP_COLORS: readonly ColorRepresentation[] = [
	// Tank
	'#d4a373',
	'#c97f52',
	'#b05d33',
	'#8b5a2b',
	'#ffd166',
	'#93c5fd',
	// Assassin
	'#c084fc',
	'#a855f7',
	'#7c3aed',
	'#ef4444',
	'#1f2937',
	'#d946ef',
	// Healer
	'#67e8f9',
	'#22d3ee',
	'#86efac',
	'#60a5fa',
	'#e0f2fe',
	// Enemies
	'#ff5522',
	'#b4ff44',
];

/**
 * Build (and cache) a soft-circle {@link CanvasTexture} tinted with the
 * given RGB hex. Using the same canvas pattern as the 3d-asteroids demo
 * keeps output consistent and avoids shipping bitmap assets for every
 * character + colour combination.
 *
 * Important: the particle atlas builder polls `texture.image.complete`
 * via `setTimeout` when the flag is falsy. HTMLCanvasElement has no
 * native `complete` property, so without the patch below every burst
 * permanently schedules a 100 ms poll — the primary end-of-session lag
 * cause in the arena perf profile.
 */
export function makeSparkTexture(
	color: ColorRepresentation = '#ffffff',
): Texture {
	const key = String(color);
	const cached = textureCache.get(key);
	if (cached) return cached;

	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	// Satisfy three.quarks / particle atlas readiness checks that expect
	// HTMLImageElement-like `.complete` on the texture source.
	Object.defineProperty(canvas, 'complete', {
		value: true,
		configurable: true,
	});
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error(
			'Unable to acquire 2D canvas context for particle texture.',
		);
	}
	const center = size / 2;
	const hex = normalizeHex(color);
	const { r, g, b } = hexToRgb(hex);

	ctx.clearRect(0, 0, size, size);
	const gradient = ctx.createRadialGradient(
		center,
		center,
		4,
		center,
		center,
		center,
	);
	gradient.addColorStop(0, `rgba(255,255,255,0.95)`);
	gradient.addColorStop(0.25, `rgba(${r},${g},${b},0.82)`);
	gradient.addColorStop(0.6, `rgba(${r},${g},${b},0.36)`);
	gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
	ctx.fillStyle = gradient;
	ctx.beginPath();
	ctx.arc(center, center, center, 0, Math.PI * 2);
	ctx.fill();

	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	texture.minFilter = LinearFilter;
	texture.magFilter = LinearFilter;
	texture.needsUpdate = true;
	textureCache.set(key, texture);
	return texture;
}

/**
 * Pre-build every character / enemy spark texture so the first combat burst
 * does not pay canvas + atlas setup cost mid-fight.
 */
export function warmupParticleTextures(
	colors: readonly ColorRepresentation[] = PARTICLE_WARMUP_COLORS,
): void {
	for (const color of colors) {
		makeSparkTexture(color);
	}
}

/**
 * Force TSL / particle pipeline compilation during stage load by spawning
 * (and immediately retiring) one tiny burst of each preset kind off-stage.
 * Call after the stage exists so the particle behavior system is live.
 */
export function warmupParticleMaterials(stage: StageAddTarget): void {
	warmupParticleTextures();
	const offscreen = { x: 0, y: -10_000, z: 0 };
	for (const kind of ['burst', 'smoke'] as const) {
		const system = spawnParticleBurst(stage, offscreen, {
			kind,
			color: '#ffffff',
			count: 1,
			duration: 0.05,
			life: [0.05, 0.08],
			speed: [0.1, 0.2],
			size: [0.05, 0.08],
			yOffset: 0,
		});
		// Retire immediately so warmup does not consume the live cap.
		destroyTrackedSystem(system as TrackedParticleSystem);
	}
}

export interface StageAddTarget {
	add: (...entities: any[]) => void;
}

function pruneFinishedSystems(): void {
	for (let i = activeSystems.length - 1; i >= 0; i -= 1) {
		const system = activeSystems[i]!;
		if (system.markedForRemoval || !system.isPlaying?.()) {
			activeSystems.splice(i, 1);
		}
	}
}

function destroyTrackedSystem(system: TrackedParticleSystem): void {
	const idx = activeSystems.indexOf(system);
	if (idx >= 0) activeSystems.splice(idx, 1);
	if (system.markedForRemoval) return;
	try {
		system.stop?.();
	} catch {
		/* ignore */
	}
	try {
		system.nodeDestroy?.({ me: system, globals: {} });
	} catch {
		system.markedForRemoval = true;
	}
}

function enforceParticleCap(): void {
	pruneFinishedSystems();
	while (activeSystems.length >= MAX_ACTIVE_PARTICLE_SYSTEMS) {
		const oldest = activeSystems.shift();
		if (!oldest) break;
		destroyTrackedSystem(oldest);
	}
}

function clampSpec(spec: ParticleBurstSpec): ParticleBurstSpec {
	const kind = spec.kind ?? 'burst';
	const maxCount = kind === 'smoke' ? MAX_SMOKE_COUNT : MAX_PARTICLE_COUNT;
	const count =
		spec.count === undefined
			? undefined
			: Math.min(spec.count, maxCount);
	const life = spec.life
		? ([
				Math.min(spec.life[0], 0.9),
				Math.min(spec.life[1], 1.2),
			] as const)
		: undefined;
	const duration =
		spec.duration === undefined
			? undefined
			: Math.min(spec.duration, kind === 'smoke' ? 0.55 : 0.35);
	return { ...spec, count, life, duration };
}

/**
 * Spawn a one-shot particle burst at a world-space position and return the
 * created {@link ZylemParticleSystem}. The system uses `autoDestroy: true`
 * so the engine removes the entity from the stage once the internal
 * particle system finishes — callers don't need to track lifetime.
 *
 * Concurrent systems are hard-capped; particle counts / lifetimes are
 * clamped to keep GPU overdraw bounded during heavy combat.
 */
export function spawnParticleBurst(
	stage: StageAddTarget,
	position: { x: number; y: number; z: number },
	spec: ParticleBurstSpec,
): ZylemParticleSystem {
	const clamped = clampSpec(spec);
	const kind = clamped.kind ?? 'burst';
	const preset = kind === 'smoke' ? particlePresets.smoke : particlePresets.burst;
	const textureColor =
		clamped.textureColor === null
			? undefined
			: (clamped.textureColor ?? clamped.color);

	enforceParticleCap();

	const y = position.y + (clamped.yOffset ?? 0);
	const effect = preset({
		color: clamped.color,
		count: clamped.count,
		duration: clamped.duration,
		life: clamped.life,
		speed: clamped.speed,
		size: clamped.size,
		worldSpace: true,
		...(textureColor !== undefined
			? {
					texture: makeSparkTexture(textureColor),
					blending: AdditiveBlending,
					depthWrite: false,
					alphaTest: 0.01,
				}
			: {}),
	});

	const system = createParticleSystem({
		position: { x: position.x, y, z: position.z },
		// Cast: game-lib may resolve a slightly different @zylem/behaviors
		// version than the direct import, so the ParticleEffectDefinition
		// brands disagree even though the runtime object is compatible.
		preset: effect as any,
		autoplay: false,
		followPosition: false,
		followRotation: false,
		autoDestroy: true,
	}) as TrackedParticleSystem;

	stage.add(system);
	activeSystems.push(system);
	system.burst();
	return system;
}

/** Test / reset helper — destroy every tracked burst still on the stage. */
export function clearActiveParticleSystems(): void {
	while (activeSystems.length > 0) {
		const system = activeSystems.shift();
		if (system) destroyTrackedSystem(system);
	}
}

function normalizeHex(color: ColorRepresentation): string {
	if (typeof color === 'string') {
		return color.startsWith('#') ? color : `#${color}`;
	}
	if (typeof color === 'number') {
		return `#${color.toString(16).padStart(6, '0')}`;
	}
	return '#ffffff';
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const clean = hex.replace('#', '').trim();
	const expanded =
		clean.length === 3
			? clean
					.split('')
					.map((c) => c + c)
					.join('')
			: clean;
	const int = Number.parseInt(expanded, 16);
	if (Number.isNaN(int)) return { r: 255, g: 255, b: 255 };
	return {
		r: (int >> 16) & 0xff,
		g: (int >> 8) & 0xff,
		b: int & 0xff,
	};
}
