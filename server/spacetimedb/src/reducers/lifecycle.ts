import type { Identity } from 'spacetimedb';
import { spacetime } from '../schema';

/**
 * On client disconnect: remove the caller's player + transform rows so
 * peers stop rendering a ghost, along with the registry row for their
 * per-player guest iguano (keyed by the player's entity id).
 */
export const client_disconnected = spacetime.clientDisconnected((ctx) => {
  const id = ctx.sender as Identity;

  const found = ctx.db.player.owner_identity.find(id);
  if (found === null) {
    return;
  }
  const guestRow = ctx.db.enemy_registry.enemy_key.find(
    `guest:${found.entity_id}`,
  );
  if (guestRow !== null) {
    ctx.db.enemy_registry.delete(guestRow);
  }
  const trow = ctx.db.entity_transform.entity_id.find(found.entity_id);
  if (trow !== null) {
    ctx.db.entity_transform.delete(trow);
  }
  ctx.db.player.delete(found);
});
