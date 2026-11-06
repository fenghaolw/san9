/**
 * SPEC-01 & SPEC-02 (v1.2):
 * - 5将三列阵型攻防与六边形【多面夹击 (Flanking)】加成
 * - 【城塞 (FORTRESS)】减伤屏障与支援光环
 * - 9系兵法泊松触发、基于血缘/义兄弟/相性的 2~5 人联动解算
 * - ⚔️【疆场一骑讨 (猛将单挑)】自动演算与阵前生擒
 * - 📜【大地图军师计略 (伪报退兵/扰乱定身/火计烧粮/离间登庸)】
 * - ⛓️【战俘大牢生杀大权 (招降/辕门斩首触发CK3家族死敌血仇/礼送释放)】
 * - 画布实时战斗特效队列 (箭雨刀光轨迹 combatEffects + 头顶飘字 floatingTexts)
 */

import { FORMATIONS, TACTICS, TERRAIN_DEFS } from '../../data/tacticsAndFormations.js';
import { findPathAStar, getHexDistance } from '../map/pathfinder.js';
import { clamp, formatGameDate, getCompatibilityDistance } from '../utils/prng.js';

const CHAIN_MULTIPLIERS = [1.0, 1.0, 1.35, 1.75, 2.25, 3.0];

/**
 * 向画布推入一条攻击轨迹特效 (刀光/箭雨/火攻/伪报)
 */
export function pushCombatBeam(state, fromX, fromY, toX, toY, color = '#f59e0b', kind = 'ARROW') {
  if (!state.combatEffects) state.combatEffects = [];
  state.combatEffects.push({
    id: Date.now() + Math.random(),
    fromX,
    fromY,
    toX,
    toY,
    color,
    kind,
    createdAt: Date.now(),
  });
  if (state.combatEffects.length > 24) {
    state.combatEffects.splice(0, state.combatEffects.length - 24);
  }
}

/**
 * 向画布推入一条六边形头顶实时掉血/暴击/状态飘字
 */
export function pushFloatingText(state, x, y, text, color = '#f87171') {
  if (!state.floatingTexts) state.floatingTexts = [];
  state.floatingTexts.push({
    id: Date.now() + Math.random(),
    x,
    y,
    text,
    color,
    createdAt: Date.now(),
  });
  if (state.floatingTexts.length > 32) {
    state.floatingTexts.splice(0, state.floatingTexts.length - 32);
  }
}

/**
 * 计算两名武将之间的羁绊类型与联动倍率 (SPEC-01 4.2)
 */
export function getOfficerBondInfo(officerA, officerB) {
  if (!officerA || !officerB || officerA.id === officerB.id) {
    return { type: 'NONE', label: '普通', multiplier: 1.0, color: '#64748b' };
  }
  if (
    officerA.nemesisIds?.includes(officerB.id) ||
    officerB.nemesisIds?.includes(officerA.id)
  ) {
    return { type: 'NEMESIS', label: '血仇死敌', multiplier: 0.0, color: '#ef4444' };
  }
  if (
    officerA.swornBrotherIds?.includes(officerB.id) ||
    officerB.swornBrotherIds?.includes(officerA.id)
  ) {
    return { type: 'SWORN', label: '义兄弟', multiplier: 2.2, color: '#f59e0b' };
  }
  if (officerA.bloodLineId && officerA.bloodLineId === officerB.bloodLineId) {
    return { type: 'BLOOD', label: '宗族血亲', multiplier: 1.85, color: '#eab308' };
  }
  if (officerA.clanId && officerA.clanId === officerB.clanId) {
    return { type: 'CLAN', label: '同门阀世家', multiplier: 1.4, color: '#38bdf8' };
  }

  const dist = getCompatibilityDistance(officerA.compatibility, officerB.compatibility);
  const compatMod = clamp(1.5 - dist / 25, 0.4, 1.45);
  return {
    type: dist <= 8 ? 'COMPAT_GREAT' : 'COMPAT_NORMAL',
    label: dist <= 8 ? `相性极佳(Δ${dist})` : `相性(Δ${dist})`,
    multiplier: Number(compatMod.toFixed(2)),
    color: dist <= 8 ? '#22c55e' : '#94a3b8',
  };
}

/**
 * 计算 5 将小队在指定阵型下的有效统率、攻防、预计每旬兵法触发率与羁绊连线预览
 */
export function evaluateUnitSynergyPreview(state, formationId, slots) {
  const form = FORMATIONS[formationId] || FORMATIONS.FISH_SCALE;
  const validSlots = (slots || []).filter((s) => s.officerId && state.officers[s.officerId]);
  if (validSlots.length === 0) {
    return {
      commander: null,
      effectiveLDR: 0,
      estTriggerProbPerXun: 0,
      estChainProb: 0,
      links: [],
      officerTriggerRates: {},
    };
  }

  const sortedByCommand = [...validSlots].sort((a, b) => {
    const oa = state.officers[a.officerId];
    const ob = state.officers[b.officerId];
    const isRulerA = Object.values(state.factions).some((f) => f.rulerOfficerId === oa.id);
    const isRulerB = Object.values(state.factions).some((f) => f.rulerOfficerId === ob.id);
    if (isRulerA !== isRulerB) return isRulerA ? -1 : 1;
    return ob.leadership - oa.leadership;
  });

  const commander = state.officers[sortedByCommand[0].officerId];
  let maxDeputyBonus = 0;
  for (let i = 1; i < sortedByCommand.length; i++) {
    const dep = state.officers[sortedByCommand[i].officerId];
    maxDeputyBonus = Math.max(maxDeputyBonus, Math.max(0, dep.leadership - 60) * 0.15);
  }
  const effectiveLDR = Math.round(commander.leadership + maxDeputyBonus);

  const officerTriggerRates = {};
  let combinedDailyNoTrigger = 1.0;

  for (const slot of validSlots) {
    const off = state.officers[slot.officerId];
    const best = getBestTacticForOfficerInFormation(off, form, slot.row);
    officerTriggerRates[off.id] = best;
    combinedDailyNoTrigger *= 1 - best.dailyProb;
  }

  const estTriggerProbPerXun = Math.round((1 - Math.pow(combinedDailyNoTrigger, 4)) * 100);

  const links = [];
  let totalPairMultiplier = 0;
  let pairCount = 0;
  for (let i = 0; i < validSlots.length; i++) {
    for (let j = i + 1; j < validSlots.length; j++) {
      const oa = state.officers[validSlots[i].officerId];
      const ob = state.officers[validSlots[j].officerId];
      const bond = getOfficerBondInfo(oa, ob);
      totalPairMultiplier += bond.multiplier;
      pairCount++;
      if (bond.multiplier >= 1.25 || bond.type === 'NEMESIS') {
        links.push({
          fromId: oa.id,
          toId: ob.id,
          fromName: oa.name,
          toName: ob.name,
          ...bond,
        });
      }
    }
  }

  const avgBondMult = pairCount > 0 ? totalPairMultiplier / pairCount : 1.0;
  const estChainProb =
    validSlots.length <= 1
      ? 0
      : Math.min(95, Math.round(25 * form.chainRateMod * avgBondMult * (validSlots.length - 1) * 0.65));

  return {
    commander,
    effectiveLDR,
    estTriggerProbPerXun,
    estChainProb,
    links,
    officerTriggerRates,
  };
}

