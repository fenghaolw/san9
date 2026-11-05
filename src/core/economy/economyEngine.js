/**
 * SPEC-02: 大地图被动内政产出、EU5/Vic3 四阶人口与开工率、流民跨城迁徙、
 * 政令控制度与东汉世家门阀博弈、Vic3 水陆自动军需漕运网结算引擎
 */

import { ECONOMIC_BUILDING_DEFS } from '../../data/tacticsAndFormations.js';
import { FACTION_POLICIES } from '../../data/traitsAndClans.js';
import { clamp, formatGameDate } from '../utils/prng.js';

/**
 * 计算单座城市的农牧商业开工率与军工匠作开工率 (SPEC-02 2.2)
 */
export function computeSettlementEmployment(settlement) {
  let reqPeasants = 0;
  let reqArtisans = 0;

  for (const plot of settlement.economicPlots || []) {
    const def = ECONOMIC_BUILDING_DEFS[plot.type];
    if (!def) continue;
    const req = def.laborReq[(plot.level || 1) - 1] || 3000;
    if (def.laborType === 'artisans') {
      reqArtisans += req;
    } else {
      reqPeasants += req;
    }
  }

  const availPeasants = Math.round(settlement.pops.freePeasants * 0.75);
  const availArtisans = settlement.pops.artisans;

  const peasantRatio = reqPeasants === 0 ? 1.0 : clamp(availPeasants / reqPeasants, 0.25, 1.0);
  const artisanRatio = reqArtisans === 0 ? 1.0 : clamp(availArtisans / reqArtisans, 0.25, 1.0);

  return {
    reqPeasants,
    availPeasants,
    peasantRatio,
    reqArtisans,
    availArtisans,
    artisanRatio,
  };
}

/**
 * 计算单座城市的政令控制度 Control% 与太守内政倍率 (SPEC-02 1 & 3.1)
 */
export function computeSettlementControlAndYieldPreview(state, settlement) {
  const faction = settlement.factionId ? state.factions[settlement.factionId] : null;
  const policy = faction ? FACTION_POLICIES[faction.activePolicy] || FACTION_POLICIES.BALANCED : FACTION_POLICIES.BALANCED;
  const capital = faction ? state.settlements[faction.capitalSettlementId] : null;

  // 距首都欧氏行军天数估算
  const distDays =
    capital && capital.id !== settlement.id
      ? Math.hypot(settlement.x - capital.x, settlement.y - capital.y) * 0.45
      : 0;

  // 驻城官员最高政治与特技加成
  const cityOfficers = Object.values(state.officers).filter(
    (o) => o.factionId === settlement.factionId && o.locationSettlementId === settlement.id && !o.assignedUnitId
  );

  let maxPol = 65;
  let hasKingAdvisor = false;
  let hasTuntianTrait = false;
  for (const o of cityOfficers) {
    if (o.politics > maxPol) maxPol = o.politics;
    if (o.passiveTraits?.includes('king_advisor')) hasKingAdvisor = true;
    if (o.passiveTraits?.includes('tuntian_master')) hasTuntianTrait = true;
  }

  const clan = settlement.dominantClanId ? state.clans[settlement.dominantClanId] : null;
  const clanInfluence = clan ? clan.influence : 30;
  const clanAttitude = clan && settlement.factionId ? clan.attitudeByFaction[settlement.factionId] ?? 50 : 50;

  const clanPenalty = clanAttitude >= 75 ? clanInfluence * 0.15 : clanInfluence * 0.32;

  const targetControl =
    capital && capital.id === settlement.id
      ? 100
      : clamp(
          Math.round(
            100 -
              distDays * 2.2 +
              (maxPol - 60) * 0.35 +
              policy.controlBonus +
              (hasKingAdvisor ? 12 : 0) -
              clanPenalty
          ),
          20,
          100
        );

  const emp = computeSettlementEmployment(settlement);
  const govMult = (1.0 + Math.max(0, maxPol - 60) * 0.006) * policy.taxMult;
  const controlMult = targetControl / 100;

  let rawGold = 180; // 基础城池丁税
  let rawFood = 450 + (hasTuntianTrait ? 600 : 0);
  let armsYield = 150;
  let xbowYield = 120;
  let horseYield = settlement.regionalBonuses?.includes('HORSE_PASTURE') ? 220 : 80;
  let woundedHeal = 300 + (hasKingAdvisor ? 300 : 0);
  let conscriptBonus = 1.0;

  for (const plot of settlement.economicPlots || []) {
    if (plot.durability <= 0) continue;
    const def = ECONOMIC_BUILDING_DEFS[plot.type];
    if (!def) continue;
    const baseVal = def.yieldPerXun[(plot.level || 1) - 1] || 0;

    if (plot.type === 'FARM') {
      rawFood += baseVal * emp.peasantRatio * (faction?.activePolicy === 'TUNTIAN' ? 1.25 : 1.0);
    } else if (plot.type === 'MARKET') {
      rawGold += baseVal * emp.peasantRatio * ( hasKingAdvisor ? 1.25 : 1.0 );
    } else if (plot.type === 'BARRACKS') {
      woundedHeal += baseVal * emp.peasantRatio;
      conscriptBonus += 0.15 * plot.level;
    } else if (plot.type === 'SMITHY') {
      const val = baseVal * emp.artisanRatio * (hasKingAdvisor ? 1.25 : 1.0);
      armsYield += val;
      xbowYield += val * 0.85;
    } else if (plot.type === 'STABLE') {
      const horseMult = settlement.regionalBonuses?.includes('HORSE_PASTURE') ? 1.5 : 1.0;
      horseYield += baseVal * emp.peasantRatio * horseMult;
    }
  }

  const netGold = Math.round(rawGold * govMult * controlMult);
  const clanSiphonedGold = Math.round(rawGold * govMult * (1 - controlMult));
  const netFood = Math.round(rawFood * govMult * controlMult);

  return {
    targetControl,
    employment: emp,
    netGold,
    clanSiphonedGold,
    netFood,
    armsYield: Math.round(armsYield),
    xbowYield: Math.round(xbowYield),
    horseYield: Math.round(horseYield),
    woundedHeal: Math.round(woundedHeal),
    conscriptBonus,
  };
}

