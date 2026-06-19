// Continue-target resolution for the menu's Continue card — DOM-free so it can
// be unit-tested without the full app. The Continue card tracks ONE playthrough
// per campaign: the persisted *active slot* (the one the player last selected or
// started), defaulting to slot 1. We never scan every slot here — that's the
// fix for "Continue only ever sees slot 1": it now reads the active slot
// instead of hardcoding one.
//
// Pure-ish: reads localStorage through the injected Campaign class + active-slot
// helpers and the mission-save loader, all of which are themselves storage-only.

import { Campaign, getActiveSlot } from './campaign.js';
import { loadCampaignMissionSave } from './campaign-ui.js';

/**
 * 1-based position of a mission within its campaign's ordered mission list, or
 * null when the mission isn't part of the campaign.
 */
export function campaignMissionNumber(campaignDef, missionId) {
  const idx = (campaignDef?.missions || []).findIndex(m => m.id === missionId);
  return idx < 0 ? null : idx + 1;
}

/**
 * Resolve the single Continue target for one campaign, from its persisted active
 * slot. Returns null when that slot has no resumable progress (no save, or the
 * campaign is complete with nothing left to play).
 *
 * Shape: { slot, missionId, missionNumber, missionTotal, resume, updatedAt }.
 *  - `resume:true`  → a mid-mission save exists for that mission (jump back in).
 *  - `resume:false` → the next mission is ready to start fresh.
 *
 * @param {object} campaignDef          A campaign definition (id, missions[]).
 * @param {object} [deps]               Injectable seams (default to the real ones).
 * @param {Function} [deps.CampaignCls] Campaign class.
 * @param {Function} [deps.activeSlotFn] (campaignId) => slot index.
 * @param {Function} [deps.loadMissionSave] (campaignId, missionId, slot) => save|null.
 */
export function resolveCampaignContinue(campaignDef, deps = {}) {
  if (!campaignDef || campaignDef.disabled) return null;
  const CampaignCls   = deps.CampaignCls   || Campaign;
  const activeSlotFn  = deps.activeSlotFn  || getActiveSlot;
  const loadMission   = deps.loadMissionSave || loadCampaignMissionSave;

  const slot = activeSlotFn(campaignDef.id);
  const missionTotal = (campaignDef.missions || []).length;
  const c = new CampaignCls(campaignDef, slot);
  if (!c.load()) return null;             // active slot has no save → nothing to continue

  // A mid-mission save on the next-up (or current) mission means "resume".
  const nextId = c.getNextMission?.() ?? null;
  if (nextId && loadMission(campaignDef.id, nextId, slot)) {
    return {
      slot, missionId: nextId, resume: true,
      missionNumber: campaignMissionNumber(campaignDef, nextId),
      missionTotal, updatedAt: c.updatedAt ?? 0,
    };
  }

  // Otherwise, if the campaign isn't finished and a next mission exists, the
  // Continue target is that next mission (start fresh).
  if (c.isComplete?.()) return null;
  if (!nextId) return null;
  return {
    slot, missionId: nextId, resume: false,
    missionNumber: campaignMissionNumber(campaignDef, nextId),
    missionTotal, updatedAt: c.updatedAt ?? 0,
  };
}

/**
 * Whether ANY of the given campaigns has a Continue target in its active slot.
 * Drives the menu's "is there anything to continue?" decision (Task 6).
 */
export function hasCampaignToContinue(campaignDefs, deps = {}) {
  for (const def of campaignDefs || []) {
    if (resolveCampaignContinue(def, deps)) return true;
  }
  return false;
}
