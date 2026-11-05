/**
 * SPEC-01: 十日一“旬” (40 Ticks) 自动进行阶段步进推演引擎
 * 处理：
 * - 每日 4 个子时间片 (40 Ticks/旬) 的行军移动与 ZOC 阻挡
 * - 野外连弩橹/前哨阵自动射击
 * - 野战与攻城战自动结算、兵法 2~5 联动、伤兵与士气归零溃灭
 * - 每日兵粮消耗与断粮士气崩盘
 * - 旬末推进至下一旬并触发被动内政、人口迁徙与自动漕运网结算
 */

import { FORMATIONS } from '../../data/tacticsAndFormations.js';
import { runAIFactionsStrategyPhase } from '../ai/aiEngine.js';
import {
  checkUnitElimination,
  resolveFieldBattleStep,
  resolveSiegeBattleStep,
} from '../combat/combatEngine.js';
import { runXunEconomyAndPoliticsSettlement } from '../economy/economyEngine.js';
import { findPathAStar, getHexDistance, isInEnemyZOC } from '../map/pathfinder.js';
import { formatGameDate, SeededPRNG } from '../utils/prng.js';

/**
 * 从战略阶段启动 10 天 (40 Ticks) 进行阶段
 */
export function startExecutionPhase(state) {
  const prng = new SeededPRNG(state.meta.seed + state.meta.turnCount * 97);
  // 合并后台 AI 势力的本旬指令
  runAIFactionsStrategyPhase(state, prng);

  state.meta.phase = 'EXECUTION_PHASE';
  state.meta.date.dayInXun = 1;
  state.meta.date.tickInXun = 0;
  state.activeCutin = null;
}

/**
 * 推进 1 个模拟子步 (1 Tick = 1/4 天，40 Ticks = 1 旬)
 * 返回 { finishedXun: boolean }
 */
