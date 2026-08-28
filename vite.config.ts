import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import solidPlugin from 'vite-plugin-solid';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent } from 'https';
import { Resolver } from 'dns';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devPort = Number(process.env.PORT ?? '1337');
const defaultAllowedHosts = ['zylem.onrender.com', 'zylem-staging.onrender.com'];
const additionalAllowedHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? '')
	.split(',')
	.map((host) => host.trim())
	.filter(Boolean);
const allowedHosts = [...new Set([...defaultAllowedHosts, ...additionalAllowedHosts])];

const cdnDnsResolver = new Resolver();
cdnDnsResolver.setServers(['1.1.1.1', '1.0.0.1']);

function cdnDnsLookup(
	hostname: string,
	options: { all?: boolean; family?: number } | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
	callback?: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
): void {
	const opts = typeof options === 'function' ? {} : options;
	const cb = (typeof options === 'function' ? options : callback) as (
		err: NodeJS.ErrnoException | null,
		address: string | { address: string; family: number }[],
		family?: number,
	) => void;

	cdnDnsResolver.resolve4(hostname, (v4Err, v4Addrs) => {
		const v4 = (v4Addrs ?? []).map((address) => ({ address, family: 4 as const }));
		cdnDnsResolver.resolve6(hostname, (v6Err, v6Addrs) => {
			const v6 = (v6Addrs ?? []).map((address) => ({ address, family: 6 as const }));
			const all = [...v4, ...v6];
			if (all.length === 0) {
				const failure = (v4Err ?? v6Err ?? new Error(`No DNS answer for ${hostname}`)) as NodeJS.ErrnoException;
				cb(failure, '', 0);
				return;
			}
			if (opts.all) {
				cb(null, all);
				return;
			}
			const first = all[0]!;
			cb(null, first.address, first.family);
		});
	});
}

const cdnProxyAgent = new Agent({
	keepAlive: true,
	lookup: cdnDnsLookup as any,
});

export default defineConfig({
	plugins: [glsl(), vanillaExtractPlugin(), solidPlugin()] as any,
	build: {
		target: 'esnext',
	},
	assetsInclude: ['**/*.fbx', '**/*.gltf', '**/*.glb', '**/*.wasm'],
	resolve: {
		// Prefer a single physical copy of these packages. @zylem/behaviors
		// is no longer a direct dependency: it reaches us only through
		// game-lib, so there is one install and the cooldown store is
		// shared without further coaxing.
		// Do NOT alias `@zylem/behaviors` to a folder path — that bypasses
		// package `exports` and breaks subpath imports like `/cooldown`.
		dedupe: ['@zylem/behaviors', 'valtio', 'three'],
		alias: [
			// Solid-only project: route valtio's React-coupled main entry
			// to its framework-agnostic vanilla entry so optional peer dep
			// resolution doesn't try to load React.
			{ find: /^valtio$/, replacement: 'valtio/vanilla' },
		],
	},
	optimizeDeps: {
		exclude: ['valtio'],
		include: ['valtio/vanilla'],
	},
	server: {
		port: Number.isFinite(devPort) ? devPort : 1337,
		open: false,
		allowedHosts,
		fs: {
			allow: [path.resolve(__dirname, '..')],
		},
		proxy: {
			'/cdn': {
				target: 'https://assets.zylem.cloud',
				changeOrigin: true,
				secure: true,
				agent: cdnProxyAgent,
				rewrite: (urlPath) => urlPath.replace(/^\/cdn/, ''),
			},
		},
	},
	preview: {
		allowedHosts,
	},
	root: __dirname,
});
