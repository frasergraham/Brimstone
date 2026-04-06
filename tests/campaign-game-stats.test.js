// Tests for campaign game stats: recording, querying, and aggregate stats.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { recordCampaignGameStats, getCampaignGameStats, getCampaignAggregateStats } from '../server/campaign-game-stats.js';
import { randomUUID } from 'crypto';

function makeStats(overrides = {}) {
  return {
    id: randomUUID(),
    campaign_id: 'calebs_hollow_prologue',
    mission_id: 'prologue',
    mission_title: 'The Awakening',
    winner: 'hero',
    win_reason: 'All enemies eliminated.',
    rounds: 6,
    final_phase: 'day',
    hero_kills: 3,
    witch_kills: 0,
    survivors_deployed: 1,
    survivors_lost: 0,
    enemies_spawned: 3,
    has_witch: 0,
    ai_personality: 'balanced',
    map_size: 'skirmish',
    game_version: '1.0.4',
    duration_ms: 90000,
    ...overrides,
  };
}

describe('campaign-game-stats DB module', () => {
  test('recordCampaignGameStats inserts and getCampaignGameStats retrieves', () => {
    const stats = makeStats();
    recordCampaignGameStats(stats);

    const rows = getCampaignGameStats({ limit: 1000 });
    const found = rows.find(r => r.id === stats.id);
    assert.ok(found, 'inserted campaign stats should be retrievable');
    assert.equal(found.winner, 'hero');
    assert.equal(found.campaign_id, 'calebs_hollow_prologue');
    assert.equal(found.mission_id, 'prologue');
    assert.equal(found.rounds, 6);
    assert.equal(found.hero_kills, 3);
  });

  test('getCampaignGameStats filters by campaign_id', () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    recordCampaignGameStats(makeStats({ id: id1, campaign_id: 'calebs_hollow_prologue' }));
    recordCampaignGameStats(makeStats({ id: id2, campaign_id: 'other_campaign' }));

    const results = getCampaignGameStats({ campaign_id: 'calebs_hollow_prologue', limit: 1000 });
    assert.ok(results.some(r => r.id === id1));
    assert.ok(!results.some(r => r.id === id2));
  });

  test('getCampaignGameStats filters by mission_id', () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    recordCampaignGameStats(makeStats({ id: id1, mission_id: 'prologue' }));
    recordCampaignGameStats(makeStats({ id: id2, mission_id: 'first_night' }));

    const results = getCampaignGameStats({ mission_id: 'prologue', limit: 1000 });
    assert.ok(results.some(r => r.id === id1));
    assert.ok(!results.some(r => r.id === id2));
  });

  test('getCampaignGameStats filters by winner', () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    recordCampaignGameStats(makeStats({ id: id1, winner: 'hero' }));
    recordCampaignGameStats(makeStats({ id: id2, winner: 'witch' }));

    const results = getCampaignGameStats({ winner: 'hero', limit: 1000 });
    assert.ok(results.some(r => r.id === id1));
    assert.ok(!results.some(r => r.id === id2));
  });

  test('getCampaignAggregateStats returns valid summary', () => {
    // Ensure some data exists
    recordCampaignGameStats(makeStats({ winner: 'hero', rounds: 5, mission_id: 'prologue' }));
    recordCampaignGameStats(makeStats({ winner: 'witch', rounds: 8, mission_id: 'first_night', mission_title: 'The First Night' }));
    recordCampaignGameStats(makeStats({ winner: 'hero', rounds: 12, mission_id: 'witchs_trail', mission_title: "The Witch's Trail" }));

    const agg = getCampaignAggregateStats();
    assert.ok(agg.totalAttempts >= 3, `totalAttempts should be >= 3, got ${agg.totalAttempts}`);
    assert.ok(Array.isArray(agg.byMission));
    assert.ok(agg.byMission.length > 0, 'byMission should have entries');
    assert.ok(Array.isArray(agg.byCampaign));
    assert.ok(Array.isArray(agg.byWinReason));
    assert.ok(typeof agg.avgRounds === 'number');
    assert.ok(agg.avgRounds > 0);
    assert.ok(typeof agg.avgHeroKills === 'number');
    assert.ok(typeof agg.avgWitchKills === 'number');
    assert.ok(typeof agg.avgSurvivorsDeployed === 'number');
    assert.ok(typeof agg.avgSurvivorsLost === 'number');
    assert.ok(typeof agg.avgEnemiesSpawned === 'number');
    assert.ok(Array.isArray(agg.recentGames));
  });

  test('byMission includes wins and losses counts', () => {
    const missionId = `test_mission_${randomUUID().slice(0, 8)}`;
    recordCampaignGameStats(makeStats({ mission_id: missionId, mission_title: 'Test Mission', winner: 'hero' }));
    recordCampaignGameStats(makeStats({ mission_id: missionId, mission_title: 'Test Mission', winner: 'hero' }));
    recordCampaignGameStats(makeStats({ mission_id: missionId, mission_title: 'Test Mission', winner: 'witch' }));

    const agg = getCampaignAggregateStats();
    const missionRow = agg.byMission.find(m => m.mission_id === missionId);
    assert.ok(missionRow, 'should find the test mission in byMission');
    assert.equal(missionRow.attempts, 3);
    assert.equal(missionRow.wins, 2);
    assert.equal(missionRow.losses, 1);
  });

  test('byCampaign groups by campaign_id', () => {
    const campaignId = `test_campaign_${randomUUID().slice(0, 8)}`;
    recordCampaignGameStats(makeStats({ campaign_id: campaignId, winner: 'hero' }));
    recordCampaignGameStats(makeStats({ campaign_id: campaignId, winner: 'witch' }));

    const agg = getCampaignAggregateStats();
    const campRow = agg.byCampaign.find(c => c.campaign_id === campaignId);
    assert.ok(campRow, 'should find the test campaign in byCampaign');
    assert.equal(campRow.total_attempts, 2);
    assert.equal(campRow.total_wins, 1);
    assert.equal(campRow.total_losses, 1);
  });
});
