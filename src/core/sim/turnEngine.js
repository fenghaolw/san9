/**
 * SPEC-01 (v1.2): 十日一“旬” (40 Ticks) 自动进行阶段步进推演引擎
 * 处理：
 * - 快节奏行军移动 (提速 60%) 与六边形 ZOC 阻挡
 * - ⚔️ 据点【迎击 (INTERCEPT)】方针：敌军踏入 3 格警戒圈时守军自动出城野战拦截
 * - 🏰 野外【城塞 (FORTRESS)】友军休整治愈伤兵 + 【连弩橹 (TOWER)】自动远程齐射
 * - 野战与攻城战自动结算、疆场单挑、兵法 2~5 联动、伤兵与士气归零溃灭
 * - 旬末推进至下一旬、恢复【君主政令符】、校验【君主破局使命】并触发【历史危机事件抉择】
 */

import { FORMATIONS } from '../../data/tacticsAndFormations.js';
import { runAIFactionsStrategyPhase } from '../ai/aiEngine.js';
import {
  checkUnitElimination,
  pushCombatBeam,
  pushFloatingText,
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

  state.activeCutin = null;
  // 每 Tick 清空瞬时刀光箭雨射线，仅保留本 Tick 新触发的交战轨迹
  state.combatEffects = [];

  // 0. 每日触发：据点【迎击 (INTERCEPT)】自动出城拦截检测
  if (isNewDayTick) {
    triggerSettlementInterceptions(state, dateStr);
  }

  const units = Object.values(state.units);

  // 1. 更新部队异常状态持续时间与每日粮草消耗
  for (const u of units) {
    if (!state.units[u.id]) continue;
    if (u.statusDurationTicks > 0) {
      u.statusDurationTicks -= 1;
      if (u.statusDurationTicks <= 0) u.statusEffect = 'NORMAL';
    }

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
        pushFloatingText(state, u.x, u.y, `⚠️断粮! 士气-6`, '#ef4444');
        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'COMBAT',
          text: `⚠️【军粮断绝！】第${u.id}部队军粮耗尽，全军士气暴跌且发生士兵逃亡！`,
          highlight: true,
          x: u.x,
          y: u.y,
        });
        checkUnitElimination(state, u, null, dateStr, prng);
      }

      if (dayInXun % 2 === 0 && state.units[u.id]) {
        u.morale = Math.max(0, u.morale - 1);
        checkUnitElimination(state, u, null, dateStr, prng);
      }
    }
  }

  // 2. 推进部队移动与接敌判定 (行军速度提升 60%)
  for (const u of Object.values(state.units)) {
    if (!state.units[u.id] || u.statusEffect === 'CONFUSED') continue;

    const form = FORMATIONS[u.formationId] || FORMATIONS.FISH_SCALE;
    const attackRange = Math.max(1, form.range || 1);

    // 若部队处于【伪报退却 (FALSE_REPORT_RETREAT)】状态，不主动接战，全速撤回出发城池
    if (u.statusEffect !== 'FALSE_REPORT_RETREAT') {
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
    }

    // 若未接敌（或正在伪报退却），沿六边形路径高速推进
    const moveInterval = form.speed >= 120 ? 1 : form.speed >= 85 ? 2 : 3;
    const hasFlying = u.slots.some((s) =>
      state.officers[s.officerId]?.passiveTraits?.includes('flying_general')
    );
    const inZOC = isInEnemyZOC(state, u.x, u.y, u.factionId, hasFlying);
    const effectiveInterval = inZOC ? moveInterval + 1 : moveInterval;

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

  // 3. 大地图军事设施 (城塞 FORTRESS 友军休整治愈 + 连弩橹 TOWER 自动齐射)
  if (isNewDayTick) {
    for (const fac of Object.values(state.facilities || {})) {
      if (fac.durability <= 0) continue;

      // 3.1 【城塞 (FORTRESS)】为 1 格内友军提供伤兵治愈与士气鼓舞
      if (fac.type === 'FORTRESS') {
        for (const friendlyUnit of Object.values(state.units)) {
          if (
            friendlyUnit.factionId === fac.factionId &&
            getHexDistance(friendlyUnit.x, friendlyUnit.y, fac.x, fac.y) <= 1
          ) {
            const healed = Math.min(friendlyUnit.wounded || 0, 450);
            if (healed > 0 || friendlyUnit.morale < 100) {
              friendlyUnit.wounded -= healed;
              friendlyUnit.troops += healed;
              friendlyUnit.morale = Math.min(100, friendlyUnit.morale + 3);
              pushFloatingText(
                state,
                friendlyUnit.x,
                friendlyUnit.y,
                `🏰城塞支援 +${healed}兵/+3士气`,
                '#34d399'
              );
            }
          }
        }
      }

      // 3.2 对 2 格内敌军自动发射连弩齐射
      const targetEnemy = Object.values(state.units).find(
        (u) =>
          u.factionId !== fac.factionId &&
          getHexDistance(u.x, u.y, fac.x, fac.y) <= 2
      );
      if (targetEnemy) {
        const towerDmg = fac.type === 'FORTRESS' ? 620 : 480;
        targetEnemy.troops = Math.max(0, targetEnemy.troops - towerDmg);
        const facOwner = state.factions[fac.factionId];
        pushCombatBeam(state, fac.x, fac.y, targetEnemy.x, targetEnemy.y, facOwner?.color || '#f59e0b', 'ARROW');
        pushFloatingText(state, targetEnemy.x, targetEnemy.y, `🏹${fac.name} -${towerDmg}`, '#fbbf24');

        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'COMBAT',
          text: `🏹【要塞齐射】${fac.name} 自动向逼近的敌军倾泻箭雨，杀伤敌兵 ${towerDmg} 人！`,
          x: fac.x,
          y: fac.y,
        });
        checkUnitElimination(state, targetEnemy, fac.factionId, dateStr, prng);
      }
    }
  }

  if (state.battleLogs.length > 90) {
    state.battleLogs.length = 90;
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
 * ⚔️ 据点【迎击 (INTERCEPT)】机制：当敌军踏入据点 3 格内时，守军自动出城拦截决战
 */
function triggerSettlementInterceptions(state, dateStr) {
  for (const s of Object.values(state.settlements)) {
    if (s.defenseStance !== 'INTERCEPT' || s.troops < 15000 || s.food < 12000) continue;

    // 寻找踏入本城 3 格警戒圈内的敌方部队
    const intruder = Object.values(state.units).find(
      (u) =>
        u.factionId !== s.factionId &&
        u.troops > 0 &&
        getHexDistance(u.x, u.y, s.x, s.y) <= 3
    );
    if (!intruder) continue;

    // 检查是否已有本方野战部队在拦截该敌军
    const alreadyIntercepting = Object.values(state.units).some(
      (u) =>
        u.factionId === s.factionId &&
        getHexDistance(u.x, u.y, intruder.x, intruder.y) <= 2
    );
    if (alreadyIntercepting) continue;

    const idleOfficers = Object.values(state.officers)
      .filter(
        (o) =>
          o.factionId === s.factionId &&
          o.locationSettlementId === s.id &&
          !o.assignedUnitId &&
          !o.capturedByFactionId
      )
      .sort((a, b) => b.leadership + b.might * 0.4 - (a.leadership + a.might * 0.4));

    if (idleOfficers.length === 0) continue;

    const picked = idleOfficers.slice(0, Math.min(3, idleOfficers.length));
    const mobilizeTroops = Math.min(13000, Math.floor((s.troops * 0.42) / 1000) * 1000);
    if (mobilizeTroops < 5000) continue;

    let formId = 'LONG_SNAKE';
    if ((s.arsenal?.infantryArms || 0) >= mobilizeTroops) {
      formId = 'FISH_SCALE';
      s.arsenal.infantryArms -= mobilizeTroops;
    } else if ((s.arsenal?.warhorses || 0) >= mobilizeTroops) {
      formId = 'ARROWHEAD';
      s.arsenal.warhorses -= mobilizeTroops;
    }

    const slots = picked.map((o, idx) => ({
      officerId: o.id,
      row: idx === 0 ? 'FRONT' : 'MIDDLE',
      isCommander: idx === 0,
    }));

    const newUnitId = Math.max(0, ...Object.keys(state.units).map(Number)) + 1;
    const foodTaken = Math.min(s.food - 4000, Math.round(mobilizeTroops * 1.4));
    s.troops -= mobilizeTroops;
    s.food -= foodTaken;

    state.units[newUnitId] = {
      id: newUnitId,
      factionId: s.factionId,
      originSettlementId: s.id,
      formationId: formId,
      slots,
      troops: mobilizeTroops,
      wounded: 0,
      morale: s.morale,
      goldCarried: 300,
      foodCarried: foodTaken,
      x: s.x,
      y: s.y,
      order: {
        type: 'MARCH_AND_ATTACK',
        targetX: intruder.x,
        targetY: intruder.y,
        path: findPathAStar(state, s.x, s.y, intruder.x, intruder.y, formId),
      },
      statusEffect: 'NORMAL',
      statusDurationTicks: 0,
      lastTacticBanner: null,
    };

    for (const slot of slots) {
      state.officers[slot.officerId].assignedUnitId = newUnitId;
    }

    pushFloatingText(state, s.x, s.y, `⚔️【${s.name}】出城迎击!`, '#38bdf8');
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'COMBAT',
      text: `⚔️【迎击出城！】敌军逼近【${s.name}】警戒圈！守将 ${picked.map((o) => o.name).join('、')} 遵照【迎击方针】率精兵 ${mobilizeTroops.toLocaleString()} 主动杀出城外拦截决战！`,
      highlight: true,
      x: s.x,
      y: s.y,
    });
  }
}

