import {
	Fn,
	time,
	positionWorld,
	normalize,
	clamp,
	mix,
	smoothstep,
	sin,
	abs,
	exp,
	pow,
	step,
	max,
	floor,
	fract,
	dot,
	length,
	atan,
	asin,
	vec2,
	vec3,
	vec4,
	float,
	createBackgroundShader,
} from '@zylem/game-lib/graphics';

/**
 * Arena skybox shader (WebGPU / TSL).
 *
 * Ported from the original GLSL skybox to a TSL color node so it renders on
 * game-lib's WebGPU `WebGPURenderer`. The engine wraps this color node in a
 * `MeshBasicNodeMaterial` on a back-faced skybox cube and exposes
 * `positionWorld`; we normalise it to a view direction and build everything in
 * spherical coordinates so the sky + ground seam hugs a true horizon line.
 *
 * Visual target: reddish Mars surface with three distinct mountain-silhouette
 * bands fading into atmospheric haze, a dense starfield, a bright spiral
 * galaxy, a Milky Way band cutting diagonally, and a small red moon.
 */

const TAU = 6.28318530718;
const PI = 3.14159265359;

// Precomputed Milky-Way rotation (theta = -0.55) so we avoid mat2 in TSL.
const MW_COS = Math.cos(-0.55);
const MW_SIN = Math.sin(-0.55);

// Horizon sits slightly below centre so the sky reads as ~60% of view.
const HORIZON = -0.18;

// ────────────────────────────── hashing / noise ──────────────────────────────

const hash21 = Fn(([p]: [any]) => {
	const a: any = fract(p.mul(vec2(234.34, 435.345)));
	const b: any = a.add(dot(a, a.add(34.23)));
	return fract(b.x.mul(b.y));
});

const noise2 = Fn(([p]: [any]) => {
	const i = floor(p);
	const f: any = fract(p);

	const a = hash21(i);
	const b = hash21(i.add(vec2(1.0, 0.0)));
	const c = hash21(i.add(vec2(0.0, 1.0)));
	const d = hash21(i.add(vec2(1.0, 1.0)));

	const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
	return mix(a, b, u.x)
		.add(c.sub(a).mul(u.y).mul(float(1.0).sub(u.x)))
		.add(d.sub(b).mul(u.x).mul(u.y));
});

const fbm = Fn(([p]: [any]) => {
	let v: any = float(0.0);
	let amp: any = float(0.5);
	let pp: any = p;
	// Two octaves (was four) — enough for soft haze/galaxy noise without
	// the full fragment cost of the previous sky.
	v = v.add(amp.mul(noise2(pp)));
	pp = pp.mul(2.02);
	amp = amp.mul(0.5);
	v = v.add(amp.mul(noise2(pp)));
	return v;
});

// 1D ridged noise — used for mountain silhouette heights.
const ridged1 = Fn(([x]: [any]) => {
	const base = noise2(vec2(x, 0.0));
	return float(1.0).sub(abs(base.mul(2.0).sub(1.0)));
});

// ────────────────────────────── palettes ──────────────────────────────

const skyColor = Fn(([h]: [any]) => {
	const top = vec3(0.005, 0.005, 0.02);
	const midC = vec3(0.025, 0.015, 0.055);
	const horizonC = vec3(0.28, 0.11, 0.06);

	const c = mix(horizonC, midC, smoothstep(0.0, 0.22, h));
	return mix(c, top, smoothstep(0.22, 1.0, h));
});

const desertBase = Fn(([h]: [any]) => {
	const far = vec3(0.3, 0.13, 0.07);
	const midC = vec3(0.56, 0.23, 0.09);
	const near = vec3(0.8, 0.38, 0.16);

	const c = mix(far, midC, smoothstep(0.0, 0.35, h));
	return mix(c, near, smoothstep(0.35, 0.95, h));
});

// ────────────────────────────── stars ──────────────────────────────