/**
 * 获取武将在当前阵型与前/中/后列站位下触发率最高的兵法 (SPEC-01 4.2)
 */
export function getBestTacticForOfficerInFormation(officer, formation, row = 'FRONT') {
  let bestTactic = TACTICS.inf_1;
  let bestProb = 0.08;

  const rowModByCat = (cat) => {
    if (row === 'FRONT') {
      return cat === 'INFANTRY' || cat === 'CAVALRY' ? 1.18 : 0.88;
    }
    if (row === 'REAR') {
      return cat === 'CROSSBOW' || cat === 'HORSE_ARCHER' || cat === 'SIEGE' || cat === 'KNOWLEDGE' || cat === 'STRATAGEM' || cat === 'STRATEGY'
        ? 1.22
        : 0.78;
    }
    return 1.05;
  };

  for (const tId of officer.learnedTactics || []) {
    const t = TACTICS[tId];
    if (!t) continue;
    const affinity = formation.tacticAffinity?.[t.category] ?? 1.0;
    const rowMod = rowModByCat(t.category);
    const primaryStat = officer[t.stat] || officer.might || 70;
    const prof = officer.proficiencies?.[t.category] ?? 300;
    const traitBonus =
      (officer.passiveTraits?.includes('flying_general') ? 1.25 : 1.0) *
      (officer.passiveTraits?.includes('divine_calc') && (t.category === 'KNOWLEDGE' || t.category === 'STRATAGEM') ? 1.3 : 1.0) *
      (officer.personalities?.includes('RECKLESS') && (t.category === 'INFANTRY' || t.category === 'CAVALRY') ? 1.15 : 1.0);

    const prob = clamp(
      0.12 * affinity * rowMod * (1 + (primaryStat - 70) / 100) * (1 + prof / 1000) * traitBonus,
      0.04,
      0.68
    );

    if (prob * t.power > bestProb * bestTactic.power) {
      bestProb = prob;
      bestTactic = t;
    }
  }

  return {
    tactic: bestTactic,
    dailyProb: Number(bestProb.toFixed(3)),
    percent: Math.round(bestProb * 100),
  };
}

/**
 * 计算部队当前基础攻击力与防御力 (含【城塞 FORTRESS】屏障加成)
 */
export function computeUnitCombatStats(state, unit) {
  const form = FORMATIONS[unit.formationId] || FORMATIONS.FISH_SCALE;
  const syn = evaluateUnitSynergyPreview(state, unit.formationId, unit.slots);
  const effLDR = syn.effectiveLDR || 75;

  const tileIdx = unit.y * state.map.width + unit.x;
  const terrainType = state.map.terrain[tileIdx] ?? 0;
  const terrainDef = TERRAIN_DEFS[terrainType] || TERRAIN_DEFS[0];

  const hasIronWall = unit.slots.some((s) => state.officers[s.officerId]?.passiveTraits?.includes('iron_wall'));
  const rageBonus = unit.statusEffect === 'BLOOD_FEUD_RAGE' ? 1.25 : 1.0;
  const confusePenalty = unit.statusEffect === 'CONFUSED' ? 0.72 : 1.0;

  // 检查是否依托己方【城塞 (FORTRESS)】作战 (1格内防御力 +33%)
  const nearFriendlyFortress = Object.values(state.facilities || {}).some(
    (fac) =>
      fac.factionId === unit.factionId &&
      fac.type === 'FORTRESS' &&
      fac.durability > 0 &&
      getHexDistance(fac.x, fac.y, unit.x, unit.y) <= 1
  );
  const fortressMod = nearFriendlyFortress ? 1.33 : 1.0;

  const atk =
    effLDR *
    (form.atk / 100) *
    (0.5 + 0.5 * (unit.morale / 100)) *
    Math.sqrt(Math.max(500, unit.troops) / 1000) *
    rageBonus;

  const def =
    effLDR *
    (form.def / 100) *
    terrainDef.defMod *
    (hasIronWall ? 1.25 : 1.0) *
    fortressMod *
    confusePenalty;

  return { atk, def, effLDR, form, nearFriendlyFortress };
}

/**
 * 统计某支部队当前正遭到多少支敌方部队围攻 (用于判定六边形【多面夹击 Flanking】)
 */
export function countHexFlankingAttackers(state, targetUnit) {
  let count = 0;
  for (const u of Object.values(state.units)) {
    if (u.id === targetUnit.id || u.factionId === targetUnit.factionId || u.troops <= 0) continue;
    const f = FORMATIONS[u.formationId] || FORMATIONS.FISH_SCALE;
    const rng = Math.max(1, f.range || 1);
    if (getHexDistance(u.x, u.y, targetUnit.x, targetUnit.y) <= rng) {
      count += 1;
    }
  }
  return count;
}

/**
 * 结算两支野外敌对部队的单步交战
 * 包含：六边形多面夹击加成、CK3死敌血战、疆场猛将单挑(一骑讨)、兵法2~5联动、画布箭雨飘字
 */