/**
 * 结束本旬 10 天推演，推进日历至下一旬并执行：
 * 1. 恢复各势力【君主政令符】
 * 2. 旬初被动经济、人口、世家与自动军需漕运网结算
 * 3. 检查并奖励【章节式君主破局使命】
 * 4. 触发下一阶段【历史危机事件抉择弹窗】
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

  // 1. 重置所有武将本旬行动标记
  for (const off of Object.values(state.officers)) {
    off.hasActedThisXun = false;
  }

  // 2. 执行旬初被动经济、四阶人口、世家门阀与自动军需漕运网结算
  runXunEconomyAndPoliticsSettlement(state);

  // 3. 检查君主破局使命达成情况并发放奖励
  checkAndRewardMissions(state);

  // 4. 恢复所有势力的本旬【君主政令符 (Command Seals)】
  for (const fac of Object.values(state.factions)) {
    const maxSeals = 5 + Math.floor((fac.prestige || 400) / 250) + (fac.missionBonusSeals || 0);
    fac.maxCommandSeals = maxSeals;
    fac.commandSeals = maxSeals;
  }

  // 5. 检查是否触发新的历史风云危机事件抉择弹窗
  checkHistoricalCrisisEvents(state);
}

/**
 * 检查并结算君主破局使命树 (Imperial Missions)
 */
