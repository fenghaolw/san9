/**
 * SPEC-01 & SPEC-02: 5将三列阵型攻防、9系兵法泊松触发、基于血缘/义兄弟/相性的 2~5 人联动解算、
 * CK3 战场自主性格反应 (死敌血战/临危不乱/同生共死)、伤兵转化与士气归零溃灭引擎
 */

import { FORMATIONS, TACTICS, TERRAIN_DEFS } from '../../data/tacticsAndFormations.js';
import { clamp, formatGameDate, getCompatibilityDistance } from '../utils/prng.js';

const CHAIN_MULTIPLIERS = [1.0, 1.0, 1.35, 1.75, 2.25, 3.0];

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

  // 按统率与君主身份自动判定主将
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

  // 计算每位武将的单日最佳兵法触发率
  const officerTriggerRates = {};
  let combinedDailyNoTrigger = 1.0;

  for (const slot of validSlots) {
    const off = state.officers[slot.officerId];
    const best = getBestTacticForOfficerInFormation(off, form, slot.row);
    officerTriggerRates[off.id] = best;
    combinedDailyNoTrigger *= 1 - best.dailyProb;
  }

  // 一旬 5 个有效交战日的预期至少触发一次兵法概率
  const estTriggerProbPerXun = Math.round((1 - Math.pow(combinedDailyNoTrigger, 4)) * 100);

  // 计算两两之间的联动羁绊线
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
 * 计算部队当前基础攻击力与防御力 (SPEC-01 4.2)
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
    (hasIronWall ? 1.25 : 1.0);

  return { atk, def, effLDR, form };
}

/**
 * 结算两支野外敌对部队的单步交战 (含 CK3 战场性格自主触发 + 兵法 2~5 联动 + 伤兵与士气归零溃灭)
 */
export function resolveFieldBattleStep(state, unitA, unitB, prng, isTacticRollTick = false) {
  if (unitA.troops <= 0 || unitB.troops <= 0) return;

  const statsA = computeUnitCombatStats(state, unitA);
  const statsB = computeUnitCombatStats(state, unitB);
  const dateStr = formatGameDate(state.meta.date, true);

  // 1. CK3 战场死敌检测 (【死敌血战】)
  checkBloodFeudTrigger(state, unitA, unitB, dateStr);
  checkBloodFeudTrigger(state, unitB, unitA, dateStr);

  // 2. 普通交战伤害结算
  const dmgToB = Math.round(
    18 * (Math.pow(statsA.atk, 1.22) / Math.max(25, statsB.def)) * prng.rangeFloat(0.92, 1.08)
  );
  const dmgToA = Math.round(
    18 * (Math.pow(statsB.atk, 1.22) / Math.max(25, statsA.def)) * prng.rangeFloat(0.92, 1.08)
  );

  applyTroopDamageAndWounded(unitB, dmgToB, 0.35);
  applyTroopDamageAndWounded(unitA, dmgToA, 0.35);

  // 3. 每逢交战日 (每 4 Ticks) 判定兵法触发与 2~5 人联动
  if (isTacticRollTick) {
    if (unitA.troops > 0 && unitB.troops > 0 && unitA.statusEffect !== 'CONFUSED') {
      tryTriggerUnitTacticChain(state, unitA, unitB, null, prng, dateStr);
    }
    if (unitB.troops > 0 && unitA.troops > 0 && unitB.statusEffect !== 'CONFUSED') {
      tryTriggerUnitTacticChain(state, unitB, unitA, null, prng, dateStr);
    }
  }

  // 4. 判定士气归零溃灭或兵力归零歼灭
  checkUnitElimination(state, unitA, unitB.factionId, dateStr);
  checkUnitElimination(state, unitB, unitA.factionId, dateStr);
}

/**
 * 结算部队攻城战单步 (针对敌方都市、关隘、港口)
 */