export function resolveFieldBattleStep(state, unitA, unitB, prng, isTacticRollTick = false) {
  if (unitA.troops <= 0 || unitB.troops <= 0) return;

  const statsA = computeUnitCombatStats(state, unitA);
  const statsB = computeUnitCombatStats(state, unitB);
  const dateStr = formatGameDate(state.meta.date, true);

  // 1. CK3 战场死敌检测 (【死敌血战】)
  checkBloodFeudTrigger(state, unitA, unitB, dateStr);
  checkBloodFeudTrigger(state, unitB, unitA, dateStr);

  // 2. 六边形【多面夹击 (Flanking)】检测：若同时被 >=2 支敌军围攻，承受 +30%*(N-1) 夹击伤害且士气动摇
  const attackersOnB = countHexFlankingAttackers(state, unitB);
  const attackersOnA = countHexFlankingAttackers(state, unitA);
  unitB.isFlanked = attackersOnB >= 2;
  unitA.isFlanked = attackersOnA >= 2;

  const flankMultOnB = attackersOnB >= 2 ? 1 + 0.30 * (attackersOnB - 1) : 1.0;
  const flankMultOnA = attackersOnA >= 2 ? 1 + 0.30 * (attackersOnA - 1) : 1.0;

  // 3. 普通交战伤害结算
  const dmgToB = Math.round(
    22 * flankMultOnB * (Math.pow(statsA.atk, 1.22) / Math.max(25, statsB.def)) * prng.rangeFloat(0.92, 1.08)
  );
  const dmgToA =
    unitB.statusEffect === 'CONFUSED'
      ? 0
      : Math.round(
          22 * flankMultOnA * (Math.pow(statsB.atk, 1.22) / Math.max(25, statsA.def)) * prng.rangeFloat(0.92, 1.08)
        );

  applyTroopDamageAndWounded(unitB, dmgToB, 0.35);
  applyTroopDamageAndWounded(unitA, dmgToA, 0.35);

  // 推入画布交战刀光/箭雨特效
  const facA = state.factions[unitA.factionId];
  pushCombatBeam(state, unitA.x, unitA.y, unitB.x, unitB.y, facA?.color || '#38bdf8', 'CLASH');

  if (isTacticRollTick) {
    if (unitB.isFlanked) {
      unitB.morale = Math.max(0, unitB.morale - 4);
      pushFloatingText(state, unitB.x, unitB.y, `🔥被夹击! -${dmgToB} (士气-4)`, '#fb923c');
    } else {
      pushFloatingText(state, unitB.x, unitB.y, `-${dmgToB}`, '#f87171');
    }
    if (dmgToA > 0) {
      pushFloatingText(state, unitA.x, unitA.y, `-${dmgToA}`, '#fca5a5');
    }

    // 4. ⚔️ 疆场猛将单挑（一骑讨）触发判定
    if (
      unitA.troops > 0 &&
      unitB.troops > 0 &&
      unitA.statusEffect !== 'CONFUSED' &&
      unitB.statusEffect !== 'CONFUSED'
    ) {
      maybeTriggerOfficerDuel(state, unitA, unitB, prng, dateStr);
    }

    // 5. 兵法触发与 2~5 人联动判定
    if (unitA.troops > 0 && unitB.troops > 0 && unitA.statusEffect !== 'CONFUSED') {
      tryTriggerUnitTacticChain(state, unitA, unitB, null, prng, dateStr);
    }
    if (unitB.troops > 0 && unitA.troops > 0 && unitB.statusEffect !== 'CONFUSED') {
      tryTriggerUnitTacticChain(state, unitB, unitA, null, prng, dateStr);
    }
  }

  // 6. 判定士气归零溃灭或兵力归零歼灭
  checkUnitElimination(state, unitA, unitB.factionId, dateStr, prng);
  checkUnitElimination(state, unitB, unitA.factionId, dateStr, prng);
}

/**
 * ⚔️ 疆场一骑讨（猛将单挑演出与阵前生擒）
 */
function maybeTriggerOfficerDuel(state, unitA, unitB, prng, dateStr) {
  const pickDuelist = (unit) => {
    const candidates = (unit.slots || [])
      .filter((s) => s.row !== 'REAR' && state.officers[s.officerId])
      .map((s) => state.officers[s.officerId])
      .sort((a, b) => b.might - a.might);
    return candidates[0] || state.officers[unit.slots[0]?.officerId];
  };

  const duelistA = pickDuelist(unitA);
  const duelistB = pickDuelist(unitB);
  if (!duelistA || !duelistB || duelistA.might < 76 || duelistB.might < 76) return;

  const isRage = unitA.statusEffect === 'BLOOD_FEUD_RAGE' || unitB.statusEffect === 'BLOOD_FEUD_RAGE';
  const duelProb = isRage ? 0.36 : 0.22;
  if (!prng.chance(duelProb)) return;

  const scoreA =
    duelistA.might +
    (duelistA.passiveTraits?.includes('flying_general') ? 16 : 0) +
    (duelistA.passiveTraits?.includes('valiant') ? 8 : 0) +
    prng.rangeInt(-8, 10);
  const scoreB =
    duelistB.might +
    (duelistB.passiveTraits?.includes('flying_general') ? 16 : 0) +
    (duelistB.passiveTraits?.includes('valiant') ? 8 : 0) +
    prng.rangeInt(-8, 10);

  const aWins = scoreA >= scoreB;
  const winnerOff = aWins ? duelistA : duelistB;
  const loserOff = aWins ? duelistB : duelistA;
  const winnerUnit = aWins ? unitA : unitB;
  const loserUnit = aWins ? unitB : unitA;
  const margin = Math.abs(scoreA - scoreB);

  const duelTroopDmg = 1400 + margin * 35;
  applyTroopDamageAndWounded(loserUnit, duelTroopDmg, 0.25);
  winnerUnit.morale = Math.min(100, winnerUnit.morale + 18);
  loserUnit.morale = Math.max(0, loserUnit.morale - 28);

  // 判断是否阵前生擒败将 (若大胜且敌队有多名武将或敌队因此溃散)
  const isRulerLoser = Object.values(state.factions).some((f) => f.rulerOfficerId === loserOff.id);
  let capturedInDuel = false;
  if (!isRulerLoser && margin >= 10 && loserUnit.slots.length > 1 && prng.chance(0.55)) {
    capturedInDuel = true;
    loserOff.capturedByFactionId = winnerUnit.factionId;
    loserOff.assignedUnitId = null;
    loserUnit.slots = loserUnit.slots.filter((s) => s.officerId !== loserOff.id);
  }

  pushFloatingText(
    state,
    loserUnit.x,
    loserUnit.y,
    capturedInDuel ? `⚔️单挑生擒${loserOff.name}! 士气-28` : `⚔️单挑落败! 士气-28`,
    '#facc15'
  );

  const winnerFac = state.factions[winnerUnit.factionId];
  state.activeCutin = {
    id: Date.now() + Math.random(),
    officerNames: [winnerOff.name, `⚔️一骑讨击败 ${loserOff.name}`],
    tacticName: capturedInDuel ? '阵前生擒敌将' : '三合斩落马下',
    chainCount: 2,
    damage: duelTroopDmg,
    targetName: `${loserOff.name}部 (敌军士气暴跌 -28)`,
    factionColor: winnerFac?.color || '#eab308',
    barkText: capturedInDuel
      ? `“匹夫休走！${winnerOff.name}在此，给我生擒活捉押入大牢！”`
      : `“谁敢与我${winnerOff.name}决一死战！”`,
  };

  state.battleLogs.unshift({
    id: Date.now() + Math.random(),
    dateStr,
    type: 'COMBAT',
    text: capturedInDuel
      ? `⚔️【一骑讨·阵前生擒！】${winnerOff.name}(武${winnerOff.might}) 与 ${loserOff.name}(武${loserOff.might}) 疆场单挑！大战数合后将其生擒落马押入大牢，敌军士气暴跌 28 点！`
      : `⚔️【疆场一骑讨！】${winnerOff.name}(武${winnerOff.might}) 在阵前单挑击败 ${loserOff.name}(武${loserOff.might})！我军欢声雷动(士气+18)，敌军胆寒(士气-28，斩敌${duelTroopDmg})！`,
    highlight: true,
    x: winnerUnit.x,
    y: winnerUnit.y,
  });
}

