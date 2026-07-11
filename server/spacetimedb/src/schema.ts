import { type InferSchema, schema, table, t } from 'spacetimedb/server';

/**
 * Authoritative world pose for a replicated entity (Zylem transform snapshot).
 * Used for player avatars; enemies are simulated locally on each client.
 */
export const entity_transform = table(
  { name: 'entity_transform', public: true },
  {
    entity_id: t.u64().primaryKey().autoInc(),
    pos_x: t.f32(),
    pos_y: t.f32(),
    pos_z: t.f32(),
    rot_x: t.f32(),
    rot_y: t.f32(),
    rot_z: t.f32(),
    rot_w: t.f32(),
    scale_x: t.f32().default(1),
    scale_y: t.f32().default(1),
    scale_z: t.f32().default(1),
    anim_key: t.string().default('idle'),
    anim_pause_at_end: t.bool().default(false),
  },
);

/**
 * One row per browser device_id (localStorage). Links to entity_transform
 * for pose + nametag data, and carries per-player combat stats (HP and
 * chosen character class) so every peer can render nameplates and avatars
 * without additional client hand-shakes.
 */
export const player = table(
  { name: 'player', public: true },
  {
    device_id: t.string().primaryKey(),
    display_name: t.string(),
    color_u32: t.u32(),
    entity_id: t.u64().unique(),
    owner_identity: t.identity().unique(),
    character_class: t.string().default('tank'),
    hp: t.u32().default(100),
    max_hp: t.u32().default(100),
    spawn_x: t.f32().default(0),
    spawn_y: t.f32().default(0),
    spawn_z: t.f32().default(0),
  },
);

/**
 * Lightweight liveness ledger for the client-simulated enemies. The server
 * never stores enemy pose / HP / AI state — each row is just a
 * deterministic key every client derives independently (`wave:{n}:{slot}`
 * or `guest:{playerEntityId}`) plus an `alive` flag. A kill reported by
 * any client flips `alive` to false so every peer removes that enemy from
 * its local simulation, and late joiners skip spawning it.
 *
 * `wave:*` rows are pruned when the wave advances; `guest:*` rows are
 * pruned when their player disconnects.
 */
export const enemy_registry = table(
  { name: 'enemy_registry', public: true },
  {
    enemy_key: t.string().primaryKey(),
    alive: t.bool().default(true),
  },
);

/**
 * Singleton wave counter (`id` is always 0). Clients spawn their local
 * enemy waves from this shared index, so enemy keys and RNG seeds line up
 * across peers and late joiners start on the correct wave.
 */
export const arena_wave = table(
  { name: 'arena_wave', public: true },
  {
    id: t.u8().primaryKey(),
    wave_index: t.u32(),
  },
);

/**
 * The single shared SpacetimeDB schema instance. All reducer files import
 * this to register handlers; only one `schema(...)` call is allowed per
 * module.
 */
export const spacetime = schema({
  entity_transform,
  player,
  enemy_registry,
  arena_wave,
});

export type SpaceTimeSchema = InferSchema<typeof spacetime>;

export default spacetime;
