/**
 * SPEC-05: M1《中原逐鹿：虎牢—官渡战区》可玩垂直切片剧本生成器
 * 包含 64x44 精细地形高度图、黄河水系、太行/嵩山/崤山山脉、官道网、
 * 12 座核心都市 + 6 座咽喉关港、5 大可玩势力、核心名将及初始大地图内政建筑。
 */

import { getHexDistance, getHexNeighbors } from '../core/map/pathfinder.js';
import { deepClone } from '../core/utils/prng.js';
import { TERRAIN_ENUM } from './tacticsAndFormations.js';
import { GENTRY_CLANS } from './traitsAndClans.js';

export const MAP_WIDTH = 64;
export const MAP_HEIGHT = 44;

/**
 * 构建 64x44 中原核心战区地形与海拔高度图
 */
function buildCentralPlainsTerrain() {
  const size = MAP_WIDTH * MAP_HEIGHT;
  const terrain = new Array(size).fill(TERRAIN_ENUM.PLAIN);
  const elevation = new Array(size).fill(0.25);

  const setTile = (x, y, t, elev) => {
    if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) return;
    const idx = y * MAP_WIDTH + x;
    terrain[idx] = t;
    elevation[idx] = elev;
  };

  // 1. 生成自然森林与山脉脉络
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const n = Math.sin(x * 0.23) * Math.cos(y * 0.29) + Math.sin((x + y) * 0.14) * 0.5;
      if (n > 0.65) {
        setTile(x, y, TERRAIN_ENUM.FOREST, 0.35 + (n - 0.65) * 0.3);
      }
    }
  }

  // 2. 太行山脉 (分隔司隶/并州与冀州: x=20..30, y=2..17)
  for (let y = 1; y <= 17; y++) {
    for (let x = 20; x <= 26; x++) {
      if (y === 9 && x >= 22 && x <= 25) continue; // 留出壶关通道
      const isPeak = x >= 22 && x <= 24 && y % 3 !== 0;
      setTile(x, y, isPeak ? TERRAIN_ENUM.CLIFF : TERRAIN_ENUM.MOUNTAIN, isPeak ? 2.4 : 1.5);
    }
  }

  // 3. 崤山 / 秦岭北麓 / 函谷天险 (长安与洛阳之间: x=10..18, y=20..34)
  for (let y = 19; y <= 34; y++) {
    for (let x = 12; x <= 16; x++) {
      if (y === 24 || y === 25) continue; // 留出潼关狭道
      const isPeak = x === 14;
      setTile(x, y, isPeak ? TERRAIN_ENUM.CLIFF : TERRAIN_ENUM.MOUNTAIN, isPeak ? 2.5 : 1.6);
    }
  }

  // 4. 嵩山 / 虎牢关南北群山 (洛阳与陈留/许昌之间: x=26..30, y=21..30)
  for (let y = 21; y <= 30; y++) {
    for (let x = 27; x <= 29; x++) {
      if (y === 24 || y === 25) continue; // 虎牢关隘口
      setTile(x, y, x === 28 ? TERRAIN_ENUM.CLIFF : TERRAIN_ENUM.MOUNTAIN, x === 28 ? 2.2 : 1.45);
    }
  }

  // 5. 黄河九曲天堑 (自西向东横贯全图)
  for (let x = 0; x < MAP_WIDTH; x++) {
    let riverY = 20;
    if (x < 16) riverY = 20;
    else if (x < 28) riverY = 19;
    else if (x < 40) riverY = Math.round(19 - (x - 28) * 0.25); // 向东北折向白马/延津/濮阳
    else riverY = Math.round(16 - (x - 40) * 0.35);

    for (let dy = -1; dy <= 1; dy++) {
      setTile(x, riverY + dy, TERRAIN_ENUM.WATER, -0.35);
    }
  }

  // 6. 淮河与南方湿地 (汝南—寿春—徐州南翼)
  for (let x = 28; x < MAP_WIDTH; x++) {
    const huaiY = 38 + Math.round(Math.sin(x * 0.2) * 1.5);
    setTile(x, huaiY, TERRAIN_ENUM.WATER, -0.3);
    setTile(x, huaiY - 1, TERRAIN_ENUM.MARSH, 0.18);
  }

  // 7. 黄河三大战略渡口 (浅滩 FORD)
  const fords = [
    [34, 17], [34, 18], [34, 19], // 延津—官渡渡口走廊
    [39, 15], [39, 16], [39, 17], // 白马渡口走廊
    [22, 18], [22, 19], [22, 20], // 孟津渡口
  ];
  for (const [fx, fy] of fords) {
    setTile(fx, fy, TERRAIN_ENUM.FORD, 0.08);
  }

  // 8. 铺设帝国六边形连续官道网 (沿六边形共边相邻格连续铺设)
  const drawRoad = (x0, y0, x1, y1) => {
    let cx = x0;
    let cy = y0;
    let guard = 0;
    while ((cx !== x1 || cy !== y1) && guard++ < 200) {
      const idx = cy * MAP_WIDTH + cx;
      if (terrain[idx] !== TERRAIN_ENUM.WATER && terrain[idx] !== TERRAIN_ENUM.FORD) {
        terrain[idx] = TERRAIN_ENUM.ROAD;
        elevation[idx] = Math.min(elevation[idx], 0.32);
      }
      const neighbors = getHexNeighbors(cx, cy, MAP_WIDTH, MAP_HEIGHT);
      let best = neighbors[0];
      let bestDist = Infinity;
      for (const [nx, ny] of neighbors) {
        const d = getHexDistance(nx, ny, x1, y1) + Math.hypot(nx - x1, ny - y1) * 0.05;
        if (d < bestDist) {
          bestDist = d;
          best = [nx, ny];
        }
      }
      if (!best) break;
      cx = best[0];
      cy = best[1];
    }
    const endIdx = y1 * MAP_WIDTH + x1;
    if (terrain[endIdx] !== TERRAIN_ENUM.WATER) {
      terrain[endIdx] = TERRAIN_ENUM.ROAD;
      elevation[endIdx] = 0.28;
    }
  };

  // 西线：长安 (7,25) -> 潼关 (14,24) -> 洛阳 (21,24) -> 虎牢关 (28,24) -> 陈留 (35,23)
  drawRoad(7, 25, 14, 24);
  drawRoad(14, 24, 21, 24);
  drawRoad(21, 24, 28, 24);
  drawRoad(28, 24, 35, 23);

  // 中原核心线：陈留 (35,23) -> 许昌 (33,29) -> 宛城 (22,34) / 汝南 (36,36)
  drawRoad(35, 23, 33, 29);
  drawRoad(21, 24, 22, 34);
  drawRoad(33, 29, 22, 34);
  drawRoad(33, 29, 36, 36);

  // 官渡—河北线：陈留 (35,23) -> 官渡港 (34,20) -> 延津港 (34,16) -> 邺城 (32,10) -> 壶关 (24,9)
  drawRoad(35, 23, 34, 20);
  drawRoad(34, 20, 34, 16);
  drawRoad(34, 16, 32, 10);
  drawRoad(32, 10, 24, 9);

  // 兖州—徐淮线：陈留 (35,23) -> 白马港 (39,18) -> 濮阳 (43,19) -> 徐州 (51,26) -> 寿春 (48,35)
  drawRoad(35, 23, 39, 18);
  drawRoad(39, 18, 43, 19);
  drawRoad(43, 19, 51, 26);
  drawRoad(33, 29, 51, 26);
  drawRoad(51, 26, 48, 35);
  drawRoad(36, 36, 48, 35);

  // 河北东翼：邺城 (32,10) -> 平原 (45,11) -> 南皮 (52,6)
  drawRoad(32, 10, 45, 11);
  drawRoad(45, 11, 52, 6);
  drawRoad(43, 19, 45, 11);

  return { terrain, elevation };
}

