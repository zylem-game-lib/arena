#!/usr/bin/env node
/**
 * `pnpm moba` — a Clack-style TUI launcher for the Zylem arena.
 *
 * Lets you boot the SpacetimeDB server and the Vite game client together from
 * a single prompt, with prefixed/colorized log streams and a clean Ctrl+C that
 * tears every child process down. Optionally (re)builds and publishes the
 * `arena` module once the server is reachable.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import {
	intro,
	outro,
	multiselect,
	confirm,
	isCancel,
	cancel,
	note,
	log,
} from '@clack/prompts';

const c = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	cyan: '\x1b[36m',
	magenta: '\x1b[35m',
	yellow: '\x1b[33m',
	green: '\x1b[32m',
	red: '\x1b[31m',
};

const paint = (code, text) => `${code}${text}${c.reset}`;

/** Long-running processes the launcher can manage. */
const TARGETS = {
	server: { label: 'SpacetimeDB server', script: 'server:start', tag: 'server', color: c.cyan },
	client: { label: 'Game client (Vite)', script: 'dev', tag: 'client', color: c.magenta },
};

/** All spawned children, so a single SIGINT can stop everything. */
const children = new Set();
let shuttingDown = false;

/**
 * Spawn a `pnpm run <script>` child and stream its output line-by-line with a
 * colored `[tag]` prefix. Returns the ChildProcess.
 *
 * Long-running children (`oneShot: false`) bring the whole launcher down if
 * they exit on their own; one-shot tasks (e.g. publish) just report and stay
 * out of the way.
 */
function runScript(script, tag, colorCode, { oneShot = false } = {}) {
	const prefix = paint(colorCode, `[${tag}]`);
	const child = spawn('pnpm', ['run', script], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.add(child);

	const pipe = (stream, isErr) => {
		let buffer = '';
		stream.setEncoding('utf8');
		stream.on('data', (chunk) => {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const text = isErr ? paint(c.dim, line) : line;
				process.stdout.write(`${prefix} ${text}\n`);
			}
		});
		stream.on('end', () => {
			if (buffer.length > 0) process.stdout.write(`${prefix} ${buffer}\n`);
		});
	};
	pipe(child.stdout, false);
	pipe(child.stderr, true);

	child.on('exit', (code, signal) => {
		children.delete(child);
		if (shuttingDown) return;
		const how = signal ? `signal ${signal}` : `code ${code}`;
		if (oneShot) {
			if (code === 0) log.success(`[${tag}] done.`);
			else log.warn(`[${tag}] exited (${how}).`);
			return;
		}
		process.stdout.write(`${prefix} ${paint(c.yellow, `process exited (${how})`)}\n`);
		// If a core process dies on its own, bring the whole launcher down so the
		// user isn't left with a half-running stack.
		shutdown(code ?? 1);
	});

	return child;
}

/** Resolve the SpacetimeDB listen address the server script will bind to. */
function resolveServerAddr() {
	const raw = process.env.SPACETIME_SERVER_LISTEN_ADDR || '127.0.0.1:3000';
	const [host, portStr] = raw.split(':');
	return { host: host || '127.0.0.1', port: Number(portStr || '3000') };
}

/** Poll a TCP port until it accepts a connection or the timeout elapses. */
function waitForPort({ host, port }, { timeoutMs = 60000, intervalMs = 500 } = {}) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const attempt = () => {
			if (shuttingDown) return resolve(false);
			const socket = net.connect({ host, port });
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => {
				socket.destroy();
				if (Date.now() > deadline) return resolve(false);
				setTimeout(attempt, intervalMs);
			});
		};
		attempt();
	});
}

/** Build + publish the `arena` module once the server is reachable. */
async function publishArena() {
	const addr = resolveServerAddr();
	log.step(`Waiting for SpacetimeDB on ${addr.host}:${addr.port} before publishing...`);
	const ready = await waitForPort(addr);
	if (!ready) {
		log.warn('Server did not become reachable in time; skipping module publish.');
		return;
	}
	if (shuttingDown) return;
	log.step('Server is up — building and publishing the `arena` module.');
	runScript('server:dev', 'publish', c.green, { oneShot: true });
}

/** Kill all children and exit. */
function shutdown(exitCode = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) {
		child.kill('SIGTERM');
	}
	outro(exitCode === 0 ? 'Stopped. GG.' : 'Stopped.');
	// Give children a moment to terminate, then exit.
	setTimeout(() => process.exit(exitCode), 300);
}

async function main() {
	intro(paint(c.bold, 'Zylem MOBA'));

	const selection = await multiselect({
		message: 'What should I launch?',
		options: [
			{ value: 'server', label: TARGETS.server.label, hint: 'pnpm server:start' },
			{ value: 'client', label: TARGETS.client.label, hint: 'pnpm dev' },
		],
		initialValues: ['server', 'client'],
		required: true,
	});
	if (isCancel(selection)) {
		cancel('Cancelled.');
		process.exit(0);
	}

	let publish = false;
	if (selection.includes('server')) {
		const answer = await confirm({
			message: '(Re)build and publish the `arena` module once the server is up?',
			initialValue: true,
		});
		if (isCancel(answer)) {
			cancel('Cancelled.');
			process.exit(0);
		}
		publish = answer;
	}

	const labels = selection.map((key) => TARGETS[key].label);
	note(
		[...labels, publish ? 'Publish: arena module' : null]
			.filter(Boolean)
			.map((line) => `• ${line}`)
			.join('\n'),
		'Starting',
	);

	process.on('SIGINT', () => shutdown(0));
	process.on('SIGTERM', () => shutdown(0));

	for (const key of selection) {
		const t = TARGETS[key];
		runScript(t.script, t.tag, t.color);
	}

	if (publish) {
		void publishArena();
	}

	log.message(paint(c.dim, 'Press Ctrl+C to stop everything.'));
}

main().catch((err) => {
	log.error(String(err?.stack || err));
	shutdown(1);
});
