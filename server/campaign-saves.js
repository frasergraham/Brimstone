// Campaign save CRUD — server-side backup for verified users.
// Facade over db.campaignSaves.
import db from './db.js';

export function upsertCampaignSave(playerId, saveSlot, stateJson, version) {
  db.campaignSaves.upsert({ playerId, saveSlot, stateJson, gameVersion: version });
}

export function getCampaignSave(playerId, saveSlot) {
  const row = db.campaignSaves.get(playerId, saveSlot);
  if (!row) return null;
  return {
    state: JSON.parse(row.state_json),
    gameVersion: row.game_version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export function getCampaignSaves(playerId) {
  return db.campaignSaves.list(playerId).map(row => ({
    saveSlot: row.save_slot,
    gameVersion: row.game_version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  }));
}

export function deleteCampaignSave(playerId, saveSlot) {
  db.campaignSaves.delete(playerId, saveSlot);
}
