#!/usr/bin/env node
/**
 * Production static + SpacetimeDB reverse proxy for Render.
 * Serves Vite `dist/` on $PORT and proxies `/v1` (HTTP + WebSocket) to SpacetimeDB.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import httpProxy from 'http-proxy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(repoRoot, process.env.RENDER_DIST_DIR || 'dist');
const listenPort = Number(process.env.PORT || '10000');
const stdbTarget = process.env.SPACETIME_PROXY_TARGET || 'http://127.0.0.1:3000';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.wasm': 'application/wasm',
	'.map': 'application/json',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.fbx': 'application/octet-stream',
};

function safeJoin(root, urlPath) {
	const decoded = decodeURIComponent((urlPath || '/').split('?')[0] || '/');
	const joined = path.normalize(path.join(root, decoded));
	if (!joined.startsWith(root)) return null;
	return joined;
}

function sendFile(res, filePath) {
	const ext = path.extname(filePath).toLowerCase();
	res.writeHead(200, {
		'Content-Type': MIME[ext] || 'application/octet-stream',
		'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
	});
	fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res) {
	const urlPath = req.url || '/';
	let filePath = safeJoin(distDir, urlPath);
	if (!filePath) {
		res.writeHead(403).end('Forbidden');
		return;
	}

	fs.stat(filePath, (err, stat) => {
		if (!err && stat.isDirectory()) {
			filePath = path.join(filePath, 'index.html');
		} else if (err || !stat.isFile()) {
			// SPA fallback
			filePath = path.join(distDir, 'index.html');
		}

		fs.stat(filePath, (indexErr, indexStat) => {
			if (indexErr || !indexStat.isFile()) {
				res.writeHead(404).end('Not found');
				return;
			}
			sendFile(res, filePath);
		});
	});
}

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
	console.error(`Missing ${path.join(distDir, 'index.html')}. Run pnpm render:build first.`);
	process.exit(1);
}

const proxy = httpProxy.createProxyServer({
	target: stdbTarget,
	ws: true,
	xfwd: true,
	changeOrigin: true,
});

proxy.on('error', (err, _req, res) => {
	console.error('[proxy]', err.message);
	if (res && !res.headersSent && typeof res.writeHead === 'function') {
		res.writeHead(502, { 'Content-Type': 'text/plain' });
		res.end('Bad gateway (SpacetimeDB proxy)');
	}
});

const server = http.createServer((req, res) => {
	const urlPath = req.url || '/';
	if (urlPath === '/v1' || urlPath.startsWith('/v1/')) {
		proxy.web(req, res);
		return;
	}
	serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
	const urlPath = req.url || '/';
	if (urlPath === '/v1' || urlPath.startsWith('/v1/')) {
		proxy.ws(req, socket, head);
		return;
	}
	socket.destroy();
});

server.listen(listenPort, '0.0.0.0', () => {
	console.log(`Serving ${distDir} on 0.0.0.0:${listenPort}`);
	console.log(`Proxying /v1 → ${stdbTarget}`);
});

function shutdown(signal) {
	console.log(`Received ${signal}, shutting down...`);
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
