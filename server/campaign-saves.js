// Campaign save CRUD — server-side backup for verified users.
import db from './db.js';

const _upsert = db.prepare(`
  INSERT INTO campaign_saves (player_id, save_slot, state_json, game_version, updated_at)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(player_id, save_slot) DO UPDATE SET
    state_json   = excluded.state_json,
    game_version = excluded.game_version,
    updated_at   = unixepoch()
`);

const _get = db.prepare(`
  SELECT state_json, game_version, updated_at, created_at
  FROM campaign_saves WHERE player_id = ? AND save_slot = ?
`);

const _getAll = db.prepare(`
  SELECT save_slot, game_version, updated_at, created_at
  FROM campaign_saves WHERE player_id = ?
  ORDER BY updated_at DESC
`);

const _delete = db.prepare(`
  DELETE FROM campaign_saves WHERE player_id = ? AND save_slot = ?
`);

export function upsertCampaignSave(playerId, saveSlot, stateJson, version) {
  _upsert.run(playerId, saveSlot, stateJson, version);
}

export function getCampaignSave(playerId, saveSlot) {
  const row = _get.get(playerId, saveSlot);
  if (!row) return null;
  return {
    state: JSON.parse(row.state_json),
    gameVersion: row.game_version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export function getCampaignSaves(playerId) {
  return _getAll.all(playerId).map(row => ({
    saveSlot: row.save_slot,
    gameVersion: row.game_version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  }));
}

export function deleteCampaignSave(playerId, saveSlot) {
  _delete.run(playerId, saveSlot);
}