/**
 * 结算部队攻城战单步 (针对敌方都市、关隘、港口)
 */
export function resolveSiegeBattleStep(state, attackerUnit, settlement, prng, isTacticRollTick = false) {
  if (attackerUnit.troops <= 0) return;

  const statsAtk = computeUnitCombatStats(state, attackerUnit);
  const dateStr = formatGameDate(state.meta.date, true);

  const prefect = settlement.prefectOfficerId ? state.officers[settlement.prefectOfficerId] : null;
  const defLDR = prefect ? prefect.leadership : 78;
  const hasIronWall = prefect?.passiveTraits?.includes('iron_wall');
  const settlementDef = defLDR * 1.35 * (hasIronWall ? 1.25 : 1.0);

  const isSiegeForm = attackerUnit.formationId === 'SIEGE_TOWER' || attackerUnit.formationId === 'CATAPULT';
  const troopDmg = Math.round(
    20 * (Math.pow(statsAtk.atk, 1.2) / Math.max(30, settlementDef)) * prng.rangeFloat(0.9, 1.1)
  );
  const wallDmg = Math.round((isSiegeForm ? 55 : 20) * (statsAtk.effLDR / 80));

  const counterScale = statsAtk.form.range >= 2 ? 0.45 : 0.85;
  const counterDmg =
    settlement.troops > 0
      ? Math.round(
          15 *
            counterScale *
            (Math.pow(defLDR * Math.sqrt(settlement.troops / 1000), 1.18) / Math.max(25, statsAtk.def))
        )
      : 0;

  settlement.troops = Math.max(0, settlement.troops - troopDmg);
  settlement.woundedTroops += Math.round(troopDmg * 0.35);
  settlement.wallDurability = Math.max(0, settlement.wallDurability - wallDmg);

  applyTroopDamageAndWounded(attackerUnit, counterDmg, 0.35);

  const facAtk = state.factions[attackerUnit.factionId];
  pushCombatBeam(state, attackerUnit.x, attackerUnit.y, settlement.x, settlement.y, facAtk?.color || '#f59e0b', 'SIEGE');

  if (isTacticRollTick) {
    pushFloatingText(state, settlement.x, settlement.y, `-${troopDmg}兵 / -${wallDmg}城防`, '#fb923c');
    if (attackerUnit.troops > 0 && attackerUnit.statusEffect !== 'CONFUSED') {
      tryTriggerUnitTacticChain(state, attackerUnit, null, settlement, prng, dateStr);
    }
  }

  checkUnitElimination(state, attackerUnit, settlement.factionId, dateStr, prng);

  if (attackerUnit.troops > 0 && (settlement.troops <= 0 || settlement.wallDurability <= 0)) {
    captureSettlement(state, attackerUnit, settlement, dateStr, prng);
  }
}

/**
 * 尝试触发部队的兵法与 2~5 人联动 (SPEC-01 4.2)
 */