/**
 * 生成初始游戏状态 GameState
 */
export function createCentralPlainsScenario(playerFactionId = 1) {
  const { terrain, elevation } = buildCentralPlainsTerrain();

  /** @type {Record<number, import('../core/types/index.js').FactionState>} */
  const factions = {
    1: {
      id: 1,
      name: '曹操',
      rulerOfficerId: 101,
      capitalSettlementId: 4, // 许昌
      color: '#2563eb',       // 魏武苍蓝
      bannerChar: '曹',
      courtRank: '司空·兖州牧',
      prestige: 520,
      activePolicy: 'TUNTIAN',
      relations: { 2: 25, 3: 10, 4: 20, 5: 45 },
    },
    2: {
      id: 2,
      name: '袁绍',
      rulerOfficerId: 201,
      capitalSettlementId: 7, // 邺城
      color: '#eab308',       // 河北明黄
      bannerChar: '袁',
      courtRank: '大将军·冀州牧',
      prestige: 640,
      activePolicy: 'NINE_RANK_CLAN',
      relations: { 1: 25, 3: 35, 4: 40, 5: 50 },
    },
    3: {
      id: 3,
      name: '吕布',
      rulerOfficerId: 301,
      capitalSettlementId: 6, // 濮阳
      color: '#dc2626',       // 无双赤红
      bannerChar: '吕',
      courtRank: '温侯·奋威将军',
      prestige: 340,
      activePolicy: 'BALANCED',
      relations: { 1: 10, 2: 35, 4: 15, 5: 30 },
    },
    4: {
      id: 4,
      name: '董卓',
      rulerOfficerId: 401,
      capitalSettlementId: 2, // 洛阳
      color: '#9333ea',       // 西凉暗紫
      bannerChar: '董',
      courtRank: '太师·郿侯',
      prestige: 380,
      activePolicy: 'BALANCED',
      relations: { 1: 20, 2: 20, 3: 15, 5: 15 },
    },
    5: {
      id: 5,
      name: '刘备',
      rulerOfficerId: 501,
      capitalSettlementId: 10, // 汝南
      color: '#16a34a',        // 汉室翠绿
      bannerChar: '刘',
      courtRank: '豫州牧·左将军',
      prestige: 490,
      activePolicy: 'BALANCED',
      relations: { 1: 45, 2: 50, 3: 30, 4: 15 },
    },
  };

  let plotIdCounter = 1;
  const makePlots = (settlementId, cx, cy, plotSpecs) =>
    plotSpecs.map(([dx, dy, type, level]) => ({
      id: plotIdCounter++,
      settlementId,
      type,
      level,
      x: cx + dx,
      y: cy + dy,
      durability: level * 300,
      maxDurability: level * 300,
      buildProgress: 100,
      isUpgrading: false,
    }));

  /** @type {Record<number, import('../core/types/index.js').SettlementState>} */
  const settlements = {
    // ================= 12 座核心都市 =================
    1: {
      id: 1,
      name: '长安',
      province: '司隶',
      type: 'MAJOR_CITY',
      factionId: 4,
      prefectOfficerId: 402, // 贾诩
      x: 7,
      y: 25,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [13, 3],
      troops: 26000,
      woundedTroops: 1200,
      morale: 86,
      gold: 9500,
      food: 68000,
      wallDurability: 3200,
      maxWallDurability: 3200,
      publicOrder: 82,
      pops: { freePeasants: 38000, clanRetainers: 14000, artisans: 9500, refugees: 2500 },
      controlRate: 88,
      dominantClanId: 'clan_henei_sima',
      logisticsRole: 'REAR_SUPPLY',
      arsenal: { infantryArms: 18000, crossbows: 12000, warhorses: 22000, batteringRams: 1, siegeTowers: 1, catapults: 1, warships: 0 },
      regionalBonuses: ['HORSE_PASTURE', 'METROPOLIS'],
      economicPlots: makePlots(1, 7, 25, [
        [-2, -1, 'FARM', 2],
        [-2, 1, 'MARKET', 2],
        [0, -2, 'STABLE', 3],
        [0, 2, 'BARRACKS', 2],
      ]),
    },
    2: {
      id: 2,
      name: '洛阳',
      province: '司隶',
      type: 'MAJOR_CITY',
      factionId: 4,
      prefectOfficerId: 401, // 董卓
      x: 21,
      y: 24,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [13, 14, 3],
      troops: 34000,
      woundedTroops: 2000,
      morale: 90,
      gold: 14000,
      food: 85000,
      wallDurability: 3600,
      maxWallDurability: 3600,
      publicOrder: 85,
      pops: { freePeasants: 46000, clanRetainers: 18000, artisans: 12000, refugees: 4000 },
      controlRate: 100,
      dominantClanId: 'clan_henei_sima',
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 24000, crossbows: 16000, warhorses: 26000, batteringRams: 2, siegeTowers: 2, catapults: 1, warships: 0 },
      regionalBonuses: ['METROPOLIS', 'HORSE_PASTURE'],
      economicPlots: makePlots(2, 21, 24, [
        [-2, -2, 'MARKET', 3],
        [-2, 2, 'FARM', 2],
        [2, -2, 'STABLE', 2],
        [0, 2, 'SMITHY', 2],
      ]),
    },
    3: {
      id: 3,
      name: '宛城',
      province: '荆北',
      type: 'MAJOR_CITY',
      factionId: 4,
      prefectOfficerId: 405, // 张绣
      x: 22,
      y: 34,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [2, 4, 1],
      troops: 19000,
      woundedTroops: 800,
      morale: 84,
      gold: 5800,
      food: 42000,
      wallDurability: 2400,
      maxWallDurability: 2400,
      publicOrder: 80,
      pops: { freePeasants: 28000, clanRetainers: 9000, artisans: 6500, refugees: 1800 },
      controlRate: 78,
      dominantClanId: 'clan_henei_sima',
      logisticsRole: 'BALANCED',
      arsenal: { infantryArms: 15000, crossbows: 9000, warhorses: 14000, batteringRams: 1, siegeTowers: 1, catapults: 0, warships: 0 },
      regionalBonuses: ['FERTILE_PLAIN'],
      economicPlots: makePlots(3, 22, 34, [
        [-2, 0, 'FARM', 2],
        [2, 0, 'BARRACKS', 2],
        [0, 2, 'STABLE', 1],
      ]),
    },
    4: {
      id: 4,
      name: '许昌',
      province: '豫州',
      type: 'MAJOR_CITY',
      factionId: 1,
      prefectOfficerId: 101, // 曹操
      x: 33,
      y: 29,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [5, 3, 10, 11],
      troops: 38000,
      woundedTroops: 1500,
      morale: 95,
      gold: 16500,
      food: 110000,
      wallDurability: 3200,
      maxWallDurability: 3200,
      publicOrder: 94,
      pops: { freePeasants: 52000, clanRetainers: 12000, artisans: 14000, refugees: 3500 },
      controlRate: 100,
      dominantClanId: 'clan_yingchuan_xun',
      logisticsRole: 'REAR_SUPPLY',
      arsenal: { infantryArms: 32000, crossbows: 24000, warhorses: 20000, batteringRams: 2, siegeTowers: 3, catapults: 2, warships: 1 },
      regionalBonuses: ['FERTILE_PLAIN', 'METROPOLIS'],
      economicPlots: makePlots(4, 33, 29, [
        [-2, -1, 'FARM', 3],
        [2, -1, 'MARKET', 3],
        [-2, 2, 'SMITHY', 2],
        [2, 2, 'BARRACKS', 3],
        [0, 2, 'WORKSHOP', 2],
      ]),
    },
    5: {
      id: 5,
      name: '陈留',
      province: '兖州',
      type: 'MAJOR_CITY',
      factionId: 1,
      prefectOfficerId: 102, // 夏侯惇
      x: 35,
      y: 23,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [4, 14, 15, 16],
      troops: 31000,
      woundedTroops: 1800,
      morale: 92,
      gold: 11000,
      food: 78000,
      wallDurability: 2900,
      maxWallDurability: 3000,
      publicOrder: 90,
      pops: { freePeasants: 41000, clanRetainers: 9500, artisans: 11000, refugees: 2000 },
      controlRate: 94,
      dominantClanId: 'clan_qiaojun_cao',
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 28000, crossbows: 20000, warhorses: 18000, batteringRams: 1, siegeTowers: 2, catapults: 1, warships: 1 },
      regionalBonuses: ['METROPOLIS'],
      economicPlots: makePlots(5, 35, 23, [
        [-2, 1, 'BARRACKS', 2],
        [2, 1, 'SMITHY', 2],
        [0, 2, 'FARM', 2],
        [2, -1, 'STABLE', 2],
      ]),
    },
    6: {
      id: 6,
      name: '濮阳',
      province: '兖州',
      type: 'MAJOR_CITY',
      factionId: 3,
      prefectOfficerId: 301, // 吕布
      x: 43,
      y: 19,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [16, 11, 8],
      troops: 29000,
      woundedTroops: 1100,
      morale: 92,
      gold: 8800,
      food: 64000,
      wallDurability: 2700,
      maxWallDurability: 2800,
      publicOrder: 83,
      pops: { freePeasants: 34000, clanRetainers: 11000, artisans: 8500, refugees: 2200 },
      controlRate: 100,
      dominantClanId: 'clan_qiaojun_cao',
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 22000, crossbows: 16000, warhorses: 28000, batteringRams: 1, siegeTowers: 1, catapults: 1, warships: 1 },
      regionalBonuses: ['HORSE_PASTURE'],
      economicPlots: makePlots(6, 43, 19, [
        [-2, 2, 'STABLE', 3],
        [2, 1, 'BARRACKS', 2],
        [2, -1, 'FARM', 2],
        [0, 2, 'SMITHY', 2],
      ]),
    },
    7: {
      id: 7,
      name: '邺城',
      province: '冀州',
      type: 'MAJOR_CITY',
      factionId: 2,
      prefectOfficerId: 201, // 袁绍
      x: 32,
      y: 10,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [17, 18, 8],
      troops: 44000,
      woundedTroops: 2400,
      morale: 90,
      gold: 19000,
      food: 125000,
      wallDurability: 3500,
      maxWallDurability: 3500,
      publicOrder: 91,
      pops: { freePeasants: 56000, clanRetainers: 24000, artisans: 15000, refugees: 1500 },
      controlRate: 100,
      dominantClanId: 'clan_runan_yuan',
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 36000, crossbows: 32000, warhorses: 26000, batteringRams: 2, siegeTowers: 4, catapults: 2, warships: 2 },
      regionalBonuses: ['METROPOLIS', 'HORSE_PASTURE'],
      economicPlots: makePlots(7, 32, 10, [
        [-2, -2, 'MARKET', 3],
        [2, -2, 'FARM', 3],
        [-2, 2, 'SMITHY', 3],
        [2, 2, 'STABLE', 2],
        [0, -2, 'WORKSHOP', 2],
      ]),
    },
    8: {
      id: 8,
      name: '平原',
      province: '冀州',
      type: 'MAJOR_CITY',
      factionId: 2,
      prefectOfficerId: 204, // 张郃
      x: 45,
      y: 11,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [7, 9, 6],
      troops: 23000,
      woundedTroops: 900,
      morale: 86,
      gold: 9200,
      food: 72000,
      wallDurability: 2500,
      maxWallDurability: 2500,
      publicOrder: 88,
      pops: { freePeasants: 36000, clanRetainers: 15000, artisans: 8000, refugees: 1000 },
      controlRate: 86,
      dominantClanId: 'clan_runan_yuan',
      logisticsRole: 'BALANCED',
      arsenal: { infantryArms: 20000, crossbows: 18000, warhorses: 16000, batteringRams: 1, siegeTowers: 2, catapults: 1, warships: 1 },
      regionalBonuses: ['FERTILE_PLAIN'],
      economicPlots: makePlots(8, 45, 11, [
        [-2, -1, 'FARM', 2],
        [2, -1, 'MARKET', 2],
        [0, -2, 'BARRACKS', 2],
      ]),
    },
    9: {
      id: 9,
      name: '南皮',
      province: '冀州',
      type: 'MAJOR_CITY',
      factionId: 2,
      prefectOfficerId: 206, // 审配
      x: 52,
      y: 6,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [8],
      troops: 20000,
      woundedTroops: 500,
      morale: 85,
      gold: 8400,
      food: 68000,
      wallDurability: 2400,
      maxWallDurability: 2400,
      publicOrder: 90,
      pops: { freePeasants: 32000, clanRetainers: 14000, artisans: 7500, refugees: 800 },
      controlRate: 82,
      dominantClanId: 'clan_runan_yuan',
      logisticsRole: 'REAR_SUPPLY',
      arsenal: { infantryArms: 18000, crossbows: 16000, warhorses: 18000, batteringRams: 1, siegeTowers: 1, catapults: 1, warships: 0 },
      regionalBonuses: ['HORSE_PASTURE'],
      economicPlots: makePlots(9, 52, 6, [
        [-2, 0, 'FARM', 3],
        [2, 0, 'STABLE', 2],
        [0, 2, 'MARKET', 2],
      ]),
    },
    10: {
      id: 10,
      name: '汝南',
      province: '豫州',
      type: 'MAJOR_CITY',
      factionId: 5,
      prefectOfficerId: 501, // 刘备
      x: 36,
      y: 36,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [4, 12],
      troops: 26000,
      woundedTroops: 1000,
      morale: 94,
      gold: 9600,
      food: 66000,
      wallDurability: 2600,
      maxWallDurability: 2600,
      publicOrder: 95,
      pops: { freePeasants: 38000, clanRetainers: 11000, artisans: 9000, refugees: 3200 },
      controlRate: 100,
      dominantClanId: 'clan_runan_yuan',
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 24000, crossbows: 15000, warhorses: 18000, batteringRams: 1, siegeTowers: 1, catapults: 1, warships: 1 },
      regionalBonuses: ['FERTILE_PLAIN'],
      economicPlots: makePlots(10, 36, 36, [
        [-2, -1, 'FARM', 2],
        [2, -1, 'BARRACKS', 3],
        [-2, 1, 'MARKET', 2],
        [2, 1, 'SMITHY', 2],
      ]),
    },
    11: {
      id: 11,
      name: '徐州',
      province: '徐州',
      type: 'MAJOR_CITY',
      factionId: 3,
      prefectOfficerId: 303, // 陈宫
      x: 51,
      y: 26,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [6, 4, 12],
      troops: 22000,
      woundedTroops: 900,
      morale: 86,
      gold: 11500,
      food: 74000,
      wallDurability: 2700,
      maxWallDurability: 2800,
      publicOrder: 86,
      pops: { freePeasants: 40000, clanRetainers: 13000, artisans: 9500, refugees: 1800 },
      controlRate: 88,
      dominantClanId: 'clan_xuzhou_mi',
      logisticsRole: 'REAR_SUPPLY',
      arsenal: { infantryArms: 20000, crossbows: 16000, warhorses: 14000, batteringRams: 1, siegeTowers: 2, catapults: 1, warships: 1 },
      regionalBonuses: ['FERTILE_PLAIN', 'METROPOLIS'],
      economicPlots: makePlots(11, 51, 26, [
        [-2, -1, 'MARKET', 3],
        [2, -1, 'FARM', 3],
        [0, 2, 'SMITHY', 2],
      ]),
    },
    12: {
      id: 12,
      name: '寿春',
      province: '淮南',
      type: 'MAJOR_CITY',
      factionId: 5,
      prefectOfficerId: 502, // 关羽
      x: 48,
      y: 35,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [10, 11],
      troops: 21000,
      woundedTroops: 800,
      morale: 92,
      gold: 8500,
      food: 62000,
      wallDurability: 2500,
      maxWallDurability: 2500,
      publicOrder: 90,
      pops: { freePeasants: 35000, clanRetainers: 9000, artisans: 8000, refugees: 2000 },
      controlRate: 90,
      dominantClanId: 'clan_xuzhou_mi',
      logisticsRole: 'REAR_SUPPLY',
      arsenal: { infantryArms: 20000, crossbows: 14000, warhorses: 12000, batteringRams: 1, siegeTowers: 1, catapults: 1, warships: 2 },
      regionalBonuses: ['FERTILE_PLAIN', 'NAVAL_HUB'],
      economicPlots: makePlots(12, 48, 35, [
        [-2, -1, 'FARM', 3],
        [2, -1, 'MARKET', 2],
        [0, -2, 'SMITHY', 2],
      ]),
    },

    // ================= 6 座咽喉关隘与黄河渡口 =================
    13: {
      id: 13,
      name: '潼关',
      province: '司隶',
      type: 'PASS',
      factionId: 4,
      prefectOfficerId: 404,
      x: 14,
      y: 24,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [1, 2],
      troops: 12000,
      woundedTroops: 400,
      morale: 88,
      gold: 2000,
      food: 24000,
      wallDurability: 2800,
      maxWallDurability: 2800,
      publicOrder: 90,
      pops: { freePeasants: 6000, clanRetainers: 1000, artisans: 1000, refugees: 200 },
      controlRate: 95,
      dominantClanId: null,
      logisticsRole: 'BALANCED',
      arsenal: { infantryArms: 10000, crossbows: 12000, warhorses: 6000, batteringRams: 0, siegeTowers: 1, catapults: 1, warships: 0 },
      regionalBonuses: [],
      economicPlots: [],
    },
    14: {
      id: 14,
      name: '虎牢关',
      province: '司隶',
      type: 'PASS',
      factionId: 4,
      prefectOfficerId: 403, // 华雄
      x: 28,
      y: 24,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [2, 5],
      troops: 15000,
      woundedTroops: 600,
      morale: 90,
      gold: 2500,
      food: 30000,
      wallDurability: 3000,
      maxWallDurability: 3000,
      publicOrder: 90,
      pops: { freePeasants: 8000, clanRetainers: 1000, artisans: 1500, refugees: 500 },
      controlRate: 92,
      dominantClanId: null,
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 14000, crossbows: 14000, warhorses: 12000, batteringRams: 0, siegeTowers: 1, catapults: 1, warships: 0 },
      regionalBonuses: [],
      economicPlots: [],
    },
    15: {
      id: 15,
      name: '官渡港',
      province: '兖州',
      type: 'PORT',
      factionId: 1,
      prefectOfficerId: 105, // 于禁
      x: 34,
      y: 20,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [5, 17],
      troops: 14000,
      woundedTroops: 500,
      morale: 92,
      gold: 3000,
      food: 32000,
      wallDurability: 2200,
      maxWallDurability: 2200,
      publicOrder: 90,
      pops: { freePeasants: 9000, clanRetainers: 1500, artisans: 2000, refugees: 400 },
      controlRate: 95,
      dominantClanId: null,
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 14000, crossbows: 14000, warhorses: 8000, batteringRams: 0, siegeTowers: 1, catapults: 1, warships: 2 },
      regionalBonuses: ['NAVAL_HUB'],
      economicPlots: [],
    },
    16: {
      id: 16,
      name: '白马港',
      province: '兖州',
      type: 'PORT',
      factionId: 1,
      prefectOfficerId: 106, // 乐进
      x: 39,
      y: 18,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [5, 6],
      troops: 11000,
      woundedTroops: 300,
      morale: 90,
      gold: 2200,
      food: 24000,
      wallDurability: 1900,
      maxWallDurability: 2000,
      publicOrder: 88,
      pops: { freePeasants: 7500, clanRetainers: 1000, artisans: 1500, refugees: 300 },
      controlRate: 92,
      dominantClanId: null,
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 12000, crossbows: 12000, warhorses: 6000, batteringRams: 0, siegeTowers: 1, catapults: 0, warships: 2 },
      regionalBonuses: ['NAVAL_HUB'],
      economicPlots: [],
    },
    17: {
      id: 17,
      name: '延津港',
      province: '冀州',
      type: 'PORT',
      factionId: 2,
      prefectOfficerId: 202, // 颜良
      x: 34,
      y: 16,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [7, 15],
      troops: 16000,
      woundedTroops: 500,
      morale: 88,
      gold: 2800,
      food: 35000,
      wallDurability: 2100,
      maxWallDurability: 2200,
      publicOrder: 88,
      pops: { freePeasants: 8500, clanRetainers: 2000, artisans: 1500, refugees: 300 },
      controlRate: 90,
      dominantClanId: null,
      logisticsRole: 'FRONTLINE_DEMAND',
      arsenal: { infantryArms: 16000, crossbows: 14000, warhorses: 12000, batteringRams: 1, siegeTowers: 1, catapults: 1, warships: 2 },
      regionalBonuses: ['NAVAL_HUB'],
      economicPlots: [],
    },
    18: {
      id: 18,
      name: '壶关',
      province: '冀州',
      type: 'PASS',
      factionId: 2,
      prefectOfficerId: 205, // 高览
      x: 24,
      y: 9,
      footprintOffsets: [[0, 0]],
      zocRadius: 2,
      connectedSettlementIds: [7],
      troops: 11000,
      woundedTroops: 300,
      morale: 86,
      gold: 1800,
      food: 22000,
      wallDurability: 2600,
      maxWallDurability: 2600,
      publicOrder: 90,
      pops: { freePeasants: 5500, clanRetainers: 1000, artisans: 1000, refugees: 100 },
      controlRate: 90,
      dominantClanId: null,
      logisticsRole: 'BALANCED',
      arsenal: { infantryArms: 10000, crossbows: 10000, warhorses: 6000, batteringRams: 0, siegeTowers: 1, catapults: 0, warships: 0 },
      regionalBonuses: [],
      economicPlots: [],
    },
  };

  /**
   * 辅助创建武将对象
   */
  const makeOfficer = ({
    id,
    name,
    courtesyName,
    factionId,
    settlementId,
    ldr,
    mgt,
    int,
    pol,
    compat,
    office,
    tactics,
    traits = [],
    personalities = ['CAUTIOUS'],
    clanId = null,
    bloodLineId = null,
    swornBrotherIds = [],
    nemesisIds = [],
    hooks = [],
  }) => ({
    id,
    name,
    courtesyName,
    factionId,
    locationSettlementId: settlementId,
    assignedUnitId: null,
    status: 'ACTIVE',
    hasActedThisXun: false,
    leadership: ldr,
    might: mgt,
    intelligence: int,
    politics: pol,
    courtOfficeId: office,
    loyalty: 95,
    ambition: 75,
    duty: 80,
    compatibility: compat,
    proficiencies: {
      INFANTRY: 420,
      CAVALRY: 420,
      HORSE_ARCHER: 320,
      CROSSBOW: 380,
      NAVAL: 250,
      SIEGE: 350,
      KNOWLEDGE: 380,
      STRATAGEM: 380,
      STRATEGY: 350,
    },
    learnedTactics: tactics,
    passiveTraits: traits,
    personalities,
    clanId,
    bloodLineId,
    swornBrotherIds,
    nemesisIds,
    hooks,
  });

  /** @type {Record<number, import('../core/types/index.js').OfficerState>} */
  const officers = {
    // ================= 1. 曹操势力 (相性 ~25, 曹夏侯血亲组 1) =================
    101: makeOfficer({
      id: 101, name: '曹操', courtesyName: '孟德', factionId: 1, settlementId: 4,
      ldr: 99, mgt: 72, int: 92, pol: 94, compat: 25, office: '丞相·魏公',
      tactics: ['cav_3', 'inf_3', 'xbow_3', 'knw_3', 'str_3', 'pol_2'],
      traits: ['tuntian_master', 'divine_calc'],
      personalities: ['RUTHLESS', 'AMBITIOUS'],
      clanId: 'clan_qiaojun_cao', bloodLineId: 1, swornBrotherIds: [102, 103], nemesisIds: [301, 401],
    }),
    102: makeOfficer({
      id: 102, name: '夏侯惇', courtesyName: '元让', factionId: 1, settlementId: 5,
      ldr: 90, mgt: 91, int: 60, pol: 70, compat: 25, office: '大将军',
      tactics: ['cav_3', 'inf_3', 'har_2'],
      traits: ['gallop', 'fierce_vanguard'],
      personalities: ['RECKLESS', 'LOYAL'],
      clanId: 'clan_qiaojun_cao', bloodLineId: 1, swornBrotherIds: [101, 103, 104], nemesisIds: [301, 302],
    }),
    103: makeOfficer({
      id: 103, name: '夏侯渊', courtesyName: '妙才', factionId: 1, settlementId: 5,
      ldr: 91, mgt: 91, int: 55, pol: 61, compat: 25, office: '征西将军',
      tactics: ['cav_3', 'har_3', 'xbow_3'],
      traits: ['gallop', 'archer_god'],
      personalities: ['RECKLESS', 'LOYAL'],
      clanId: 'clan_qiaojun_cao', bloodLineId: 1, swornBrotherIds: [101, 102, 104], nemesisIds: [301],
    }),
    104: makeOfficer({
      id: 104, name: '曹仁', courtesyName: '子孝', factionId: 1, settlementId: 5,
      ldr: 92, mgt: 88, int: 68, pol: 64, compat: 25, office: '车骑将军',
      tactics: ['inf_3', 'cav_2', 'xbow_2', 'siege_2'],
      traits: ['iron_wall'],
      personalities: ['CAUTIOUS', 'LOYAL'],
      clanId: 'clan_qiaojun_cao', bloodLineId: 1, swornBrotherIds: [101, 102, 103], nemesisIds: [],
    }),
    105: makeOfficer({
      id: 105, name: '于禁', courtesyName: '文则', factionId: 1, settlementId: 15,
      ldr: 86, mgt: 78, int: 72, pol: 65, compat: 26, office: '左将军',
      tactics: ['inf_2', 'xbow_3', 'siege_2'],
      traits: ['iron_wall'],
      personalities: ['CAUTIOUS'],
    }),
    106: makeOfficer({
      id: 106, name: '乐进', courtesyName: '文谦', factionId: 1, settlementId: 16,
      ldr: 85, mgt: 86, int: 58, pol: 54, compat: 26, office: '右将军',
      tactics: ['inf_3', 'siege_1', 'xbow_2'],
      traits: ['fierce_vanguard'],
      personalities: ['RECKLESS', 'LOYAL'],
    }),
    107: makeOfficer({
      id: 107, name: '典韦', courtesyName: '古之恶来', factionId: 1, settlementId: 4,
      ldr: 81, mgt: 97, int: 35, pol: 29, compat: 25, office: '虎贲中郎将',
      tactics: ['inf_3', 'cav_2'],
      traits: ['fierce_vanguard'],
      personalities: ['LOYAL', 'RECKLESS'],
      swornBrotherIds: [108], nemesisIds: [402, 405],
    }),
    108: makeOfficer({
      id: 108, name: '许褚', courtesyName: '仲康', factionId: 1, settlementId: 4,
      ldr: 82, mgt: 96, int: 36, pol: 28, compat: 25, office: '武卫中郎将',
      tactics: ['inf_3', 'cav_2'],
      traits: ['fierce_vanguard'],
      personalities: ['LOYAL', 'RECKLESS'],
      swornBrotherIds: [107], nemesisIds: [301],
    }),
    109: makeOfficer({
      id: 109, name: '荀彧', courtesyName: '文若', factionId: 1, settlementId: 4,
      ldr: 72, mgt: 24, int: 95, pol: 99, compat: 25, office: '尚书令',
      tactics: ['xbow_2', 'knw_3', 'str_3', 'pol_2'],
      traits: ['king_advisor'],
      personalities: ['CAUTIOUS', 'BENEVOLENT'],
      clanId: 'clan_yingchuan_xun', bloodLineId: 11,
    }),
    110: makeOfficer({
      id: 110, name: '郭嘉', courtesyName: '奉孝', factionId: 1, settlementId: 5,
      ldr: 80, mgt: 18, int: 98, pol: 85, compat: 25, office: '军师祭酒',
      tactics: ['knw_3', 'str_3', 'pol_2', 'pol_3'],
      traits: ['divine_calc'],
      personalities: ['CAUTIOUS'],
      clanId: 'clan_yingchuan_xun', swornBrotherIds: [109, 111],
    }),
    111: makeOfficer({
      id: 111, name: '荀攸', courtesyName: '公达', factionId: 1, settlementId: 4,
      ldr: 78, mgt: 26, int: 94, pol: 88, compat: 25, office: '中军师',
      tactics: ['xbow_2', 'siege_3', 'knw_3', 'str_3', 'pol_3'],
      traits: ['divine_calc'],
      personalities: ['CAUTIOUS'],
      clanId: 'clan_yingchuan_xun', bloodLineId: 11, swornBrotherIds: [109, 110],
    }),
    112: makeOfficer({
      id: 112, name: '徐晃', courtesyName: '公明', factionId: 1, settlementId: 4,
      ldr: 91, mgt: 90, int: 74, pol: 62, compat: 26, office: '平寇将军',
      tactics: ['inf_3', 'cav_2', 'xbow_2', 'siege_2'],
      traits: ['iron_wall'],
      personalities: ['CAUTIOUS', 'LOYAL'],
    }),

    // ================= 2. 袁绍势力 (相性 ~100, 袁氏血亲组 2) =================
    201: makeOfficer({
      id: 201, name: '袁绍', courtesyName: '本初', factionId: 2, settlementId: 7,
      ldr: 85, mgt: 69, int: 70, pol: 76, compat: 101, office: '大将军',
      tactics: ['xbow_3', 'inf_2', 'siege_3', 'pol_2'],
      traits: ['archer_god'],
      personalities: ['AMBITIOUS'],
      clanId: 'clan_runan_yuan', bloodLineId: 2, nemesisIds: [101, 401],
    }),
    202: makeOfficer({
      id: 202, name: '颜良', courtesyName: '河北上将', factionId: 2, settlementId: 17,
      ldr: 87, mgt: 94, int: 42, pol: 31, compat: 100, office: '前将军',
      tactics: ['cav_3', 'inf_3', 'har_2'],
      traits: ['gallop', 'fierce_vanguard'],
      personalities: ['RECKLESS', 'LOYAL'],
      swornBrotherIds: [203], nemesisIds: [502, 102],
    }),
    203: makeOfficer({
      id: 203, name: '文丑', courtesyName: '河北名将', factionId: 2, settlementId: 7,
      ldr: 86, mgt: 93, int: 40, pol: 30, compat: 100, office: '后将军',
      tactics: ['cav_3', 'har_3', 'xbow_2'],
      traits: ['gallop', 'archer_god'],
      personalities: ['RECKLESS', 'LOYAL'],
      swornBrotherIds: [202], nemesisIds: [502, 103],
    }),
    204: makeOfficer({
      id: 204, name: '张郃', courtesyName: '儁乂', factionId: 2, settlementId: 8,
      ldr: 90, mgt: 89, int: 72, pol: 60, compat: 98, office: '宁国中郎将',
      tactics: ['inf_3', 'cav_3', 'xbow_3', 'siege_2'],
      traits: ['iron_wall'],
      personalities: ['CAUTIOUS'],
      swornBrotherIds: [205],
    }),
    205: makeOfficer({
      id: 205, name: '高览', courtesyName: '河北四庭柱', factionId: 2, settlementId: 18,
      ldr: 82, mgt: 84, int: 56, pol: 50, compat: 100, office: '偏将军',
      tactics: ['inf_2', 'cav_2', 'xbow_2'],
      traits: ['iron_wall'],
      personalities: ['CAUTIOUS'],
      swornBrotherIds: [204],
    }),
    206: makeOfficer({
      id: 206, name: '审配', courtesyName: '正南', factionId: 2, settlementId: 9,
      ldr: 82, mgt: 60, int: 84, pol: 82, compat: 102, office: '治中别驾',
      tactics: ['xbow_3', 'siege_3', 'str_2', 'pol_2'],
      traits: ['iron_wall', 'archer_god'],
      personalities: ['LOYAL', 'RUTHLESS'],
    }),
    207: makeOfficer({
      id: 207, name: '沮授', courtesyName: '公与', factionId: 2, settlementId: 7,
      ldr: 86, mgt: 35, int: 92, pol: 88, compat: 100, office: '监军奋威将军',
      tactics: ['xbow_3', 'siege_3', 'knw_3', 'str_3', 'pol_3'],
      traits: ['divine_calc', 'king_advisor'],
      personalities: ['CAUTIOUS', 'LOYAL'],
      swornBrotherIds: [208],
    }),
    208: makeOfficer({
      id: 208, name: '田丰', courtesyName: '元皓', factionId: 2, settlementId: 7,
      ldr: 78, mgt: 30, int: 94, pol: 90, compat: 100, office: '冀州别驾',
      tactics: ['siege_3', 'knw_3', 'str_3', 'pol_2'],
      traits: ['divine_calc'],
      personalities: ['CAUTIOUS', 'LOYAL'],
      swornBrotherIds: [207],
    }),

    // ================= 3. 吕布势力 (相性 ~145) =================
    301: makeOfficer({
      id: 301, name: '吕布', courtesyName: '奉先', factionId: 3, settlementId: 6,
      ldr: 91, mgt: 100, int: 28, pol: 18, compat: 145, office: '温侯·左将军',
      tactics: ['cav_3', 'har_3', 'inf_3'],
      traits: ['flying_general', 'gallop'],
      personalities: ['RECKLESS', 'AMBITIOUS'],
      swornBrotherIds: [302, 304], nemesisIds: [101, 102, 401, 503],
    }),
    302: makeOfficer({
      id: 302, name: '高顺', courtesyName: '陷阵统帅', factionId: 3, settlementId: 6,
      ldr: 89, mgt: 87, int: 62, pol: 58, compat: 144, office: '陷阵营都督',
      tactics: ['inf_3', 'cav_3', 'siege_1'],
      traits: ['fierce_vanguard', 'iron_wall'],
      personalities: ['LOYAL', 'CAUTIOUS'],
      swornBrotherIds: [301, 304], nemesisIds: [102],
    }),
    303: makeOfficer({
      id: 303, name: '陈宫', courtesyName: '公台', factionId: 3, settlementId: 11,
      ldr: 82, mgt: 55, int: 90, pol: 84, compat: 142, office: '军师将军',
      tactics: ['xbow_2', 'siege_3', 'knw_3', 'str_3', 'pol_2'],
      traits: ['divine_calc'],
      personalities: ['CAUTIOUS', 'LOYAL'],
      swornBrotherIds: [301, 302], nemesisIds: [101],
    }),
    304: makeOfficer({
      id: 304, name: '张辽', courtesyName: '文远', factionId: 3, settlementId: 6,
      ldr: 94, mgt: 93, int: 78, pol: 68, compat: 140, office: '北地太守',
      tactics: ['cav_3', 'inf_3', 'har_2', 'knw_1'],
      traits: ['gallop', 'fierce_vanguard'],
      personalities: ['LOYAL', 'CAUTIOUS'],
      swornBrotherIds: [301, 302, 502],
    }),
    305: makeOfficer({
      id: 305, name: '臧霸', courtesyName: '宣高', factionId: 3, settlementId: 11,
      ldr: 83, mgt: 84, int: 62, pol: 60, compat: 142, office: '琅琊相',
      tactics: ['inf_3', 'cav_2', 'xbow_2'],
      traits: ['fierce_vanguard'],
      personalities: ['RECKLESS'],
      swornBrotherIds: [301, 302],
    }),

    // ================= 4. 董卓/西凉军势力 (相性 ~1) =================
    401: makeOfficer({
      id: 401, name: '董卓', courtesyName: '仲颖', factionId: 4, settlementId: 2,
      ldr: 86, mgt: 88, int: 66, pol: 45, compat: 1, office: '太师·相国',
      tactics: ['cav_3', 'har_3', 'inf_2', 'pol_1'],
      traits: ['gallop'],
      personalities: ['RUTHLESS', 'AMBITIOUS'],
      bloodLineId: 4, swornBrotherIds: [403, 404], nemesisIds: [101, 201, 301],
    }),
    402: makeOfficer({
      id: 402, name: '贾诩', courtesyName: '文和', factionId: 4, settlementId: 1,
      ldr: 86, mgt: 48, int: 98, pol: 88, compat: 5, office: '尚书·军师',
      tactics: ['knw_3', 'str_4', 'str_3', 'pol_2'],
      traits: ['divine_calc'],
      personalities: ['CAUTIOUS'],
      swornBrotherIds: [405],
    }),
    403: makeOfficer({
      id: 403, name: '华雄', courtesyName: '西凉猛将', factionId: 4, settlementId: 14,
      ldr: 85, mgt: 93, int: 46, pol: 34, compat: 2, office: '骁骑校尉',
      tactics: ['cav_3', 'inf_3', 'har_2'],
      traits: ['gallop', 'fierce_vanguard'],
      personalities: ['RECKLESS'],
      swornBrotherIds: [401, 404], nemesisIds: [502, 102],
    }),
    404: makeOfficer({
      id: 404, name: '徐荣', courtesyName: '玄菟名将', factionId: 4, settlementId: 13,
      ldr: 90, mgt: 84, int: 76, pol: 60, compat: 4, office: '中郎将',
      tactics: ['cav_3', 'inf_3', 'xbow_3', 'knw_2'],
      traits: ['iron_wall', 'gallop'],
      personalities: ['CAUTIOUS', 'LOYAL'],
      swornBrotherIds: [401, 403],
    }),
    405: makeOfficer({
      id: 405, name: '张绣', courtesyName: '北地枪王', factionId: 4, settlementId: 3,
      ldr: 84, mgt: 85, int: 68, pol: 58, compat: 4, office: '建忠将军',
      tactics: ['cav_3', 'har_2', 'inf_2'],
      traits: ['gallop'],
      personalities: ['AMBITIOUS'],
      swornBrotherIds: [402], nemesisIds: [107],
    }),

    // ================= 5. 刘备势力 (相性 ~75, 桃园义兄弟) =================
    501: makeOfficer({
      id: 501, name: '刘备', courtesyName: '玄德', factionId: 5, settlementId: 10,
      ldr: 84, mgt: 78, int: 76, pol: 82, compat: 75, office: '左将军·豫州牧',
      tactics: ['inf_3', 'cav_2', 'xbow_2', 'knw_3', 'pol_2', 'pol_3'],
      traits: ['king_advisor'],
      personalities: ['BENEVOLENT', 'LOYAL'],
      swornBrotherIds: [502, 503, 504], nemesisIds: [401],
    }),
    502: makeOfficer({
      id: 502, name: '关羽', courtesyName: '云长', factionId: 5, settlementId: 12,
      ldr: 97, mgt: 98, int: 78, pol: 64, compat: 75, office: '荡寇将军',
      tactics: ['inf_3', 'cav_3', 'nav_2'],
      traits: ['flying_general', 'fierce_vanguard'],
      personalities: ['LOYAL', 'RECKLESS'],
      swornBrotherIds: [501, 503, 504, 304], nemesisIds: [403, 202],
    }),
    503: makeOfficer({
      id: 503, name: '张飞', courtesyName: '翼德', factionId: 5, settlementId: 10,
      ldr: 90, mgt: 99, int: 38, pol: 24, compat: 75, office: '征虏将军',
      tactics: ['inf_3', 'cav_3', 'pol_1'],
      traits: ['fierce_vanguard', 'gallop'],
      personalities: ['RECKLESS', 'LOYAL'],
      swornBrotherIds: [501, 502, 504], nemesisIds: [301],
    }),
    504: makeOfficer({
      id: 504, name: '赵云', courtesyName: '子龙', factionId: 5, settlementId: 10,
      ldr: 93, mgt: 97, int: 77, pol: 66, compat: 75, office: '牙门将军',
      tactics: ['cav_3', 'har_3', 'inf_3', 'xbow_2'],
      traits: ['gallop', 'iron_wall'],
      personalities: ['CAUTIOUS', 'LOYAL'],
      swornBrotherIds: [501, 502, 503],
    }),
    505: makeOfficer({
      id: 505, name: '陈到', courtesyName: '叔至(白毦统领)', factionId: 5, settlementId: 12,
      ldr: 85, mgt: 86, int: 68, pol: 60, compat: 75, office: '护军',
      tactics: ['inf_3', 'xbow_2'],
      traits: ['iron_wall', 'fierce_vanguard'],
      personalities: ['CAUTIOUS', 'LOYAL'],
      swornBrotherIds: [504],
    }),
    506: makeOfficer({
      id: 506, name: '糜竺', courtesyName: '子仲', factionId: 5, settlementId: 10,
      ldr: 52, mgt: 34, int: 76, pol: 88, compat: 75, office: '安汉将军',
      tactics: ['xbow_2', 'pol_2', 'pol_3'],
      traits: ['king_advisor'],
      personalities: ['BENEVOLENT', 'LOYAL'],
      clanId: 'clan_xuzhou_mi',
    }),
  };

  // 初始野外驻防与对峙部队 (让玩家一进游戏就能直观看到大地图行军与兵法联动战斗!)
  /** @type {Record<number, import('../core/types/index.js').UnitState>} */
  const units = {
    1: {
      id: 1,
      factionId: 1,
      originSettlementId: 5, // 陈留
      formationId: 'FISH_SCALE',
      slots: [
        { officerId: 102, row: 'FRONT', isCommander: true },  // 夏侯惇
        { officerId: 103, row: 'FRONT', isCommander: false }, // 夏侯渊
        { officerId: 104, row: 'FRONT', isCommander: false }, // 曹仁
        { officerId: 110, row: 'REAR', isCommander: false },  // 郭嘉
      ],
      troops: 18000,
      wounded: 500,
      morale: 95,
      goldCarried: 800,
      foodCarried: 28000,
      x: 32,
      y: 24,
      order: {
        type: 'MARCH_AND_ATTACK',
        targetX: 28,
        targetY: 24,
        targetSettlementId: 14, // 进逼虎牢关
        path: [[31, 24], [30, 24], [29, 24], [28, 24]],
      },
      statusEffect: 'NORMAL',
      statusDurationTicks: 0,
      lastTacticBanner: null,
    },
    2: {
      id: 2,
      factionId: 3,
      originSettlementId: 6, // 濮阳
      formationId: 'AWL',
      slots: [
        { officerId: 301, row: 'FRONT', isCommander: true },  // 吕布
        { officerId: 302, row: 'MIDDLE', isCommander: false },// 高顺
        { officerId: 304, row: 'MIDDLE', isCommander: false },// 张辽
      ],
      troops: 16000,
      wounded: 300,
      morale: 96,
      goldCarried: 600,
      foodCarried: 24000,
      x: 41,
      y: 19,
      order: {
        type: 'MARCH_AND_ATTACK',
        targetX: 39,
        targetY: 18,
        targetSettlementId: 16, // 奇袭白马港
        path: [[40, 18], [39, 18]],
      },
      statusEffect: 'NORMAL',
      statusDurationTicks: 0,
      lastTacticBanner: null,
    },
  };

  // 标记已编入初始部队的武将
  for (const unit of Object.values(units)) {
    for (const slot of unit.slots) {
      if (officers[slot.officerId]) {
        officers[slot.officerId].assignedUnitId = unit.id;
      }
    }
  }

  // 新增一名初始关押在许昌大牢的吕布军先锋战俘【宋宪】，方便玩家开局即可体验【招降 / 辕门斩首(结下死敌血仇) / 礼送】
  officers[306] = {
    id: 306,
    name: '宋宪',
    courtesyName: '公则',
    factionId: 3,
    locationSettlementId: 4, // 关押于许昌
    assignedUnitId: null,
    capturedByFactionId: 1,  // 被曹操军生擒关押中
    isGovernor: false,
    birthYear: 162,
    leadership: 75,
    might: 81,
    intelligence: 52,
    politics: 48,
    charisma: 55,
    loyalty: 66,
    compatibility: 28,       // 与曹操(25)相性接近，容易招降！
    bloodLineId: null,
    clanId: null,
    swornBrotherIds: [302, 303], // 与高顺、张辽为并州同袍义兄弟（若斩首宋宪，张辽高顺将视曹操为血仇死敌！）
    spouseId: null,
    nemesisIds: [],
    courtOfficeId: '将校',
    passiveTraits: ['valiant'],
    personalities: ['RECKLESS'],
    learnedTactics: ['inf_1', 'cav_1', 'bow_1'],
    proficiencies: { INFANTRY: 320, CAVALRY: 350, CROSSBOW: 280 },
    hasActedThisXun: false,
  };

  // 为所有势力初始化每旬【君主政令符（命令书）】
  for (const fac of Object.values(factions)) {
    const baseSeals = 5 + Math.floor((fac.prestige || 400) / 250);
    fac.commandSeals = baseSeals;
    fac.maxCommandSeals = baseSeals;
    fac.missionBonusSeals = 0;
  }

  // 为所有据点初始化【迎击 / 坚守】防御方针 (前线与关隘默认主动出城迎击 INTERCEPT)
  for (const s of Object.values(settlements)) {
    s.defenseStance =
      s.type === 'PASS' || s.logisticsRole === 'FRONTLINE_DEMAND' ? 'INTERCEPT' : 'HOLD';
  }

  // 为所有武将补齐战俘与单旬行动状态字段
  for (const off of Object.values(officers)) {
    if (off.capturedByFactionId === undefined) off.capturedByFactionId = null;
    if (off.hasActedThisXun === undefined) off.hasActedThisXun = false;
  }

  /** @type {import('../core/types/index.js').GameState} */
  return {
    meta: {
      scenarioId: 'demo_central_plains_194',
      scenarioName: 'M1 垂直切片剧本：《中原逐鹿：虎牢—官渡战区》',
      seed: 1940301,
      turnCount: 1,
      date: {
        year: 194,
        month: 3,
        xun: 0, // 3月上旬
        dayInXun: 1,
        tickInXun: 0,
      },
      phase: 'STRATEGY_PHASE',
      playerFactionIds: [playerFactionId],
      activeHotseatFactionId: playerFactionId,
    },
    map: {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      terrain,
      elevation,
    },
    factions,
    settlements,
    officers,
    units,
    clans: deepClone(GENTRY_CLANS),
    facilities: {
      1: {
        id: 1,
        type: 'FORTRESS',
        name: '官渡城塞',
        factionId: 1,
        x: 33,
        y: 21,
        durability: 1500,
        maxDurability: 1500,
      },
      2: {
        id: 2,
        type: 'TOWER',
        name: '虎牢连弩橹',
        factionId: 4,
        x: 29,
        y: 24,
        durability: 1100,
        maxDurability: 1100,
      },
    },
    // 章节式君主破局使命树 (Imperial Missions)
    missions: [
      {
        id: 'mission_1_tiger_cage',
        stage: 1,
        title: '第一章：定鼎兖豫 · 兵锋叩虎牢',
        desc: '攻占咽喉要道【虎牢关】或【白马港】，或者累计统辖 6 座以上据点。',
        rewardText: '永久政令符上限 +1 · 君主信望 +80 · 许昌金库 +2,000',
        completed: false,
      },
      {
        id: 'mission_2_emperor_luoyang',
        stage: 2,
        title: '第二章：奉天子以令不臣',
        desc: '挥师西进攻克旧都【洛阳】，迎奉汉献帝定都许昌，威服天下诸侯。',
        rewardText: '永久政令符上限 +2 · 君主信望 +150 · 全境世家好感 +20',
        completed: false,
      },
      {
        id: 'mission_3_guandu_hegemony',
        stage: 3,
        title: '第三章：官渡争锋 · 饮马黄河',
        desc: '跨黄河夺取河北门户【黎阳港】或【邺城】，奠定北方霸业。',
        rewardText: '永久政令符上限 +2 · 西凉铁骑战马 +15,000 · 霸主威名',
        completed: false,
      },
    ],
    // 交互式历史危机事件弹窗状态
    activeEventModal: {
      id: 'evt_194_opening_crisis',
      title: '🔥 兴平元年风云：《吕布袭兖州与虎牢军机》',
      dateStr: '194年3月上旬',
      desc: '温侯吕布率并州狼骑自濮阳西进，窥伺我兖州重镇【陈留】与黄河渡口【白马港】；与此同时，西凉董卓军据守【虎牢关】，夏侯惇部已孤军深入嵩山隘口。主公当如何定夺军机？',
      options: [
        {
          id: 'OPT_OFFENSIVE',
          label: '⚔️ 【先发制人 · 强攻虎牢】急调虎豹精骑驰援陈留前线，令诸将死战破关！',
          effectDesc: '陈留兵力 +5,000、战马 +4,000；我方全体野战军团士气 +10；本旬额外获得 +2 枚君主政令符',
        },
        {
          id: 'OPT_STRATAGEM',
          label: '📜 【荀彧奇谋 · 筑垒惑敌】于前线赶筑连弩橹，并授权军师对吕布军施展伪报惑敌！',
          effectDesc: '在陈留北郊自动修筑【陈留连弩橹】；吕布先头部队陷入【混乱】3日；许昌金库 +1,200、颍川荀氏好感 +15',
        },
      ],
    },
    triggeredEventIds: ['evt_194_opening_crisis'],
    // 画布实时战斗视觉特效与飘字队列
    combatEffects: [],
    floatingTexts: [],
    battleLogs: [
      {
        id: 1,
        dateStr: '194年3月上旬',
        type: 'POLITICS',
        text: '【剧本开局】群雄割据中原！夏侯惇、夏侯渊、曹仁率兖州精兵进逼虎牢关，吕布率并州狼骑自濮阳西进白马港！',
        highlight: true,
        x: 32,
        y: 24,
      },
      {
        id: 2,
        dateStr: '194年3月上旬',
        type: 'ECONOMY',
        text: '【大牢战俘】前哨战生擒吕布麾下猛将【宋宪】关押于许昌大牢，主公可在左侧【📜军略俘虏】面板将其招降或斩首！',
        highlight: true,
        x: 33,
        y: 29,
      },
    ],
    activeCutin: null,
  };
}