export function stepExecutionTick(state) {
  if (state.meta.phase !== 'EXECUTION_PHASE') {
    return { finishedXun: true };
  }

  const tick = state.meta.date.tickInXun;
  const dayInXun = Math.floor(tick / 4) + 1;
  state.meta.date.dayInXun = dayInXun;
  const isNewDayTick = tick % 4 === 0;
  const prng = new SeededPRNG(state.meta.seed + state.meta.turnCount * 1009 + tick * 31);
  const dateStr = formatGameDate(state.meta.date, true);

  // 清除上一 Tick 的短暂特效横幅
  state.activeCutin = null;

  const units = Object.values(state.units);

  // 1. 更新部队异常状态持续时间与每日粮草消耗
  for (const u of units) {
    if (!state.units[u.id]) continue;
    if (u.statusDurationTicks > 0) {
      u.statusDurationTicks -= 1;
      if (u.statusDurationTicks <= 0) u.statusEffect = 'NORMAL';
    }

    // 每日兵粮消耗与士气自然损耗 (SPEC-01 4.2)
    if (isNewDayTick) {
      const hasTuntian = u.slots.some((s) =>
        state.officers[s.officerId]?.passiveTraits?.includes('tuntian_master')
      );
      const dailyFoodCost = Math.round((u.troops / 1000) * (hasTuntian ? 18 : 28));
      if (u.foodCarried >= dailyFoodCost) {
        u.foodCarried -= dailyFoodCost;
      } else {
        u.foodCarried = 0;
        u.morale = Math.max(0, u.morale - 6);
        u.troops = Math.max(0, Math.round(u.troops * 0.97));
        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'COMBAT',
          text: `⚠️【军粮断绝！】第${u.id}部队军粮耗尽，全军士气暴跌且发生士兵逃亡！`,
          highlight: true,
          x: u.x,
          y: u.y,
        });
        checkUnitElimination(state, u, null, dateStr);
      }

      // 远离己方据点每 2 天下降 1 点士气
      if (dayInXun % 2 === 0 && state.units[u.id]) {
        u.morale = Math.max(0, u.morale - 1);
        checkUnitElimination(state, u, null, dateStr);
      }
    }
  }

  // 2. 推进部队移动与接敌判定
  for (const u of Object.values(state.units)) {
    if (!state.units[u.id] || u.statusEffect === 'CONFUSED') continue;

    // 检查周围射程内是否有敌方部队或目标据点
    const form = FORMATIONS[u.formationId] || FORMATIONS.FISH_SCALE;
    const attackRange = Math.max(1, form.range || 1);

    // 优先检查周围是否有敌方野战部队进入六边形交战距离
    const adjacentEnemyUnit = Object.values(state.units).find(
      (other) =>
        other.id !== u.id &&
        other.factionId !== u.factionId &&
        getHexDistance(other.x, other.y, u.x, u.y) <= attackRange
    );

    if (adjacentEnemyUnit) {
      resolveFieldBattleStep(state, u, adjacentEnemyUnit, prng, isNewDayTick);
      continue;
    }

    // 检查是否已抵达敌方据点攻城距离
    const targetSettlement =
      u.order?.targetSettlementId != null
        ? state.settlements[u.order.targetSettlementId]
        : Object.values(state.settlements).find(
            (s) =>
              s.factionId !== u.factionId &&
              getHexDistance(s.x, s.y, u.x, u.y) <= attackRange
          );

    if (
      targetSettlement &&
      targetSettlement.factionId !== u.factionId &&
      getHexDistance(targetSettlement.x, targetSettlement.y, u.x, u.y) <= attackRange
    ) {
      resolveSiegeBattleStep(state, u, targetSettlement, prng, isNewDayTick);
      continue;
    }

    // 若未接敌，则按阵型速度与 ZOC 规则沿路径前进一步
    const moveInterval = form.speed >= 125 ? 2 : form.speed >= 90 ? 3 : 4;
    const hasFlying = u.slots.some((s) =>
      state.officers[s.officerId]?.passiveTraits?.includes('flying_general')
    );
    const inZOC = isInEnemyZOC(state, u.x, u.y, u.factionId, hasFlying);
    const effectiveInterval = inZOC ? 4 : moveInterval;

    if (tick % effectiveInterval === 0 && u.order) {
      if (!u.order.path || u.order.path.length === 0) {
        if (u.x !== u.order.targetX || u.y !== u.order.targetY) {
          u.order.path = findPathAStar(
            state,
            u.x,
            u.y,
            u.order.targetX,
            u.order.targetY,
            u.formationId
          );
        }
      }

      if (u.order.path && u.order.path.length > 0) {
        const [nx, ny] = u.order.path[0];
        // 检查下一格是否被敌方据点本体占据
        const blockedByEnemyBase = Object.values(state.settlements).some(
          (s) => s.factionId !== u.factionId && s.x === nx && s.y === ny
        );
        const blockedByEnemyUnit = Object.values(state.units).some(
          (other) => other.factionId !== u.factionId && other.x === nx && other.y === ny
        );

        if (!blockedByEnemyBase && !blockedByEnemyUnit) {
          u.x = nx;
          u.y = ny;
          u.order.path.shift();
        }
      }
    }
  }

  // 3. 大地图军事设施 (连弩橹/前哨阵) 每日自动对 2 格内敌军齐射 (SPEC-01)
  if (isNewDayTick) {
    for (const fac of Object.values(state.facilities || {})) {
      if (fac.durability <= 0) continue;
      const targetEnemy = Object.values(state.units).find(
        (u) =>
          u.factionId !== fac.factionId &&
          Math.max(Math.abs(u.x - fac.x), Math.abs(u.y - fac.y)) <= 2
      );
      if (targetEnemy) {
        const towerDmg = fac.type === 'TOWER' ? 480 : 320;
        targetEnemy.troops = Math.max(0, targetEnemy.troops - towerDmg);
        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'COMBAT',
          text: `🏹【设施兵法】${fac.name} 自动向逼近的敌军发射连弩齐射，杀伤敌兵 ${towerDmg} 人！`,
          x: fac.x,
          y: fac.y,
        });
        checkUnitElimination(state, targetEnemy, fac.factionId, dateStr);
      }
    }
  }

  // 限制战报长度避免内存膨胀
  if (state.battleLogs.length > 80) {
    state.battleLogs.length = 80;
  }

  // 4. 推进 Tick 计数器；若满 40 Ticks 则完成本旬并进入下一旬战略阶段
  state.meta.date.tickInXun += 1;
  if (state.meta.date.tickInXun >= 40) {
    advanceCalendarToNextXun(state);
    return { finishedXun: true };
  }

  return { finishedXun: false };
}

/**
 * 结束本旬 10 天推演，推进日历至下一旬并执行旬初经济/人口/世家/漕运结算
 */
export function advanceCalendarToNextXun(state) {
  const d = state.meta.date;
  d.tickInXun = 0;
  d.dayInXun = 1;

  if (d.xun < 2) {
    d.xun += 1;
  } else {
    d.xun = 0;
    if (d.month < 12) {
      d.month += 1;
    } else {
      d.month = 1;
      d.year += 1;
    }
  }

  state.meta.turnCount += 1;
  state.meta.phase = 'STRATEGY_PHASE';

  // 重置所有武将本旬行动标记
  for (const off of Object.values(state.officers)) {
    off.hasActedThisXun = false;
  }

  // 执行旬初被动经济、四阶人口、世家门阀与自动军需漕运网结算
  runXunEconomyAndPoliticsSettlement(state);
}