export function checkAndRewardMissions(state) {
  if (!state.missions) return;
  const facId = state.meta.activeHotseatFactionId || 1;
  const fac = state.factions[facId];
  if (!fac) return;
  const dateStr = formatGameDate(state.meta.date);

  const myCities = Object.values(state.settlements).filter((s) => s.factionId === facId);

  for (const m of state.missions) {
    if (m.completed) continue;

    if (m.id === 'mission_1_tiger_cage') {
      const ownsHulaoOrBaima =
        state.settlements[14]?.factionId === facId || state.settlements[15]?.factionId === facId;
      if (ownsHulaoOrBaima || myCities.length >= 6) {
        m.completed = true;
        fac.missionBonusSeals = (fac.missionBonusSeals || 0) + 1;
        fac.prestige += 80;
        const cap = state.settlements[fac.capitalSettlementId];
        if (cap) cap.gold += 2000;
        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'POLITICS',
          text: `🏆【破局使命达成！】完成【${m.title}】！奖励：永久政令符上限 +1、君主信望 +80、金库 +2,000！`,
          highlight: true,
        });
      }
    } else if (m.id === 'mission_2_emperor_luoyang') {
      if (state.settlements[2]?.factionId === facId) {
        m.completed = true;
        fac.missionBonusSeals = (fac.missionBonusSeals || 0) + 2;
        fac.prestige += 150;
        for (const clan of Object.values(state.clans || {})) {
          clan.attitudeByFaction[facId] = Math.min(100, (clan.attitudeByFaction[facId] || 60) + 20);
        }
        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'POLITICS',
          text: `👑【奉天子以令不臣！】完成【${m.title}】！迎奉汉献帝定都，永久政令符上限 +2、信望 +150、天下名门望族尽皆归心！`,
          highlight: true,
        });
      }
    } else if (m.id === 'mission_3_guandu_hegemony') {
      if (state.settlements[16]?.factionId === facId || state.settlements[7]?.factionId === facId) {
        m.completed = true;
        fac.missionBonusSeals = (fac.missionBonusSeals || 0) + 2;
        fac.prestige += 200;
        const cap = state.settlements[fac.capitalSettlementId];
        if (cap) cap.arsenal.warhorses += 15000;
        state.battleLogs.unshift({
          id: Date.now() + Math.random(),
          dateStr,
          type: 'POLITICS',
          text: `🐉【河北霸业奠定！】完成【${m.title}】！获得精锐战马 15,000 匹，永久政令符上限 +2！`,
          highlight: true,
        });
      }
    }
  }
}