/**
 * 每旬开始时结算：
 * 1. 大地图 Lv1-3 建筑被动产出 (含季度大税收与 7月上旬秋收大丰收)
 * 2. 伤兵恢复
 * 3. EU5 世家门阀隐户兼并与清丈
 * 4. EU5/Vic3 战乱流民跨城迁徙
 * 5. Vic3 水陆自动军需漕运网调拨
 */
export function runXunEconomyAndPoliticsSettlement(state) {
  const { month, xun } = state.meta.date;
  const isQuarterlyTax = xun === 0 && (month === 1 || month === 4 || month === 7 || month === 10);
  const isAutumnHarvest = xun === 0 && month === 7;
  const dateStr = formatGameDate(state.meta.date);

  // 1. 各城被动产出、伤兵恢复与控制度更新
  for (const s of Object.values(state.settlements)) {
    if (!s.factionId) continue;
    const preview = computeSettlementControlAndYieldPreview(state, s);
    s.controlRate = preview.targetControl;

    const goldMult = isQuarterlyTax ? 2.8 : 1.0;
    const foodMult = isAutumnHarvest ? 3.8 : 1.0;

    s.gold += Math.round(preview.netGold * goldMult);
    s.food += Math.round(preview.netFood * foodMult);

    // 武库自动入库
    s.arsenal.infantryArms = Math.min(80000, s.arsenal.infantryArms + preview.armsYield);
    s.arsenal.crossbows = Math.min(80000, s.arsenal.crossbows + preview.xbowYield);
    s.arsenal.warhorses = Math.min(80000, s.arsenal.warhorses + preview.horseYield);

    // 工房每季产出攻城器械
    const hasWorkshop = (s.economicPlots || []).some((p) => p.type === 'WORKSHOP' && p.durability > 0);
    if (hasWorkshop && xun === 0) {
      s.arsenal.siegeTowers = Math.min(10, s.arsenal.siegeTowers + 1);
      if (month % 2 === 1) s.arsenal.catapults = Math.min(8, s.arsenal.catapults + 1);
    }

    // 城内伤兵自动恢复为现役兵力
    if (s.woundedTroops > 0) {
      const healed = Math.min(s.woundedTroops, preview.woundedHeal);
      s.woundedTroops -= healed;
      s.troops += healed;
    }

    // 守军士气自然恢复
    s.morale = Math.min(100, s.morale + 4);

    // 国策对人口阶层的动态影响
    const faction = state.factions[s.factionId];
    if (faction?.activePolicy === 'TUNTIAN' && s.pops.refugees > 200) {
      const settled = Math.min(s.pops.refugees, Math.max(250, Math.round(s.pops.refugees * 0.22)));
      s.pops.refugees -= settled;
      s.pops.freePeasants += settled;
    } else if (faction?.activePolicy === 'MERITOCRACY' && s.pops.clanRetainers > 1000) {
      const reclaimed = Math.round(s.pops.clanRetainers * 0.06);
      s.pops.clanRetainers -= reclaimed;
      s.pops.freePeasants += reclaimed;
    } else if (s.controlRate < 75 && s.pops.freePeasants > 5000) {
      // 控制度不足时，地方豪强兼并自耕农为部曲隐户
      const annexed = Math.round(s.pops.freePeasants * ((80 - s.controlRate) * 0.0003));
      s.pops.freePeasants -= annexed;
      s.pops.clanRetainers += annexed;
    }
  }

  if (isAutumnHarvest) {
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'ECONOMY',
      text: `🌾【七月大收成】秋收时节，天下各州郡农田迎来四倍兵粮入仓！`,
      highlight: true,
    });
  } else if (isQuarterlyTax) {
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'ECONOMY',
      text: `🪙【季度大税收】${month}月季首，各州郡市场与田赋完成季度结算入库。`,
      highlight: false,
    });
  }

  // 2. EU5/Vic3 战乱流民跨城迁徙
  runRefugeeMigration(state, dateStr);

  // 3. Vic3 水陆自动军需漕运网调拨
  runAutoLogisticsNetwork(state, dateStr);
}

