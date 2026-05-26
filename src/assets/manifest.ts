import { ARENA_ASSET_PATHS } from './arena.manifest';

const PRODUCTION_BASE_URL = 'https://assets.zylem.cloud/demos';
const DEV_BASE_URL = '/cdn/demos';

function resolveBaseUrl(): string {
	const env = (import.meta as ImportMeta).env;
	const override = env?.VITE_DEMOS_ASSET_BASE_URL;
	if (override && override.length > 0) {
		return override.replace(/\/+$/, '');
	}
	return env?.DEV ? DEV_BASE_URL : PRODUCTION_BASE_URL;
}

const DEMOS_ASSET_BASE_URL = resolveBaseUrl();

const ASSET_PATHS = {
	...ARENA_ASSET_PATHS,
} as const satisfies Record<string, string>;

export type DemoAssetKey = keyof typeof ASSET_PATHS;

export function demoAsset<K extends DemoAssetKey>(key: K): string {
	return `${DEMOS_ASSET_BASE_URL}/${ASSET_PATHS[key]}`;
}

export const DEMO_ASSETS: { readonly [K in DemoAssetKey]: string } =
	Object.freeze(
		Object.fromEntries(
			(Object.keys(ASSET_PATHS) as DemoAssetKey[]).map(
				(key) => [key, demoAsset(key)] as const,
			),
		) as { [K in DemoAssetKey]: string },
	);