function tryTriggerUnitTacticChain(state, attackerUnit, targetUnit, targetSettlement, prng, dateStr) {
  const form = FORMATIONS[attackerUnit.formationId] || FORMATIONS.FISH_SCALE;
  const slots = attackerUnit.slots || [];

  let desperateBonus = 1.0;
  if (attackerUnit.troops < 6000 && slots.length >= 2) {
    desperateBonus = 1.35;
  }

  for (const initiatorSlot of slots) {
    const initiator = state.officers[initiatorSlot.officerId];
    if (!initiator) continue;

    const best = getBestTacticForOfficerInFormation(initiator, form, initiatorSlot.row);
    const rageBonus = attackerUnit.statusEffect === 'BLOOD_FEUD_RAGE' ? 1.3 : 1.0;
    const triggerProb = best.dailyProb * (attackerUnit.morale / 95) * rageBonus * desperateBonus;

    if (!prng.chance(triggerProb)) continue;

    const participants = [initiator];
    for (const otherSlot of slots) {
      if (otherSlot.officerId === initiator.id) continue;
      const other = state.officers[otherSlot.officerId];
      if (!other) continue;

      const bond = getOfficerBondInfo(initiator, other);
      if (bond.multiplier <= 0) continue;

      const sharesCategory = (other.learnedTactics || []).some(
        (tId) => TACTICS[tId]?.category === best.tactic.category
      );
      const catFactor = sharesCategory ? 1.15 : 0.65;
      const chainProb = clamp(0.26 * form.chainRateMod * bond.multiplier * catFactor, 0.05, 0.85);

      if (prng.chance(chainProb)) {
        participants.push(other);
      }
    }

    const chainCount = participants.length;
    const chainMult = CHAIN_MULTIPLIERS[Math.min(5, chainCount)] || 1.0;

    let rawDmgSum = 0;
    for (const p of participants) {
      const statVal = p[best.tactic.stat] || p.might || 75;
      const critMod = p.passiveTraits?.includes('flying_general') ? 1.3 : 1.0;
      rawDmgSum += best.tactic.power * (statVal / 75) * critMod * 9.5;
      if (p.proficiencies && best.tactic.category) {
        p.proficiencies[best.tactic.category] = Math.min(1000, p.proficiencies[best.tactic.category] + 18);
      }
    }

    const totalTacticDmg = Math.round(rawDmgSum * chainMult * prng.rangeFloat(0.95, 1.08));
    const namesStr = participants.map((p) => p.name).join(' · ');
    const chainLabel = chainCount >= 2 ? `【${chainCount}联动！】` : '';
    const faction = state.factions[attackerUnit.factionId];

    if (targetUnit) {
      applyTroopDamageAndWounded(targetUnit, totalTacticDmg, 0.30);
      targetUnit.morale = Math.max(0, targetUnit.morale - (4 + chainCount * 4));

      pushFloatingText(
        state,
        targetUnit.x,
        targetUnit.y,
        `⚡${chainLabel}${best.tactic.name} -${totalTacticDmg}`,
        '#fde047'
      );

      if (best.tactic.effect === 'ABSORB_TROOPS' || best.tactic.effect === 'ABSORB_AND_CONFUSE') {
        const absorbed = Math.round(totalTacticDmg * 0.28);
        attackerUnit.troops += absorbed;
      }
      if (best.tactic.effect === 'HEAL_WOUNDED') {
        const healed = Math.min(attackerUnit.wounded, 2200);
        attackerUnit.wounded -= healed;
        attackerUnit.troops += healed;
      }
      if (
        best.tactic.effect === 'CONFUSE' ||
        best.tactic.effect === 'ABSORB_AND_CONFUSE' ||
        (initiator.passiveTraits?.includes('gallop') && best.tactic.category === 'CAVALRY' && prng.chance(0.35))
      ) {
        targetUnit.statusEffect = 'CONFUSED';
        targetUnit.statusDurationTicks = 8;
      }

      const targetCmd = state.officers[targetUnit.slots[0]?.officerId];
      const targetName = targetCmd ? `${targetCmd.name}队` : '敌军';

      attackerUnit.lastTacticBanner = {
        text: `${namesStr} 发动【${best.tactic.name}】${chainLabel}`,
        chainCount,
        damage: totalTacticDmg,
        tick: state.meta.date.tickInXun,
      };

      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'TACTIC_CHAIN',
        text: `⚡ ${chainLabel}${namesStr} 对 ${targetName} 发动兵法【${best.tactic.name}】，斩敌 ${totalTacticDmg.toLocaleString()} 人，敌军士气动摇！`,
        highlight: chainCount >= 2,
        x: attackerUnit.x,
        y: attackerUnit.y,
      });

      if (chainCount >= 2 || totalTacticDmg >= 2000) {
        state.activeCutin = {
          id: Date.now() + Math.random(),
          officerNames: participants.map((p) => p.name),
          tacticName: best.tactic.name,
          chainCount,
          damage: totalTacticDmg,
          targetName,
          factionColor: faction?.color || '#3b82f6',
          barkText:
            chainCount >= 3
              ? '“吾等兄弟同心，天下谁人能挡！”'
              : '“全军突击，一举击溃敌阵！”',
        };
      }
    } else if (targetSettlement) {
      const wallDamage = Math.round((best.tactic.wallMod || 1.0) * 140 * chainMult);
      targetSettlement.troops = Math.max(0, targetSettlement.troops - totalTacticDmg);
      targetSettlement.wallDurability = Math.max(0, targetSettlement.wallDurability - wallDamage);

      pushFloatingText(
        state,
        targetSettlement.x,
        targetSettlement.y,
        `🔥${chainLabel}${best.tactic.name} -${totalTacticDmg}`,
        '#fde047'
      );

      attackerUnit.lastTacticBanner = {
        text: `${namesStr} 攻城【${best.tactic.name}】${chainLabel}`,
        chainCount,
        damage: totalTacticDmg,
        tick: state.meta.date.tickInXun,
      };

      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'TACTIC_CHAIN',
        text: `🔥 ${chainLabel}${namesStr} 对【${targetSettlement.name}】发动【${best.tactic.name}】，杀伤守军 ${totalTacticDmg.toLocaleString()}，城防耐久 -${wallDamage}！`,
        highlight: chainCount >= 2,
        x: targetSettlement.x,
        y: targetSettlement.y,
      });
    }

    break;
  }
}

/**
 * CK3 死敌遭遇检测：触发【死敌血战】
 */
function checkBloodFeudTrigger(state, unitA, unitB, dateStr) {
  if (unitA.statusEffect === 'BLOOD_FEUD_RAGE') return;
  for (const sa of unitA.slots) {
    const oa = state.officers[sa.officerId];
    if (!oa) continue;
    for (const sb of unitB.slots) {
      const ob = state.officers[sb.officerId];
      if (!ob) continue;
      if (oa.nemesisIds?.includes(ob.id) || ob.nemesisIds?.includes(oa.id)) {
        unitA.statusEffect = 'BLOOD_FEUD_RAGE';
        unitA.statusDurationTicks = 20;
        unitA.morale = Math.min(100, unitA.morale + 15);
        pushFloatingText(state, unitA.x, unitA.y, `💢死敌血战! 攻+25%`, '#ef4444');
        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'PERSONALITY',
          text: `💢【CK3 死敌血战】${oa.name} 在战场上遭遇宿敌 ${ob.name}！全军怒火中烧，攻击力 +25%、兵法触发率 +30%！`,
          highlight: true,
          x: unitA.x,
          y: unitA.y,
        });
        return;
      }
    }
  }
}

function applyTroopDamageAndWounded(unit, dmg, woundedRatio = 0.35) {
  const actualLoss = Math.min(unit.troops, Math.max(0, dmg));
  unit.troops -= actualLoss;
  unit.wounded += Math.round(actualLoss * woundedRatio);
}

/**
 * 判定部队是否因兵力归零或【士气归零溃灭】而消灭 (含战败武将生擒判定)
 */
export function checkUnitElimination(state, unit, victorFactionId, dateStr, prng = null) {
  if (!state.units[unit.id]) return;
  if (unit.troops > 0 && unit.morale > 0) return;

  const isMoraleWipeout = unit.troops > 0 && unit.morale <= 0;
  const cmdOfficer = state.officers[unit.slots[0]?.officerId];
  const unitName = cmdOfficer ? `${cmdOfficer.name}队` : `第${unit.id}部队`;

  pushFloatingText(
    state,
    unit.x,
    unit.y,
    isMoraleWipeout ? `🏳️士气崩溃溃灭!` : `💀全军覆没!`,
    '#ef4444'
  );

  state.battleLogs.unshift({
    id: Date.now() + Math.random(),
    dateStr,
    type: 'CAPTURE',
    text: isMoraleWipeout
      ? `🏳️【士气归零溃灭！】${unitName}（尚余兵力 ${unit.troops.toLocaleString()}）因士气彻底崩溃，全军当场溃散消灭！`
      : `⚔️【部队歼灭】${unitName} 全军覆没！`,
    highlight: true,
    x: unit.x,
    y: unit.y,
  });

  const faction = state.factions[unit.factionId];
  const fallbackId = faction?.capitalSettlementId || unit.originSettlementId;
  const victorCapId = victorFactionId ? state.factions[victorFactionId]?.capitalSettlementId : null;

  for (const slot of unit.slots) {
    const off = state.officers[slot.officerId];
    if (!off) continue;
    off.assignedUnitId = null;

    const isRuler = Object.values(state.factions).some((f) => f.rulerOfficerId === off.id);
    const hasFlying = off.passiveTraits?.includes('flying_general');

    // 若由交战触发 (传入了 prng 与 victorFactionId)，非君主且无飞将特技者有 42% 概率被生擒！
    if (prng && victorFactionId && victorFactionId !== unit.factionId && !isRuler && !hasFlying && prng.chance(0.42)) {
      off.capturedByFactionId = victorFactionId;
      off.locationSettlementId = victorCapId || fallbackId;
      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'CAPTURE',
        text: `⛓️【乱军生擒！】${state.factions[victorFactionId]?.name || '得胜'}军于溃兵之中生擒敌方名将【${off.name}】，押入大牢！`,
        highlight: true,
        x: unit.x,
        y: unit.y,
      });
    } else {
      off.locationSettlementId = fallbackId;
    }
  }

  delete state.units[unit.id];
}