// Soft-glow stars on a wrap-safe grid. 'threshold' controls density;
// higher values = sparser, brighter stars.
const stars = Fn(([uvCoord, threshold]: [any, any]) => {
	const gv = fract(uvCoord).sub(0.5);
	const id = floor(uvCoord);

	const n = hash21(id);
	const star = smoothstep(threshold, float(1.0), n);

	const d = length(gv);
	const sparkle = float(0.0028).div(d.mul(d).add(0.0025));

	// Slow per-star twinkle keyed off the cell hash.
	const tw = float(0.75).add(
		float(0.25).mul(sin(time.mul(float(0.4).add(n)).add(n.mul(TAU)))),
	);
	return star.mul(sparkle).mul(tw);
});

// ────────────────────────────── galaxy ──────────────────────────────

const milkyBand = Fn(([p]: [any]) => {
	const px = p.x.mul(1.3);
	const band = exp(abs(p.y).mul(-5.5));
	const n = fbm(vec2(px, p.y).mul(3.0).add(vec2(time.mul(0.008), 0.0)));
	return band.mul(float(0.35).add(float(0.75).mul(n)));
});

const spiralGalaxy = Fn(([p]: [any]) => {
	const r = length(p);
	const a = atan(p.y, p.x);

	const arms = sin(a.mul(2.5).add(r.mul(11.0)).sub(time.mul(0.04)));
	const core = exp(r.mul(-7.5));
	const disc = exp(abs(r.sub(0.18)).mul(-8.5));
	const dust = fbm(p.mul(7.0));
	return max(core.mul(1.7), disc.mul(float(0.55).add(float(0.55).mul(arms))).mul(dust));
});

// ────────────────────────────── landscape ──────────────────────────────

const mountainHeight = Fn(([x, scale, amp, base]: [any, any, any, any]) => {
	// Blend fbm with a ridged variant so the crest line has sharper peaks.
	// `base` arrives as a plain JS number, so the chain starts from a node
	// (`f`) and folds `base` in at the end via `.add(base)`.
	const f = fbm(vec2(x.mul(scale), 0.0));
	const rd = ridged1(x.mul(scale).mul(1.7));
	return f.mul(0.6).add(rd.mul(0.4)).sub(0.5).mul(amp).add(base);
});

// ────────────────────────────── main ──────────────────────────────