/**
 * 随旬期推进触发交互式历史危机事件弹窗
 */
function checkHistoricalCrisisEvents(state) {
  if (!state.triggeredEventIds) state.triggeredEventIds = [];
  const dateStr = formatGameDate(state.meta.date);

  if (state.meta.turnCount === 2 && !state.triggeredEventIds.includes('evt_emperor_east_return')) {
    state.triggeredEventIds.push('evt_emperor_east_return');
    state.activeEventModal = {
      id: 'evt_emperor_east_return',
      title: '👑 历史风云抉择：《洛阳残破 · 天子东归密诏》',
      dateStr,
      desc: '汉献帝自长安东归洛阳旧宫，百官饥乏、宫室尽毁，密遣使者持衣带诏向兖豫群雄求援。荀彧进言：“昔晋文公纳周襄王而诸侯景从，今奉天子以令不臣，此大顺也！”主公意下如何？',
      options: [
        {
          id: 'OPT_WELCOME_EMPEROR',
          label: '👑 【奉天子以令不臣！】立誓挥师西进夺回洛阳，并先拨精粮二万斛奉迎圣驾！',
          effectDesc: '许昌兵粮 -12,000；君主朝廷信望暴涨 +90；全军士气提升 +12；永久政令符上限 +1',
        },
        {
          id: 'OPT_PRAGMATIC_EXPANSION',
          label: '🌾 【深根固本 · 广积军备】暂缓西顾，全力扩充许昌、陈留工坊武库以备袁吕！',
          effectDesc: '许昌与陈留各获得步兵军备 +6,000、强弩 +5,000、金库 +1,500',
        },
      ],
    };
  } else if (state.meta.turnCount === 3 && !state.triggeredEventIds.includes('evt_yuan_shao_liyang')) {
    state.triggeredEventIds.push('evt_yuan_shao_liyang');
    state.activeEventModal = {
      id: 'evt_yuan_shao_liyang',
      title: '⚔️ 历史风云抉择：《河北袁绍陈兵黎阳 · 黄河战云》',
      dateStr,
      desc: '河北袁绍尽起冀州之众，令大将颜良、文丑陈兵于黄河渡口【黎阳港】，打造楼船战舰，随时准备南渡袭击【白马港】与【官渡】！',
      options: [
        {
          id: 'OPT_FORTIFY_YELLOW_RIVER',
          label: '🏰 【筑城塞锁黄河】于官渡—白马防线赶筑大型【白马城塞】，据险迎击河北军！',
          effectDesc: '自动在白马港南侧(38,20)修筑一座【白马城塞(耐久1500)】；全境守军士气 +10',
        },
        {
          id: 'OPT_SEND_ENVOY',
          label: '🕊️ 【厚币结好河北世家】遣使携重金结交河北崔氏与审配，换取短期缓兵之计并招揽流民！',
          effectDesc: '耗资 800 金；许昌、陈留新增国家编户自耕农 +9,000 人；河北崔氏好感 +20',
        },
      ],
    };
  }
}

/**
 * 执行玩家在【历史风云事件抉择弹窗】中拍板选择的选项
 */