/**
 * 攻克敌方城池或关隘港口 (含守城武将生擒判定与君主使命触发)
 */
function captureSettlement(state, attackerUnit, settlement, dateStr, prng = null) {
  const oldFactionId = settlement.factionId;
  const newFactionId = attackerUnit.factionId;
  const newFaction = state.factions[newFactionId];
  const cmdOfficer = state.officers[attackerUnit.slots[0]?.officerId];

  settlement.factionId = newFactionId;
  settlement.troops = attackerUnit.troops + Math.round(attackerUnit.wounded * 0.6);
  settlement.woundedTroops = Math.round(settlement.woundedTroops * 0.5);
  settlement.morale = 90;
  settlement.wallDurability = Math.round(settlement.maxWallDurability * 0.65);
  settlement.controlRate = 65;

  // 处理原守方驻城武将：部分被生擒，其余逃往原首都
  if (oldFactionId && state.factions[oldFactionId]) {
    const oldCap = state.factions[oldFactionId].capitalSettlementId;
    for (const off of Object.values(state.officers)) {
      if (
        off.factionId === oldFactionId &&
        off.locationSettlementId === settlement.id &&
        !off.assignedUnitId &&
        !off.capturedByFactionId
      ) {
        const isRuler = Object.values(state.factions).some((f) => f.rulerOfficerId === off.id);
        if (!isRuler && prng && prng.chance(0.48)) {
          off.capturedByFactionId = newFactionId;
          off.locationSettlementId = settlement.id;
          state.battleLogs.unshift({
            id: Date.now() + Math.random(),
            dateStr,
            type: 'CAPTURE',
            text: `⛓️【破城生擒！】我军攻破【${settlement.name}】之际，于城内生擒敌将【${off.name}】！`,
            highlight: true,
            x: settlement.x,
            y: settlement.y,
          });
        } else {
          off.locationSettlementId = oldCap;
        }
      }
    }
  }

  for (const slot of attackerUnit.slots) {
    const off = state.officers[slot.officerId];
    if (off) {
      off.assignedUnitId = null;
      off.locationSettlementId = settlement.id;
    }
  }
  settlement.prefectOfficerId = attackerUnit.slots[0]?.officerId || null;

  if (newFaction) {
    newFaction.prestige += settlement.type === 'MAJOR_CITY' ? 60 : 25;
  }

  pushFloatingText(state, settlement.x, settlement.y, `🚩攻占【${settlement.name}】!`, '#34d399');

  state.battleLogs.unshift({
    id: Date.now() + Math.random(),
    dateStr,
    type: 'CAPTURE',
    text: `🚩【攻陷据点！】${newFaction?.name || '我军'} 麾下 ${cmdOfficer?.name || '主力'} 攻克战略重镇【${settlement.name}】，声威震动中原！`,
    highlight: true,
    x: settlement.x,
    y: settlement.y,
  });

  delete state.units[attackerUnit.id];
}

// ============================================================================
// 📜 大地图军师计略系统 (伪报 / 扰乱 / 火计烧粮 / 离间)
// ============================================================================

/**
 * 执行大地图军师计略 (消耗 1 枚政令符 + 标记施法军师本旬已行动)
 * @param {object} state
 * @param {number} strategistId 施展计略的己方武将 ID
 * @param {'FALSE_ORDER' | 'CONFUSE_PLOY' | 'FIRE_SABOTAGE' | 'SOW_DISCORD'} ployType
 * @param {number} targetId 目标野战军团 ID 或目标据点 ID
 */
