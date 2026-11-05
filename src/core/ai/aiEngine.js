/**
 * SPEC-03: 三层效用 AI 君主大脑 (Macro + Operational + Tactical)
 * 1. 宏观层：自动设定后方基地/前线军镇物流角色、自动扩建内政用地
 * 2. 中观层：评估城池脆弱度与进攻效用，拒绝单队添油送死
 * 3. 微观层：启发式高联动五将羁绊编队器 (优先组合义兄弟/血亲/同相性武将)
 */

import { ECONOMIC_BUILDING_DEFS, FORMATIONS } from '../../data/tacticsAndFormations.js';
import { getOfficerBondInfo } from '../combat/combatEngine.js';
import { findPathAStar } from '../map/pathfinder.js';
import { formatGameDate } from '../utils/prng.js';

/**
 * 为所有非玩家 AI 势力生成本旬战略指令
 */
export function runAIFactionsStrategyPhase(state, prng) {
  const playerIds = new Set(state.meta.playerFactionIds || [1]);
  const dateStr = formatGameDate(state.meta.date);

  for (const faction of Object.values(state.factions)) {
    if (playerIds.has(faction.id)) continue;

    const mySettlements = Object.values(state.settlements).filter((s) => s.factionId === faction.id);
    if (mySettlements.length === 0) continue;

    for (const s of mySettlements) {
      // 1. 内政层：若资金充裕，自动扩建城外 Lv1/Lv2 建筑至 Lv3
      if (s.gold >= 1600 && s.economicPlots?.length > 0) {
        const upgradable = s.economicPlots.find((p) => p.level < 3);
        if (upgradable && prng.chance(0.45)) {
          const def = ECONOMIC_BUILDING_DEFS[upgradable.type];
          const cost = def?.upgradeCost[upgradable.level] || 900;
          if (s.gold >= cost) {
            s.gold -= cost;
            upgradable.level += 1;
            upgradable.maxDurability = upgradable.level * 300;
            upgradable.durability = upgradable.maxDurability;
          }
        }
      }

      // 2. 兵源补充层：若前线城池兵力不足且自耕农与资金充足，自动征兵
      if (s.troops < 25000 && s.gold >= 1200 && s.pops.freePeasants >= 12000) {
        const draft = 3500;
        s.gold -= 700;
        s.pops.freePeasants -= draft;
        s.troops += draft;
      }

      // 3. 战役出征层：寻找相邻敌方据点，若兵力优势 >= 1.35x 则组建高联动五将部队出击
      const idleOfficers = Object.values(state.officers).filter(
        (o) => o.factionId === faction.id && o.locationSettlementId === s.id && !o.assignedUnitId
      );

      // 至少保留 1 名太守看家，且本城兵力 >= 26,000 才主动出击
      if (idleOfficers.length >= 2 && s.troops >= 26000 && s.food >= 35000) {
        const targetEnemies = (s.connectedSettlementIds || [])
          .map((id) => state.settlements[id])
          .filter((target) => target && target.factionId !== faction.id);

        for (const target of targetEnemies) {
          // 检查是否已经有本势力部队正在进攻该目标
          const alreadyAttacking = Object.values(state.units).some(
            (u) => u.factionId === faction.id && u.order?.targetSettlementId === target.id
          );
          if (alreadyAttacking) continue;

          if (s.troops >= target.troops * 1.25 && prng.chance(0.55)) {
            deployAITaskForceUnit(state, s, target, idleOfficers);
            state.battleLogs.unshift({
              id: Date.now() + Math.random(),
              dateStr,
              type: 'COMBAT',
              text: `🚩【敌情预警】${faction.name} 军自【${s.name}】调遣精锐大军出征，兵锋直指【${target.name}】！`,
              highlight: true,
              x: s.x,
              y: s.y,
            });
            break;
          }
        }
      }
    }
  }
}

/**
 * 第三层微观 AI：启发式高联动五将编队器 (SPEC-03 4.3)
 */
function deployAITaskForceUnit(state, originSettlement, targetSettlement, idleOfficers) {
  // 按统率+武力选出核心主将
  const sorted = [...idleOfficers].sort(
    (a, b) => b.leadership + b.might * 0.5 - (a.leadership + a.might * 0.5)
  );
  const commander = sorted[0];
  if (!commander) return;

  // 贪心选出与主将羁绊最高 (义兄弟/血缘/同相性) 的最多 3 名副将 (留 1 人守城)
  const maxUnitOfficers = Math.min(4, sorted.length - 1);
  const candidates = sorted.slice(1);
  candidates.sort((a, b) => {
    const bondA = getOfficerBondInfo(commander, a).multiplier;
    const bondB = getOfficerBondInfo(commander, b).multiplier;
    return bondB * 40 + b.might * 0.3 - (bondA * 40 + a.might * 0.3);
  });

  const chosen = [commander, ...candidates.slice(0, Math.max(1, maxUnitOfficers - 1))];

  // 根据城内武库库存选择最优阵型
  let formationId = 'LONG_SNAKE';
  const deployTroops = Math.min(18000, Math.round(originSettlement.troops * 0.55));
  const reqUnits = Math.ceil(deployTroops / 1000) * 1000;

  if (originSettlement.arsenal.warhorses >= reqUnits && commander.might >= 85) {
    formationId = 'ARROWHEAD';
    originSettlement.arsenal.warhorses -= reqUnits;
  } else if (originSettlement.arsenal.infantryArms >= reqUnits) {
    formationId = 'FISH_SCALE';
    originSettlement.arsenal.infantryArms -= reqUnits;
  } else if (originSettlement.arsenal.crossbows >= reqUnits) {
    formationId = 'WILD_GEESE';
    originSettlement.arsenal.crossbows -= reqUnits;
  }

  const form = FORMATIONS[formationId] || FORMATIONS.FISH_SCALE;
  const slots = [];
  let fCount = 0;
  let mCount = 0;

  chosen.forEach((off, idx) => {
    let row = 'REAR';
    if (off.intelligence >= 88 && off.might < 70) {
      row = 'REAR';
    } else if (fCount < form.rowSlots.FRONT) {
      row = 'FRONT';
      fCount++;
    } else if (mCount < form.rowSlots.MIDDLE) {
      row = 'MIDDLE';
      mCount++;
    }
    slots.push({
      officerId: off.id,
      row,
      isCommander: idx === 0,
    });
  });

  const newUnitId =
    Math.max(0, ...Object.keys(state.units).map(Number)) + 1;
  const path = findPathAStar(
    state,
    originSettlement.x,
    originSettlement.y,
    targetSettlement.x,
    targetSettlement.y,
    formationId
  );

  const foodTaken = Math.min(originSettlement.food - 10000, deployTroops * 1.5);
  originSettlement.troops -= deployTroops;
  originSettlement.food -= foodTaken;

  state.units[newUnitId] = {
    id: newUnitId,
    factionId: originSettlement.factionId,
    originSettlementId: originSettlement.id,
    formationId,
    slots,
    troops: deployTroops,
    wounded: 0,
    morale: originSettlement.morale,
    goldCarried: 400,
    foodCarried: foodTaken,
    x: originSettlement.x,
    y: originSettlement.y,
    order: {
      type: 'MARCH_AND_ATTACK',
      targetX: targetSettlement.x,
      targetY: targetSettlement.y,
      targetSettlementId: targetSettlement.id,
      path,
    },
    statusEffect: 'NORMAL',
    statusDurationTicks: 0,
    lastTacticBanner: null,
  };

  for (const s of slots) {
    state.officers[s.officerId].assignedUnitId = newUnitId;
  }
}