export function resolveHistoricalEventOption(state, optionId) {
  const modal = state.activeEventModal;
  if (!modal) return;

  const facId = state.meta.activeHotseatFactionId || 1;
  const fac = state.factions[facId];
  const dateStr = formatGameDate(state.meta.date);

  if (optionId === 'OPT_OFFENSIVE') {
    const chenliu = state.settlements[5];
    if (chenliu) {
      chenliu.troops += 5000;
      chenliu.arsenal.warhorses += 4000;
    }
    for (const u of Object.values(state.units)) {
      if (u.factionId === facId) u.morale = Math.min(100, u.morale + 10);
    }
    if (fac) fac.commandSeals = (fac.commandSeals || 6) + 2;
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `⚔️【军机圣断】主公拍板【先发制人·强攻虎牢】：陈留获援精兵 5,000 与战马 4,000，全军士气大振，本旬政令符 +2！`,
      highlight: true,
    });
  } else if (optionId === 'OPT_STRATAGEM') {
    const nextFacId = Math.max(0, ...Object.keys(state.facilities || {}).map(Number)) + 1;
    state.facilities[nextFacId] = {
      id: nextFacId,
      type: 'TOWER',
      name: '陈留北连弩橹',
      factionId: facId,
      x: 36,
      y: 22,
      durability: 1000,
      maxDurability: 1000,
    };
    if (state.units[3]) {
      state.units[3].statusEffect = 'CONFUSED';
      state.units[3].statusDurationTicks = 12;
    }
    if (state.settlements[4]) state.settlements[4].gold += 1200;
    if (state.clans?.clan_yingchuan_xun) {
      state.clans.clan_yingchuan_xun.attitudeByFaction[facId] = Math.min(
        100,
        (state.clans.clan_yingchuan_xun.attitudeByFaction[facId] || 75) + 15
      );
    }
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `📜【军机圣断】主公采纳【荀彧奇谋】：于陈留北郊建成【连弩橹】，并遣细作扰乱吕布前锋使其陷入混乱！`,
      highlight: true,
    });
  } else if (optionId === 'OPT_WELCOME_EMPEROR') {
    if (state.settlements[4]) {
      state.settlements[4].food = Math.max(10000, state.settlements[4].food - 12000);
    }
    if (fac) {
      fac.prestige += 90;
      fac.missionBonusSeals = (fac.missionBonusSeals || 0) + 1;
      fac.maxCommandSeals += 1;
      fac.commandSeals += 1;
    }
    for (const u of Object.values(state.units)) {
      if (u.factionId === facId) u.morale = Math.min(100, u.morale + 12);
    }
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `👑【历史抉择·奉迎天子】我军奉献精粮奉迎汉献帝，朝廷信望暴涨 +90，永久政令符上限 +1！`,
      highlight: true,
    });
  } else if (optionId === 'OPT_PRAGMATIC_EXPANSION') {
    for (const cid of [4, 5]) {
      const c = state.settlements[cid];
      if (c && c.factionId === facId) {
        c.arsenal.infantryArms += 6000;
        c.arsenal.crossbows += 5000;
        c.gold += 1500;
      }
    }
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'ECONOMY',
      text: `⚒️【历史抉择·深根固本】许昌与陈留武库扩产，各获步兵军备 +6,000、强弩 +5,000、黄金 +1,500！`,
      highlight: true,
    });
  } else if (optionId === 'OPT_FORTIFY_YELLOW_RIVER') {
    const nextFacId = Math.max(0, ...Object.keys(state.facilities || {}).map(Number)) + 1;
    state.facilities[nextFacId] = {
      id: nextFacId,
      type: 'FORTRESS',
      name: '白马南城塞',
      factionId: facId,
      x: 38,
      y: 20,
      durability: 1500,
      maxDurability: 1500,
    };
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'COMBAT',
      text: `🏰【历史抉择·锁钥黄河】我军于白马南郊赶筑大型【白马南城塞】，驻军可自动恢复伤兵与士气并齐射渡河敌军！`,
      highlight: true,
      x: 38,
      y: 20,
    });
  } else if (optionId === 'OPT_SEND_ENVOY') {
    if (state.settlements[4]) {
      state.settlements[4].gold = Math.max(0, state.settlements[4].gold - 800);
      state.settlements[4].pops.freePeasants += 5000;
    }
    if (state.settlements[5]) {
      state.settlements[5].pops.freePeasants += 4000;
    }
    state.battleLogs.unshift({
      id: Date.now() + Math.random(),
      dateStr,
      type: 'POLITICS',
      text: `🕊️【历史抉择·结好名门】遣使厚币安抚河北名门，中原流民纷纷归附，新增编户自耕农 +9,000 人！`,
      highlight: true,
    });
  }

  state.activeEventModal = null;
}