const arenaSkyColorNode = Fn(() => {
	// Direction from world origin to this skybox texel.
	const rd = normalize(positionWorld);

	// Equirectangular mapping for star / galaxy / mountain lookups.
	const lon = atan(rd.z, rd.x);
	const lat = asin(clamp(rd.y, -1.0, 1.0));

	const sky = vec2(lon.div(TAU).add(0.5), lat.div(PI).add(0.5));

	// Elevation in [-1, 1]: -1 = straight down, 0 = horizon, 1 = zenith.
	const elev = lat.div(PI * 0.5);

	// ═══════════════════════════ SKY ═══════════════════════════
	const h = clamp(elev.sub(HORIZON).div(1.0 - HORIZON), 0.0, 1.0);
	let skyCol: any = skyColor(h);

	// Dense, multi-scale starfield. Coordinates come from the
	// equirectangular uv so stars wrap cleanly around the dome.
	const s = stars(sky.mul(320.0), 0.994)
		.mul(1.4)
		.add(stars(sky.mul(180.0).add(0.37), 0.988).mul(1.0))
		.add(stars(sky.mul(85.0).add(0.71), 0.978).mul(0.8));
	skyCol = skyCol.add(vec3(s, s, s));

	// Milky-way band — rotated so it cuts diagonally through the scene.
	const mw0 = sky.sub(vec2(0.3, 0.58)).mul(3.0);
	const mw = vec2(
		mw0.x.mul(MW_COS).sub(mw0.y.mul(MW_SIN)),
		mw0.x.mul(MW_SIN).add(mw0.y.mul(MW_COS)),
	);
	const band = milkyBand(mw);
	skyCol = skyCol.add(vec3(0.22, 0.15, 0.32).mul(band).mul(1.7));
	skyCol = skyCol.add(vec3(0.45, 0.3, 0.22).mul(band).mul(0.75));
	// Extra fine stars inside the band for texture.
	skyCol = skyCol.add(
		vec3(0.95, 0.92, 0.98).mul(band).mul(stars(sky.mul(560.0), 0.982)).mul(1.2),
	);

	// Prominent purple spiral galaxy, anchored lower-left of the sky.
	const gP = sky.sub(vec2(0.36, 0.68)).mul(4.0);
	const galaxy = spiralGalaxy(gP);
	skyCol = skyCol.add(vec3(0.85, 0.42, 0.95).mul(galaxy).mul(1.4)); // magenta arms
	skyCol = skyCol.add(vec3(0.95, 0.58, 0.8).mul(galaxy).mul(0.6)); // pink mid
	skyCol = skyCol.add(
		vec3(1.0, 0.85, 0.7).mul(pow(max(0.0, float(1.0).sub(length(gP).mul(5.5))), 8.0)).mul(2.4),
	); // hot core

	// Small red moon in the upper-right.
	const moonP = sky.sub(vec2(0.78, 0.6)).mul(vec2(4.5, 2.5));
	const moonD = length(moonP);
	const moon = smoothstep(0.14, 0.11, moonD);
	const shade = clamp(
		dot(
			normalize(vec3(moonP.x, moonP.y, 0.25)),
			normalize(vec3(-0.7, 0.3, 1.0)),
		),
		0.0,
		1.0,
	);
	skyCol = mix(skyCol, vec3(0.6, 0.26, 0.18).mul(float(0.35).add(float(0.65).mul(shade))), moon);
	skyCol = skyCol.add(vec3(0.32, 0.12, 0.09).mul(smoothstep(0.3, 0.14, moonD)).mul(0.35));

	// Warm horizon glow — sells the Mars sunset atmosphere.
	const glow = exp(abs(elev.sub(HORIZON)).mul(-14.0));
	skyCol = skyCol.add(vec3(0.55, 0.22, 0.1).mul(glow).mul(0.55));

	// ═══════════════════════════ MARS SURFACE ═══════════════════════════
	const groundH = clamp(float(HORIZON).sub(elev).div(HORIZON + 1.0), 0.0, 1.0);
	let groundCol: any = desertBase(groundH);

	// Three layered mountain silhouettes.
	const m1 = mountainHeight(lon.add(0.0), 1.6, 0.05, HORIZON - 0.015);
	const m2 = mountainHeight(lon.add(1.7), 1.1, 0.085, HORIZON - 0.055);
	const m3 = mountainHeight(lon.add(3.3), 0.7, 0.12, HORIZON - 0.1);

	const mountFar = vec3(0.26, 0.12, 0.07);
	const mountMid = vec3(0.38, 0.17, 0.08);
	const mountNear = vec3(0.5, 0.22, 0.1);

	const k1 = smoothstep(0.0, 0.006, m1.sub(elev));
	const k2 = smoothstep(0.0, 0.006, m2.sub(elev));
	const k3 = smoothstep(0.0, 0.008, m3.sub(elev));

	groundCol = mix(groundCol, mountFar, k1);
	groundCol = mix(groundCol, mountMid, k2);
	groundCol = mix(groundCol, mountNear, k3);

	// Coarse rock texture across the whole ground.
	const rocks = fbm(sky.mul(vec2(42.0, 22.0)));
	groundCol = groundCol.mul(float(0.88).add(rocks.mul(0.24)));

	// High-frequency pebbles speckling the surface.
	const peb = hash21(sky.mul(420.0));
	groundCol = groundCol.mul(float(0.94).add(step(0.92, peb).mul(0.18)));

	// Subtle warm haze right above the surface to sell distance.
	const haze = exp(abs(elev.sub(HORIZON)).mul(-18.0));
	groundCol = mix(groundCol, vec3(0.48, 0.22, 0.11), haze.mul(0.35));

	// Gentle vignette pulling the eye toward the horizon.
	const vig = float(1.0).add(elev.mul(0.6));
	groundCol = groundCol.mul(clamp(vig, 0.6, 1.0));

	// Blend the two hemispheres at the horizon seam.
	const skyMask = smoothstep(HORIZON - 0.004, HORIZON + 0.004, elev);
	let col: any = mix(groundCol, skyCol, skyMask);

	// Gentle filmic curve.
	col = pow(col, float(0.92));

	return vec4(col, 1.0);
})();

export const arenaShader = createBackgroundShader(arenaSkyColorNode);
