import { t } from 'spacetimedb/server';
import { spacetime } from '../schema';

/** Primary key of the singleton row in the `arena_wave` table. */
export const ARENA_WAVE_SINGLETON_ID = 0;

/**
 * Idempotent enemy registration. Every client calls this when it spawns
 * an enemy in its local sim; the first call wins and duplicates are
 * ignored, so the row simply marks "this enemy exists and is alive".
 */
export const register_enemy = spacetime.reducer(
  {
    enemy_key: t.string(),
  },
  (ctx, { enemy_key }) => {
    if (ctx.db.enemy_registry.enemy_key.find(enemy_key) !== null) {
      return;
    }
    ctx.db.enemy_registry.insert({ enemy_key, alive: true });
  },
);

/**
 * Mark an enemy dead. Any client may call this the moment its local sim
 * kills the enemy; peers observe the update and despawn their copy. If
 * the kill races ahead of registration, insert the row directly as dead
 * so late joiners still skip it.
 */
export const report_enemy_kill = spacetime.reducer(
  {
    enemy_key: t.string(),
  },
  (ctx, { enemy_key }) => {
    const row = ctx.db.enemy_registry.enemy_key.find(enemy_key);
    if (row === null) {
      ctx.db.enemy_registry.insert({ enemy_key, alive: false });
      return;
    }
    if (!row.alive) {
      return;
    }
    ctx.db.enemy_registry.enemy_key.update({ ...row, alive: false });
  },
);

/**
 * Advance the shared wave counter. `from_wave` guards against races: the
 * increment only applies when the caller observed the current index, so
 * multiple clients clearing the wave simultaneously advance it exactly
 * once. `from_wave = 0` bootstraps the singleton on a fresh database.
 *
 * Registry rows from cleared waves are pruned here so the table only ever
 * holds the current wave (plus per-player guests).
 */
export const advance_wave = spacetime.reducer(
  {
    from_wave: t.u32(),
  },
  (ctx, { from_wave }) => {
    const cur = ctx.db.arena_wave.id.find(ARENA_WAVE_SINGLETON_ID);
    if (cur === null) {
      if (from_wave !== 0) {
        return;
      }
      ctx.db.arena_wave.insert({ id: ARENA_WAVE_SINGLETON_ID, wave_index: 1 });
      return;
    }
    if (cur.wave_index !== from_wave) {
      return;
    }
    for (const row of ctx.db.enemy_registry.iter()) {
      if (row.enemy_key.startsWith('wave:')) {
        ctx.db.enemy_registry.delete(row);
      }
    }
    ctx.db.arena_wave.id.update({ ...cur, wave_index: from_wave + 1 });
  },
);