export function executeStrategicPloy(state, strategistId, ployType, targetId) {
  const strategist = state.officers[strategistId];
  if (!strategist || strategist.hasActedThisXun || strategist.assignedUnitId || strategist.capturedByFactionId) {
    return { ok: false, reason: '该军师本旬已执行过任务或正在出征中', msg: '该军师本旬已执行过任务或正在出征中' };
  }
  const faction = state.factions[strategist.factionId];
  if (!faction || (faction.commandSeals ?? 0) <= 0) {
    return { ok: false, reason: '本旬【君主政令符】已耗尽', msg: '本旬【君主政令符】已耗尽' };
  }

  const dateStr = formatGameDate(state.meta.date);
  const hasDivineCalc =
    strategist.passiveTraits?.includes('divine_calc') || strategist.passiveTraits?.includes('GOD_CALC'); // 【神算】特技必中！

  // 消耗 1 枚政令符并标记军师已行动
  faction.commandSeals -= 1;
  strategist.hasActedThisXun = true;

  // 若 FIRE_SABOTAGE 传入的是敌方据点 ID，则烧毁敌城粮仓与城防
  if (ployType === 'FIRE_SABOTAGE' && state.settlements[targetId] && !state.units[targetId]) {
    const targetCity = state.settlements[targetId];
    const burnedFood = Math.round(targetCity.food * 0.22);
    const wallDmg = Math.round(180 + strategist.intelligence * 1.5);
    targetCity.food = Math.max(1000, targetCity.food - burnedFood);
    targetCity.wallDurability = Math.max(100, targetCity.wallDurability - wallDmg);
    pushFloatingText(state, targetCity.x, targetCity.y, `🔥火计烧城! -${burnedFood}粮/-${wallDmg}墙`, '#f97316');
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `🔥【奇谋·火烧敌城！】军师【${strategist.name}】遣死士潜入【${targetCity.name}】纵火，焚毁敌仓兵粮 ${burnedFood.toLocaleString()}、烧毁城防 -${wallDmg}！`,
      highlight: true,
      x: targetCity.x,
      y: targetCity.y,
    });
    return { ok: true, succeeded: true, success: true };
  }

  // 若 SOW_DISCORD 传入的是敌方据点 ID，则离间该据点内守将与世家控制度
  if (ployType === 'SOW_DISCORD' && state.settlements[targetId] && !state.officers[targetId]) {
    const targetCity = state.settlements[targetId];
    targetCity.controlRate = Math.max(20, targetCity.controlRate - 12);
    targetCity.morale = Math.max(25, targetCity.morale - 10);
    const cityOfficers = Object.values(state.officers).filter(
      (o) => o.factionId === targetCity.factionId && o.locationSettlementId === targetCity.id
    );
    for (const off of cityOfficers) {
      off.loyalty = Math.max(35, (off.loyalty ?? 85) - 12);
    }
    pushFloatingText(state, targetCity.x, targetCity.y, `🗡️离间! 控制-12%/守将忠诚-12`, '#f43f5e');
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `🗡️【奇谋·反间离间！】军师【${strategist.name}】于【${targetCity.name}】散布反间流言，敌城控制度暴跌 -12%，守将人心惶惶！`,
      highlight: true,
      x: targetCity.x,
      y: targetCity.y,
    });
    return { ok: true, succeeded: true, success: true };
  }

  // 针对敌方野战军团的三大计略：伪报 (FALSE_ORDER)、扰乱 (CONFUSE_PLOY)、火计烧粮 (FIRE_SABOTAGE)
  if (ployType === 'FALSE_ORDER' || ployType === 'CONFUSE_PLOY' || ployType === 'FIRE_SABOTAGE') {
    const targetUnit = state.units[targetId];
    if (!targetUnit || targetUnit.factionId === strategist.factionId) {
      return { ok: false, reason: '目标敌方军团不存在', msg: '目标敌方军团不存在' };
    }

    // 计算敌方军团最高智力
    const enemyMaxInt = Math.max(
      50,
      ...targetUnit.slots.map((s) => state.officers[s.officerId]?.intelligence || 50)
    );
    const hasInsight = targetUnit.slots.some((s) =>
      state.officers[s.officerId]?.passiveTraits?.includes('insight')
    );

    const successProb = hasInsight
      ? 0
      : hasDivineCalc
      ? 1.0
      : clamp(0.68 + (strategist.intelligence - enemyMaxInt) * 0.015, 0.25, 0.95);

    // 确定性判定是否成功 (使用智力与当前回合种子)
    const roll = ((strategist.intelligence * 17 + targetUnit.id * 31 + state.meta.turnCount * 43) % 100) / 100;
    const succeeded = hasDivineCalc || (!hasInsight && roll <= successProb);
    const targetCmd = state.officers[targetUnit.slots[0]?.officerId];
    const targetName = `${targetCmd?.name || '敌军'}军团`;

    if (!succeeded) {
      pushFloatingText(state, targetUnit.x, targetUnit.y, `🛡️识破计略!`, '#94a3b8');
      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'POLITICS',
        text: `🛡️【计略被识破】${strategist.name} 对 ${targetName} 施展计略，被敌方智囊看破化解！`,
        x: targetUnit.x,
        y: targetUnit.y,
      });
      return { ok: true, succeeded: false, success: false };
    }

    if (ployType === 'FALSE_ORDER') {
      // 🌊【伪报】：强制敌军掉头退往出发城池！
      const originCity = state.settlements[targetUnit.originSettlementId];
      targetUnit.statusEffect = 'FALSE_REPORT_RETREAT';
      targetUnit.statusDurationTicks = 24;
      targetUnit.morale = Math.max(10, targetUnit.morale - 12);
      if (originCity) {
        targetUnit.order = {
          type: 'MARCH_AND_ATTACK',
          targetX: originCity.x,
          targetY: originCity.y,
          targetSettlementId: originCity.id,
          path: findPathAStar(state, targetUnit.x, targetUnit.y, originCity.x, originCity.y, targetUnit.formationId),
        };
      }
      pushFloatingText(state, targetUnit.x, targetUnit.y, `🌊中伪报! 强制退兵!`, '#38bdf8');
      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'POLITICS',
        text: `🌊【奇谋·伪报退敌！】军师【${strategist.name}(智${strategist.intelligence})】伪造虎符军令，成功诱使 ${targetName} 陷入【伪报退却】，强制调头撤回【${originCity?.name || '后方'}】！`,
        highlight: true,
        x: targetUnit.x,
        y: targetUnit.y,
      });
      return { ok: true, succeeded: true, success: true };
    }

    if (ployType === 'CONFUSE_PLOY') {
      // 💫【扰乱】：令敌军陷入混乱定身 3~4 天
      targetUnit.statusEffect = 'CONFUSED';
      targetUnit.statusDurationTicks = 16;
      targetUnit.morale = Math.max(10, targetUnit.morale - 10);
      pushFloatingText(state, targetUnit.x, targetUnit.y, `💫中扰乱! 陷入混乱!`, '#c084fc');
      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'POLITICS',
        text: `💫【奇谋·扰乱敌阵！】军师【${strategist.name}(智${strategist.intelligence})】设伏惑敌，令 ${targetName} 陷入【混乱】状态（无法移动与反击，防御暴跌）！`,
        highlight: true,
        x: targetUnit.x,
        y: targetUnit.y,
      });
      return { ok: true, succeeded: true, success: true };
    }

    if (ployType === 'FIRE_SABOTAGE') {
      // 🔥【火计烧粮】：焚毁敌军 35% 随军粮草并造成火焰伤亡
      const burnedFood = Math.round(targetUnit.foodCarried * 0.35);
      const fireTroopLoss = Math.round(900 + strategist.intelligence * 8);
      targetUnit.foodCarried = Math.max(0, targetUnit.foodCarried - burnedFood);
      targetUnit.troops = Math.max(500, targetUnit.troops - fireTroopLoss);
      targetUnit.morale = Math.max(10, targetUnit.morale - 14);
      pushFloatingText(state, targetUnit.x, targetUnit.y, `🔥火计! -${burnedFood}粮/-${fireTroopLoss}兵`, '#f97316');
      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'POLITICS',
        text: `🔥【奇谋·火烧连营！】军师【${strategist.name}】遣死士夜袭 ${targetName} 粮营，焚毁兵粮 ${burnedFood.toLocaleString()}、烧死敌兵 ${fireTroopLoss.toLocaleString()} 人！`,
        highlight: true,
        x: targetUnit.x,
        y: targetUnit.y,
      });
      return { ok: true, succeeded: true, success: true };
    }
  }

  // 💔【离间计 (SOW_DISCORD)】：针对敌方某座据点内的驻城武将，大幅削减忠诚度
  if (ployType === 'SOW_DISCORD') {
    const targetOfficer = state.officers[targetId];
    if (!targetOfficer || targetOfficer.factionId === strategist.factionId) {
      return { ok: false, reason: '目标敌将不存在' };
    }
    const drop = Math.round(14 + Math.max(0, strategist.intelligence - targetOfficer.intelligence) * 0.25);
    targetOfficer.loyalty = Math.max(30, targetOfficer.loyalty - drop);
    const city = state.settlements[targetOfficer.locationSettlementId];
    if (city) {
      pushFloatingText(state, city.x, city.y, `💔离间${targetOfficer.name} 忠诚-${drop}`, '#f43f5e');
    }
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `💔【反间计成！】${strategist.name} 散布流言离间【${targetOfficer.name}】与其主公，其忠诚度暴跌 -${drop}（当前忠诚 ${targetOfficer.loyalty}，可趁机登庸挖角）！`,
      highlight: true,
      x: city?.x,
      y: city?.y,
    });
    return { ok: true, succeeded: true };
  }

  return { ok: false, reason: '未知计略类型' };
}

