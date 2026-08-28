/**
 * Lightweight FPS / frame-time overlay for validating the arena perf fixes.
 *
 * Enable with `?perf=1` on the URL (or `localStorage.setItem('arena-perf','1')`).
 * Logs a one-line summary every 5s to the console:
 *   fps, frame p50/p95 (ms), JS heap MB (when available).
 *
 * After a ~50s combat session, compare against the baseline capture:
 * - FPS should stay closer to the display refresh
 * - frame p95 should not spike to 30–40 ms from particle shader builds
 * - heap should sawtooth less aggressively
 *
 * For a full Chrome Performance profile comparison, re-record and check:
 * 1. `checkAndDraw` / particle setTimeout samples stay flat (no 6× climb)
 * 2. Late-window GPUTask sum within ~1.5× of the early window
 * 3. WebSocketSend for transforms ≤ ~20/s while moving
 */

type GameLike = {
	onUpdate?: (cb: (ctx: { delta?: number }) => void) => void;
};

export interface PerfLoggerHandle {
	detach(): void;
}

function perfEnabled(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		const params = new URLSearchParams(window.location.search);
		if (params.get('perf') === '1') return true;
		if (window.localStorage?.getItem('arena-perf') === '1') return true;
	} catch {
		/* ignore */
	}
	return false;
}

export function attachPerfLogger(game: GameLike): PerfLoggerHandle | null {
	if (!perfEnabled()) return null;

	const samples: number[] = [];
	let windowStart = performance.now();
	let frames = 0;
	let attached = true;

	const overlay = document.createElement('div');
	overlay.id = 'arena-perf-overlay';
	overlay.style.cssText = [
		'position:fixed',
		'top:8px',
		'left:8px',
		'z-index:99999',
		'padding:6px 10px',
		'font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
		'color:#e8ffe8',
		'background:rgba(0,0,0,0.65)',
		'border:1px solid rgba(255,255,255,0.15)',
		'pointer-events:none',
		'white-space:pre',
	].join(';');
	document.body.appendChild(overlay);

	const onFrame = (ctx: { delta?: number }) => {
		if (!attached) return;
		const dtMs = (ctx.delta ?? 1 / 60) * 1000;
		samples.push(dtMs);
		frames += 1;
		const now = performance.now();
		if (now - windowStart < 1000) {
			overlay.textContent = `fps …\nframe ${dtMs.toFixed(1)} ms`;
			return;
		}

		const sorted = samples.slice().sort((a, b) => a - b);
		const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
		const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
		const fps = frames / ((now - windowStart) / 1000);
		const heap =
			(
				performance as Performance & {
					memory?: { usedJSHeapSize: number };
				}
			).memory?.usedJSHeapSize ?? 0;
		const heapMb = heap ? (heap / 1e6).toFixed(1) : 'n/a';
		const line = `fps ${fps.toFixed(1)}  p50 ${p50.toFixed(1)}ms  p95 ${p95.toFixed(1)}ms  heap ${heapMb}MB`;
		overlay.textContent = line;
		console.info(`[arena-perf] ${line}`);

		samples.length = 0;
		frames = 0;
		windowStart = now;
	};

	game.onUpdate?.(onFrame);

	return {
		detach() {
			attached = false;
			overlay.remove();
		},
	};
}
