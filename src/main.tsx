import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { render } from 'solid-js/web';
import { subscribe } from 'valtio/vanilla';
import { ZylemGameElement } from '@zylem/game-lib/web-components';
import { zylemEventBus, type GameLoadingPayload } from '@zylem/game-lib/events';
import createArena from './demos/arena/arena';
import ArenaLobby from './demos/arena/ArenaLobby/ArenaLobby';
import { arenaLobbyStore } from './demos/arena/networking/arena-lobby-store';
import './styles.css';

if (!customElements.get('zylem-game')) {
	customElements.define('zylem-game', ZylemGameElement);
}

declare module 'solid-js' {
	namespace JSX {
		interface IntrinsicElements {
			'zylem-game': any;
		}
	}
}

function App() {
	let gameRef: ZylemGameElement | undefined;
	const [game] = createSignal(createArena());
	const [loading, setLoading] = createSignal(true);
	const [progress, setProgress] = createSignal(0);
	const [message, setMessage] = createSignal('Loading arena...');
	const [, setLobbyRevision] = createSignal(0);

	const handleLoadingEvent = (event: GameLoadingPayload) => {
		setProgress(event.progress ?? 0);
		setMessage(event.message ?? '');
		if (event.type === 'start') {
			setLoading(true);
		}
		if (event.type === 'complete') {
			setLoading(false);
			gameRef?.focus();
		}
	};

	onMount(() => {
		const unsubscribeLobby = subscribe(
			arenaLobbyStore,
			() => setLobbyRevision((value) => value + 1),
			true,
		);
		zylemEventBus.on('loading:start', handleLoadingEvent);
		zylemEventBus.on('loading:progress', handleLoadingEvent);
		zylemEventBus.on('loading:complete', handleLoadingEvent);

		onCleanup(() => {
			unsubscribeLobby();
			zylemEventBus.off('loading:start', handleLoadingEvent);
			zylemEventBus.off('loading:progress', handleLoadingEvent);
			zylemEventBus.off('loading:complete', handleLoadingEvent);
		});
	});

	const showArenaLobby = () => !arenaLobbyStore.lobbyDismissed;

	return (
		<main class="arena-shell">
			<section class="arena-stage">
				<zylem-game
					ref={gameRef}
					class="arena-game"
					data-demo-id="arena"
					game={game()}
					viewport-profile="desktop"
				/>
				<Show when={showArenaLobby()}>
					<ArenaLobby />
				</Show>
				<Show when={loading()}>
					<div class="arena-loading" data-demo-loading-overlay>
						<div class="arena-loading-card">
							<div class="arena-loading-title">Loading...</div>
							<div class="arena-progress">
								<div
									class="arena-progress-fill"
									style={{ width: `${progress() * 100}%` }}
								/>
							</div>
							<div class="arena-loading-message">{message()}</div>
						</div>
					</div>
				</Show>
			</section>
		</main>
	);
}

const root = document.getElementById('root');
if (root) {
	render(() => <App />, root);
}

