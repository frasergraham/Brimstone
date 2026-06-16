// ═══════════════════════════════════════════════════════════════════════════
// Campaign Progression — admin-tools host (Caleb's Studio "Campaign" tab)
// ─────────────────────────────────────────────────────────────────────────────
// Loads every catalogued mission's gate/reward fields, builds the dependency DAG,
// and mounts the CampaignProgressionView. Save writes the edited requires/unlock/
// rewards back into each CHANGED mission JSON via the Studio file bridge
// (window.studioAPI) — offline, file-only, like the Mission Editor's Save to repo.
// ═══════════════════════════════════════════════════════════════════════════

import { MIGRATED_MISSIONS } from '../campaign/mission-catalog.js';
import { buildProgressionModel, nodeToMissionPatch } from './campaign-progression.js';
import { CampaignProgressionView } from './campaign-progression-view.js';

const missionUrl = (file) => `/src/campaign/missions/${file}.json`;
const missionPath = (file) => `src/campaign/missions/${file}.json`;

/**
 * Boot the Campaign Progression tab into #campaign-host.
 * @param {Document} doc
 * @param {{ onOpenMission?: (missionId:string)=>void }} [opts]
 * @returns {Promise<{ pause():void, resume():void, getModel():object }>}
 */
export async function initCampaignProgression(doc = document, { onOpenMission } = {}) {
  const host = doc.getElementById('campaign-host');
  if (!host) return { pause() {}, resume() {} };
  host.textContent = 'Loading campaign missions…';

  const missions = [];
  const fileById = new Map();
  for (const entry of MIGRATED_MISSIONS) {
    try {
      const res = await fetch(missionUrl(entry.file));
      const m = await res.json();
      const id = m.id ?? entry.id;
      missions.push({
        id, title: m.title ?? entry.title, chapter: m.chapter ?? 0,
        requires: m.requires, unlock: m.unlock, rewards: m.rewards,
      });
      fileById.set(id, entry.file);
    } catch { /* skip a mission that fails to load */ }
  }

  const model = buildProgressionModel(missions);
  const view = new CampaignProgressionView(host, model, {
    onOpenMission: (id) => onOpenMission?.(id),
    onSave: async (mdl) => { await saveProgression(mdl, fileById); },
    onAddMission: async ({ id, title }) => createMission({ id, title, missions, fileById }),
  });
  view.mount();
  return { pause() {}, resume() {}, getModel: () => model };
}

const SLUG = /^[a-z0-9_]+$/;

/** Create a new stub mission: write its JSON + register it in the catalog (Studio
 *  bridge), and return the summary for the campaign view to add as a node. */
async function createMission({ id, title, missions, fileById }) {
  const slug = String(id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug || !SLUG.test(slug)) throw new Error('Mission id must be a slug (letters, numbers, underscores).');
  if (missions.some((m) => m.id === slug)) throw new Error(`A mission with id “${slug}” already exists.`);
  if (!window.studioAPI?.writeFile) throw new Error('Creating missions needs Caleb’s Studio (the repo file bridge).');

  const niceTitle = (title || '').trim() || slug;
  const chapter = missions.reduce((m, x) => Math.max(m, x.chapter ?? 0), 1);
  const mission = stubMission(slug, niceTitle, chapter);

  const path = missionPath(slug); // new missions are stored as <id>.json
  const w = await window.studioAPI.writeFile(path, JSON.stringify(mission, null, 2) + '\n');
  if (!w.ok) throw new Error(`Could not write ${path}: ${w.error}`);
  await registerInCatalog(slug, niceTitle, slug);

  fileById.set(slug, slug);
  return { id: slug, title: niceTitle, chapter, requires: undefined, unlock: undefined, rewards: {} };
}

/** A minimal, valid, logic-graph-driven mission to start editing from. */
export function stubMission(id, title, chapter = 1) {
  return {
    schema: 1,
    campaignId: 'calebs_hollow_prologue',
    id,
    title,
    chapter,
    briefing: 'TODO: write the mission briefing.',
    hasWitch: false,
    mapSize: 'skirmish',
    map: { mode: 'handmade', cols: 10, rows: 10, heroStart: { col: 2, row: 7 }, tiles: [] },
    enemyUnits: [],
    rewards: {},
    logic: {
      version: 1, variables: [],
      nodes: [{ id: 'n0', type: 'comment', params: { text: `${title}\n\nBuild this mission’s logic here:\n• spawns, conversations, story beats\n• a Win condition (e.g. Faction Event → Win)\n(Hero death = loss is automatic.)` }, x: 40, y: 40 }],
      edges: [],
    },
  };
}

/** Append a catalog entry to mission-catalog.js (idempotent). */
async function registerInCatalog(id, title, file) {
  const path = 'src/campaign/mission-catalog.js';
  const r = await window.studioAPI.readFile(path);
  if (!r.ok) throw new Error(`Could not read the mission catalog: ${r.error}`);
  let src = r.text;
  if (new RegExp(`id:\\s*'${id}'`).test(src)) return; // already registered
  const entry = `  { id: '${id}', campaignId: 'calebs_hollow_prologue', title: ${JSON.stringify(title)}, file: '${file}' },\n`;
  src = src.replace(/\n\]\);/, `\n${entry}]);`);
  const w = await window.studioAPI.writeFile(path, src);
  if (!w.ok) throw new Error(`Could not update the mission catalog: ${w.error}`);
}

/** Write changed missions' gate/reward fields back to disk (Studio file bridge).
 *  Only rewrites a mission whose fields actually differ from on-disk. */
async function saveProgression(model, fileById) {
  if (!window.studioAPI?.readFile) {
    console.warn('[campaign] Save needs Caleb’s Studio (the repo file bridge) — open via studio:dev.');
    return { saved: 0, skipped: model.nodes.length, unavailable: true };
  }
  let saved = 0;
  for (const node of model.nodes) {
    const file = fileById.get(node.id);
    if (!file) continue;
    const path = missionPath(file);
    const r = await window.studioAPI.readFile(path);
    if (!r.ok) continue;
    const mission = JSON.parse(r.text);
    const patch = nodeToMissionPatch(node);
    const changed =
      JSON.stringify(mission.requires ?? undefined) !== JSON.stringify(patch.requires) ||
      JSON.stringify(mission.unlock ?? undefined) !== JSON.stringify(patch.unlock) ||
      JSON.stringify(mission.rewards ?? {}) !== JSON.stringify(patch.rewards);
    if (!changed) continue;
    if (patch.requires) mission.requires = patch.requires; else delete mission.requires;
    if (patch.unlock) mission.unlock = patch.unlock; else delete mission.unlock;
    mission.rewards = patch.rewards;
    await window.studioAPI.writeFile(path, JSON.stringify(mission, null, 2) + '\n');
    saved++;
  }
  return { saved };
}