/**
 * 战乱流民跨城迁徙 (SPEC-02 2.3)
 */
function runRefugeeMigration(state, dateStr) {
  const settlements = Object.values(state.settlements);

  // 计算每座城市的战乱状态与吸引力指数
  const inWarMap = {};
  for (const s of settlements) {
    const enemyNearby = Object.values(state.units).some(
      (u) => u.factionId !== s.factionId && Math.hypot(u.x - s.x, u.y - s.y) <= 5
    );
    inWarMap[s.id] = enemyNearby;
    if (enemyNearby && s.pops.freePeasants > 3000) {
      const displaced = Math.round(s.pops.freePeasants * 0.025);
      s.pops.freePeasants -= displaced;
      s.pops.refugees += displaced;
    }
  }

  for (const origin of settlements) {
    if (origin.pops.refugees < 600) continue;
    const originPull = origin.publicOrder + Math.min(40, origin.food / 2500) - (inWarMap[origin.id] ? 65 : 0);

    let bestTarget = null;
    let bestDiff = 18;

    for (const nId of origin.connectedSettlementIds || []) {
      const target = state.settlements[nId];
      if (!target) continue;
      const targetPull = target.publicOrder + Math.min(45, target.food / 2500) - (inWarMap[target.id] ? 65 : 0);
      if (targetPull - originPull > bestDiff) {
        bestDiff = targetPull - originPull;
        bestTarget = target;
      }
    }

    if (bestTarget) {
      const moving = Math.round(origin.pops.refugees * 0.22);
      origin.pops.refugees -= moving;
      bestTarget.pops.refugees += moving;

      if (moving >= 450) {
        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'ECONOMY',
          text: `👥【流民迁徙】因战火与粮荒，${origin.name} 有 ${moving.toLocaleString()} 名流民沿官道迁往富庶安定的 ${bestTarget.name}。`,
          x: bestTarget.x,
          y: bestTarget.y,
        });
      }
    }
  }
}

/**
 * Vic3 水陆自动军需漕运网结算 (SPEC-02 4)
 */
function runAutoLogisticsNetwork(state, dateStr) {
  for (const faction of Object.values(state.factions)) {
    const mySettlements = Object.values(state.settlements).filter((s) => s.factionId === faction.id);
    const rearSuppliers = mySettlements.filter((s) => s.logisticsRole === 'REAR_SUPPLY' && s.food > 45000);
    const frontDemands = mySettlements.filter((s) => s.logisticsRole === 'FRONTLINE_DEMAND');

    for (const rear of rearSuppliers) {
      for (const front of frontDemands) {
        if (rear.id === front.id) continue;
        // 检查是否相邻或通过同势力据点连通
        const connected =
          rear.connectedSettlementIds?.includes(front.id) ||
          rear.connectedSettlementIds?.some((midId) => {
            const mid = state.settlements[midId];
            return mid?.factionId === faction.id && mid.connectedSettlementIds?.includes(front.id);
          });

        if (!connected) continue;

        const foodTransfer = Math.min(6000, Math.max(0, Math.round((rear.food - 40000) * 0.25)));
        const armsTransfer = Math.min(2500, Math.max(0, Math.round((rear.arsenal.infantryArms - 12000) * 0.25)));
        const horseTransfer = Math.min(1800, Math.max(0, Math.round((rear.arsenal.warhorses - 8000) * 0.25)));

        if (foodTransfer >= 1500 || armsTransfer >= 800) {
          rear.food -= foodTransfer;
          front.food += Math.round(foodTransfer * 0.96); // 4% 漕运损耗
          rear.arsenal.infantryArms -= armsTransfer;
          front.arsenal.infantryArms += armsTransfer;
          rear.arsenal.warhorses -= horseTransfer;
          front.arsenal.warhorses += horseTransfer;

          if (faction.id === state.meta.activeHotseatFactionId && foodTransfer >= 2500) {
            state.battleLogs.unshift({
              id: Date.now() + Math.random(),
              dateStr,
              type: 'ECONOMY',
              text: `⛵【军需漕运网】后方基地【${rear.name}】通过水陆漕运自动向一线军镇【${front.name}】调拨兵粮 ${foodTransfer.toLocaleString()}、军备 ${(armsTransfer + horseTransfer).toLocaleString()}。`,
              x: front.x,
              y: front.y,
            });
          }
        }
      }
    }
  }
}