// ============================================================================
// ⛓️ 战俘大牢与人才登庸系统 (招降 / 辕门斩首触发CK3死敌血仇 / 礼送释放)
// ============================================================================

/**
 * 对关押在牢中的敌方战俘或低忠诚度敌将执行【登庸招降 / 辕门斩首 / 礼送释放】
 * @param {object} state
 * @param {number} rulerFactionId 当前君主势力 ID
 * @param {number} targetOfficerId 目标战俘或敌将 ID
 * @param {'RECRUIT' | 'EXECUTE' | 'RELEASE'} actionType
 */
export function executePrisonerAction(state, rulerFactionId, targetOfficerId, actionType) {
  const faction = state.factions[rulerFactionId];
  const ruler = faction ? state.officers[faction.rulerOfficerId] : null;
  const target = state.officers[targetOfficerId];
  if (!faction || !ruler || !target) return { ok: false, reason: '武将或势力不存在' };

  const dateStr = formatGameDate(state.meta.date);

  if (actionType === 'RECRUIT') {
    if ((faction.commandSeals ?? 0) <= 0) {
      return { ok: false, reason: '本旬【君主政令符】已耗尽' };
    }
    faction.commandSeals -= 1;

    // 判断是否与君主互为血仇死敌 (死敌绝不投降!)
    if (target.nemesisIds?.includes(ruler.id) || ruler.nemesisIds?.includes(target.id)) {
      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'POLITICS',
        text: `💢【宁死不降！】${target.name} 怒斥使者：“吾与${ruler.name}有不共戴天之仇，纵死刀下亦绝不屈膝！”`,
        highlight: true,
      });
      return { ok: true, recruited: false };
    }

    const compatDist = getCompatibilityDistance(ruler.compatibility, target.compatibility);
    const isPrisoner = target.capturedByFactionId === rulerFactionId;
    const canRecruit = isPrisoner
      ? compatDist <= 38 || target.loyalty <= 82 || faction.prestige >= 500
      : target.loyalty <= 76 && compatDist <= 30;

    if (!canRecruit) {
      target.loyalty = Math.max(50, target.loyalty - 6);
      state.battleLogs.unshift({
        id: Date.now() + Math.random(),
        dateStr,
        type: 'POLITICS',
        text: `📜【登庸未果】${target.name} 感念旧主恩义，暂未应允归顺（忠诚松动至 ${target.loyalty}，可先对其施展【离间】）。`,
      });
      return { ok: true, recruited: false };
    }

    // 成功招降归顺！
    target.factionId = rulerFactionId;
    target.capturedByFactionId = null;
    target.assignedUnitId = null;
    target.locationSettlementId = faction.capitalSettlementId;
    target.loyalty = 88;
    target.hasActedThisXun = false;

    const cap = state.settlements[faction.capitalSettlementId];
    if (cap) {
      pushFloatingText(state, cap.x, cap.y, `🤝名将【${target.name}】归顺!`, '#34d399');
    }

    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `🤝【天下归心·名将归降！】${ruler.name} 亲自解缚礼遇，猛将【${target.name}(统${target.leadership}/武${target.might}/智${target.intelligence})】拜服归顺我军！`,
      highlight: true,
      x: cap?.x,
      y: cap?.y,
    });
    return { ok: true, recruited: true };
  }

  if (actionType === 'EXECUTE') {
    // ⚔️【辕门斩首】：处决战俘，触发 CK3 家族与义兄弟血仇机制！
    const victimName = target.name;
    const newNemeses = [];

    for (const other of Object.values(state.officers)) {
      if (other.id === target.id) continue;
      const isSworn =
        target.swornBrotherIds?.includes(other.id) || other.swornBrotherIds?.includes(target.id);
      const isBloodKin = target.bloodLineId && other.bloodLineId === target.bloodLineId;
      const isSpouse = target.spouseId === other.id || other.spouseId === target.id;

      if (isSworn || isBloodKin || isSpouse) {
        if (!other.nemesisIds) other.nemesisIds = [];
        if (!other.nemesisIds.includes(ruler.id)) {
          other.nemesisIds.push(ruler.id);
        }
        if (!ruler.nemesisIds) ruler.nemesisIds = [];
        if (!ruler.nemesisIds.includes(other.id)) {
          ruler.nemesisIds.push(other.id);
        }
        newNemeses.push(other.name);
      }
    }

    delete state.officers[targetOfficerId];

    const nemesisNote =
      newNemeses.length > 0
        ? `其血亲与义兄弟【${newNemeses.join('、')}】悲愤欲绝，从此视 ${ruler.name} 为不共戴天的【血仇死敌】！`
        : '敌胆俱寒！';

    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `⚔️【辕门斩首 · 血仇结怨！】${ruler.name} 下令将战俘【${victimName}】推辕门斩首示众！${nemesisNote}`,
      highlight: true,
    });
    return { ok: true, executed: true, newNemeses };
  }

  if (actionType === 'RELEASE') {
    // 🕊️【礼送出境】：释放战俘回原主公首都，君主信望 +15
    const origFac = state.factions[target.factionId];
    target.capturedByFactionId = null;
    target.locationSettlementId = origFac?.capitalSettlementId || faction.capitalSettlementId;
    faction.prestige += 15;

    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `🕊️【义释战俘】${ruler.name} 彰显仁德，将战俘【${target.name}】礼送出境，朝廷信望提升 +15（当前信望 ${faction.prestige}）！`,
      highlight: true,
    });
    return { ok: true, released: true };
  }

  return { ok: false, reason: '未知操作' };
}