export function resolveSiegeBattleStep(state, attackerUnit, settlement, prng, isTacticRollTick = false) {
  if (attackerUnit.troops <= 0) return;

  const statsAtk = computeUnitCombatStats(state, attackerUnit);
  const dateStr = formatGameDate(state.meta.date, true);

  // 守城方有效防御
  const prefect = settlement.prefectOfficerId ? state.officers[settlement.prefectOfficerId] : null;
  const defLDR = prefect ? prefect.leadership : 78;
  const hasIronWall = prefect?.passiveTraits?.includes('iron_wall');
  const settlementDef = defLDR * 1.35 * (hasIronWall ? 1.25 : 1.0);

  // 攻城方对守军与城墙伤害
  const isSiegeForm = attackerUnit.formationId === 'SIEGE_TOWER' || attackerUnit.formationId === 'CATAPULT';
  const troopDmg = Math.round(
    16 * (Math.pow(statsAtk.atk, 1.2) / Math.max(30, settlementDef)) * prng.rangeFloat(0.9, 1.1)
  );
  const wallDmg = Math.round((isSiegeForm ? 48 : 16) * (statsAtk.effLDR / 80));

  // 守城方还击伤害 (远程阵型或投石攻城受到的反击减半)
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

  // 攻城兵法与联动触发
  if (isTacticRollTick && attackerUnit.troops > 0 && attackerUnit.statusEffect !== 'CONFUSED') {
    tryTriggerUnitTacticChain(state, attackerUnit, null, settlement, prng, dateStr);
  }

  // 检查攻城部队是否溃灭
  checkUnitElimination(state, attackerUnit, settlement.factionId, dateStr);

  // 检查据点是否被攻陷 (守军归零 或 城墙耐久归零)
  if (attackerUnit.troops > 0 && (settlement.troops <= 0 || settlement.wallDurability <= 0)) {
    captureSettlement(state, attackerUnit, settlement, dateStr);
  }
}

/**
 * 尝试触发部队的兵法与 2~5 人联动 (SPEC-01 4.2)
 */
function tryTriggerUnitTacticChain(state, attackerUnit, targetUnit, targetSettlement, prng, dateStr) {
  const form = FORMATIONS[attackerUnit.formationId] || FORMATIONS.FISH_SCALE;
  const slots = attackerUnit.slots || [];

  // 检查 CK3【同生共死】残血爆发
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

    // 成功触发兵法！开始判定同队其他武将是否响应 2~5 联动
    const participants = [initiator];
    for (const otherSlot of slots) {
      if (otherSlot.officerId === initiator.id) continue;
      const other = state.officers[otherSlot.officerId];
      if (!other) continue;

      const bond = getOfficerBondInfo(initiator, other);
      if (bond.multiplier <= 0) continue; // 死敌绝不联动

      // 检查是否也掌握同系或兼容兵法
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

    // 累加参与武将的兵法伤害
    let rawDmgSum = 0;
    for (const p of participants) {
      const statVal = p[best.tactic.stat] || p.might || 75;
      const critMod = p.passiveTraits?.includes('flying_general') ? 1.3 : 1.0;
      rawDmgSum += best.tactic.power * (statVal / 75) * critMod * 9.5;
      // 增长兵法熟练度
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

      // 攻心/心攻吸收敌军兵力
      if (best.tactic.effect === 'ABSORB_TROOPS' || best.tactic.effect === 'ABSORB_AND_CONFUSE') {
        const absorbed = Math.round(totalTacticDmg * 0.28);
        attackerUnit.troops += absorbed;
      }
      // 治疗恢复本队伤兵
      if (best.tactic.effect === 'HEAL_WOUNDED') {
        const healed = Math.min(attackerUnit.wounded, 2200);
        attackerUnit.wounded -= healed;
        attackerUnit.troops += healed;
      }
      // 疾驰或谋略附加混乱
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

    break; // 每交战日每队最多主导一次大兵法演出
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
 * 判定部队是否因兵力归零或【士气归零溃灭】而消灭
 */
export function checkUnitElimination(state, unit, victorFactionId, dateStr) {
  if (!state.units[unit.id]) return;
  if (unit.troops > 0 && unit.morale > 0) return;

  const isMoraleWipeout = unit.troops > 0 && unit.morale <= 0;
  const cmdOfficer = state.officers[unit.slots[0]?.officerId];
  const unitName = cmdOfficer ? `${cmdOfficer.name}队` : `第${unit.id}部队`;

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

  // 释放随军武将回所属城池（若所属城池已失守则回首都）
  const faction = state.factions[unit.factionId];
  const fallbackId = faction?.capitalSettlementId || unit.originSettlementId;

  for (const slot of unit.slots) {
    const off = state.officers[slot.officerId];
    if (off) {
      off.assignedUnitId = null;
      off.locationSettlementId = fallbackId;
    }
  }

  delete state.units[unit.id];
}

/**
 * 攻克敌方城池或关隘港口
 */
function captureSettlement(state, attackerUnit, settlement, dateStr) {
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

  // 撤出原守方武将至其首都
  if (oldFactionId && state.factions[oldFactionId]) {
    const oldCap = state.factions[oldFactionId].capitalSettlementId;
    for (const off of Object.values(state.officers)) {
      if (off.factionId === oldFactionId && off.locationSettlementId === settlement.id && !off.assignedUnitId) {
        off.locationSettlementId = oldCap;
      }
    }
  }

  // 攻城部队进驻新占领的据点
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
