/**
 * SPEC-01 ~ SPEC-05 确定性模拟核心验证测试套件
 * 同时兼容浏览器内运行 (tests/runner.html) 与 Vitest CLI。
 */

import {
  checkUnitElimination,
  evaluateUnitSynergyPreview,
  getOfficerBondInfo,
} from '../src/core/combat/combatEngine.js';
import {
  computeSettlementControlAndYieldPreview,
  computeSettlementEmployment,
  runXunEconomyAndPoliticsSettlement,
} from '../src/core/economy/economyEngine.js';
import { findPathAStar } from '../src/core/map/pathfinder.js';
import { startExecutionPhase, stepExecutionTick } from '../src/core/sim/turnEngine.js';
import { SeededPRNG } from '../src/core/utils/prng.js';
import { createCentralPlainsScenario } from '../src/data/demoCentralPlains.js';

export function runAllSpecTests() {
  const results = [];
  const assert = (name, condition, detail = '') => {
    results.push({ name, passed: Boolean(condition), detail });
    if (!condition) {
      console.error(`[FAIL] ${name}: ${detail}`);
    }
  };

  // 1. SPEC-00: 确定性 PRNG 验证
  {
    const rngA = new SeededPRNG(1940301);
    const rngB = new SeededPRNG(1940301);
    const seqA = [rngA.next(), rngA.next(), rngA.rangeInt(1, 100)];
    const seqB = [rngB.next(), rngB.next(), rngB.rangeInt(1, 100)];
    assert(
      'SPEC-00: SeededPRNG 相同种子产生 100% 一致随机序列',
      JSON.stringify(seqA) === JSON.stringify(seqB),
      `seq=${JSON.stringify(seqA)}`
    );
  }

  // 2. SPEC-01: 8方向 A* 寻路跨越虎牢关与官渡黄河渡口
  {
    const state = createCentralPlainsScenario(1);
    const chenliu = state.settlements[5]; // 陈留 (35,23)
    const luoyang = state.settlements[2]; // 洛阳 (21,24)
    const path = findPathAStar(state, chenliu.x, chenliu.y, luoyang.x, luoyang.y, 'FISH_SCALE');
    const passesThroughHulao = path.some(([x, y]) => x === 28 && (y === 24 || y === 25));
    assert(
      'SPEC-01: 陈留 -> 洛阳 A* 寻路自动穿过嵩山隘口【虎牢关 (28,24)】',
      path.length > 5 && passesThroughHulao,
      `路径长度=${path.length}, 途经虎牢关=${passesThroughHulao}`
    );
  }

  // 3. SPEC-01: 义兄弟 (2.2x)、曹夏侯血亲 (1.85x) 与死敌 (0x) 兵法联动羁绊计算
  {
    const state = createCentralPlainsScenario(1);
    const liu = state.officers[501];
    const guan = state.officers[502];
    const zhang = state.officers[503];
    const lubu = state.officers[301];
    const xiahou = state.officers[102];

    const swornBond = getOfficerBondInfo(liu, guan);
    const nemesisBond = getOfficerBondInfo(lubu, xiahou);

    const peachGardenSynergy = evaluateUnitSynergyPreview(state, 'FISH_SCALE', [
      { officerId: 502, row: 'FRONT', isCommander: true },
      { officerId: 503, row: 'FRONT', isCommander: false },
      { officerId: 501, row: 'REAR', isCommander: false },
    ]);

    assert(
      'SPEC-01: 刘关张【桃园义兄弟】羁绊倍率为 2.2x，吕布与夏侯惇【血仇死敌】联动倍率为 0x',
      swornBond.multiplier === 2.2 && nemesisBond.multiplier === 0 && peachGardenSynergy.estChainProb >= 60,
      `义兄弟=${swornBond.multiplier}x, 死敌=${nemesisBond.multiplier}x, 刘关张联动率=${peachGardenSynergy.estChainProb}%`
    );
  }

  // 4. SPEC-01: 士气归零直接溃灭铁律验证
  {
    const state = createCentralPlainsScenario(1);
    const unit = state.units[1];
    unit.troops = 15000;
    unit.morale = 0; // 士气归零
    checkUnitElimination(state, unit, 4, '194年3月上旬');
    assert(
      'SPEC-01: 部队士气降至 0 时即使尚有 15,000 大军也立即触发【士气归零溃灭】',
      !state.units[1] && state.officers[102].assignedUnitId === null,
      `unit[1]已溃散=${!state.units[1]}, 主将夏侯惇已归城=${state.officers[102].assignedUnitId === null}`
    );
  }

  // 5. SPEC-02: EU5/Vic3 四阶真实人口开工率与过度征兵惩罚验证
  {
    const state = createCentralPlainsScenario(1);
    const xuchang = state.settlements[4];
    const empBefore = computeSettlementEmployment(xuchang);
    xuchang.pops.freePeasants = 6000; // 模拟过度征兵抽干自耕农
    const empAfter = computeSettlementEmployment(xuchang);
    assert(
      'SPEC-02: 过度征兵抽干自耕农后，大地图农田与市场劳动力开工率显著下降',
      empBefore.peasantRatio === 1.0 && empAfter.peasantRatio < 0.5,
      `正常开工率=${empBefore.peasantRatio * 100}%, 抽干自耕农后开工率=${Math.round(empAfter.peasantRatio * 100)}%`
    );
  }

  // 6. SPEC-02: EU5 政令控制度与 Vic3 水陆自动军需漕运网结算验证
  {
    const state = createCentralPlainsScenario(1);
    const xuchang = state.settlements[4]; // REAR_SUPPLY
    const chenliu = state.settlements[5]; // FRONTLINE_DEMAND
    const beforeFood = chenliu.food;
    const preview = computeSettlementControlAndYieldPreview(state, xuchang);
    runXunEconomyAndPoliticsSettlement(state);
    assert(
      'SPEC-02: 旬初自动结算 Lv1~Lv3 被动内政产出，且【许昌(后方基地)】自动通过漕运网向【陈留(前线军镇)】调拨粮草军备',
      preview.targetControl === 100 && chenliu.food > beforeFood,
      `许昌控制度=${preview.targetControl}%, 陈留兵粮 ${beforeFood} -> ${chenliu.food}`
    );
  }

  // 7. SPEC-01 & SPEC-03: 完整十日一旬 (40 Ticks) 自动进行阶段与 AI 推演闭环验证
  {
    const state = createCentralPlainsScenario(1);
    startExecutionPhase(state);
    let ticksRun = 0;
    while (state.meta.phase === 'EXECUTION_PHASE' && ticksRun < 45) {
      stepExecutionTick(state);
      ticksRun++;
    }
    assert(
      'SPEC-01 & SPEC-03: 完整推演 40 Ticks (10天) 后自动进入 194年3月中旬战略阶段，且触发野战/攻城战报',
      ticksRun === 40 &&
        state.meta.phase === 'STRATEGY_PHASE' &&
        state.meta.date.xun === 1 &&
        state.battleLogs.length > 4,
      `推演Ticks=${ticksRun}, 当前旬期=${state.meta.date.month}月中旬, 战报数=${state.battleLogs.length}`
    );
  }

  return results;
}
