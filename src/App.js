/**
 * SPEC-03 & SPEC-05: PC 桌面端宽屏高密度战略 UI 主应用
 * 采用 React.createElement (h) 编写，无需本地构建步骤即可直接在浏览器原生 ESM 运行，同时完全兼容 Vite。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { evaluateUnitSynergyPreview } from './core/combat/combatEngine.js';
import { computeSettlementControlAndYieldPreview } from './core/economy/economyEngine.js';
import { findPathAStar } from './core/map/pathfinder.js';
import { startExecutionPhase, stepExecutionTick } from './core/sim/turnEngine.js';
import { formatGameDate } from './core/utils/prng.js';
import { createCentralPlainsScenario, MAP_HEIGHT, MAP_WIDTH } from './data/demoCentralPlains.js';
import { ECONOMIC_BUILDING_DEFS, FORMATIONS, TACTICS } from './data/tacticsAndFormations.js';
import { FACTION_POLICIES, PASSIVE_TRAITS, PERSONALITY_TRAITS } from './data/traitsAndClans.js';
import { SandboxScene } from './render/SandboxScene.js';

const h = React.createElement;

const LENS_OPTIONS = [
  { id: 'TACTICAL', key: 'F1', name: 'F1 战术沙盘', desc: '写实山川水系、立体兵棋与野外设施' },
  { id: 'POLITICAL', key: 'F2', name: 'F2 政治疆域', desc: '各大诸侯势力范围染色与战略态势' },
  { id: 'CONTROL_CLAN', key: 'F3', name: 'F3 控制度/世家', desc: 'EU5 政令控制度热力图与东汉世家门阀割据' },
  { id: 'POPS_REFUGEE', key: 'F4', name: 'F4 人口/流民', desc: '自耕农(绿)/世家部曲(金)/流民(红)三维柱状图' },
  { id: 'LOGISTICS', key: 'F5', name: 'F5 军需漕运', desc: 'Vic3 水陆自动军需漕运网与官道干线' },
];

export function App() {
  const [gameState, setGameState] = useState(() => createCentralPlainsScenario(1));
  const [selectedSettlementId, setSelectedSettlementId] = useState(4); // 默认选中许昌
  const [selectedUnitId, setSelectedUnitId] = useState(null);
  const [lensMode, setLensMode] = useState('TACTICAL');
  const [leftTab, setLeftTab] = useState('OVERVIEW'); // OVERVIEW | POPS_CLAN | PLOTS | OFFICERS
  const [playSpeed, setPlaySpeed] = useState(1); // 0: 暂停, 1: 1x, 2: 2x, 4: 4x
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [showOfficerTableModal, setShowOfficerTableModal] = useState(false);
  const [projectedLabels, setProjectedLabels] = useState([]);

  // 出征编队弹窗状态
  const [deployFormationId, setDeployFormationId] = useState('FISH_SCALE');
  const [deploySlots, setDeploySlots] = useState([]);
  const [deployTroops, setDeployTroops] = useState(15000);
  const [deployTargetSettlementId, setDeployTargetSettlementId] = useState(14); // 默认虎牢关

  const viewportRef = useRef(null);
  const sceneRef = useRef(null);
  const stateRef = useRef(gameState);
  stateRef.current = gameState;

  const activeFactionId = gameState.meta.activeHotseatFactionId;
  const activeFaction = gameState.factions[activeFactionId];
  const selectedSettlement = selectedSettlementId ? gameState.settlements[selectedSettlementId] : null;
  const selectedUnit = selectedUnitId ? gameState.units[selectedUnitId] : null;
  const isMySettlement = selectedSettlement && selectedSettlement.factionId === activeFactionId;

  // 初始化 Three.js 2.5D 沙盘场景
  useEffect(() => {
    if (!viewportRef.current) return;
    const scene = new SandboxScene(viewportRef.current, {
      onSelectSettlement: (id) => {
        setSelectedSettlementId(id);
        setSelectedUnitId(null);
      },
      onSelectUnit: (id) => {
        setSelectedUnitId(id);
      },
      onRightClickTile: (gx, gy, meta) => {
        // 若在战略阶段且当前选中了本方野外军团，右键点击地图可变更进军目标！
        const st = structuredClone(stateRef.current);
        if (st.meta.phase !== 'STRATEGY_PHASE') return;
        const unit = scene.selectedUnitId ? st.units[scene.selectedUnitId] : null;
        if (!unit || unit.factionId !== st.meta.activeHotseatFactionId) return;

        let targetSettlementId = undefined;
        let tx = gx;
        let ty = gy;
        if (meta?.pickType === 'SETTLEMENT' && st.settlements[meta.id]) {
          targetSettlementId = meta.id;
          tx = st.settlements[meta.id].x;
          ty = st.settlements[meta.id].y;
        }
        unit.order = {
          type: 'MARCH_AND_ATTACK',
          targetX: tx,
          targetY: ty,
          targetSettlementId,
          path: findPathAStar(st, unit.x, unit.y, tx, ty, unit.formationId),
        };
        const cmd = st.officers[unit.slots[0]?.officerId];
        st.battleLogs.unshift({
          id: Date.now(),
          dateStr: formatGameDate(st.meta.date),
          type: 'COMBAT',
          text: `🧭【军令变更】${cmd?.name || '我军'}队 接获新军令，转向进军坐标 (${tx}, ${ty})${
            targetSettlementId ? `【${st.settlements[targetSettlementId].name}】` : ''
          }！`,
          x: tx,
          y: ty,
        });
        setGameState(st);
      },
      onCameraMove: () => {
        if (sceneRef.current) {
          setProjectedLabels(sceneRef.current.getProjectedLabels());
        }
      },
    });
    sceneRef.current = scene;
    scene.syncState(stateRef.current);
    setProjectedLabels(scene.getProjectedLabels());
  }, []);

  // 每次 gameState 变化同步 3D 场景与 2D 锚点标签
  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.selectedSettlementId = selectedSettlementId;
    sceneRef.current.selectedUnitId = selectedUnitId;
    sceneRef.current.syncState(gameState);
    setProjectedLabels(sceneRef.current.getProjectedLabels());
  }, [gameState, selectedSettlementId, selectedUnitId]);

  // 键盘快捷键 (F1~F5 切换战略透镜，Space 开启/暂停进行阶段)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'F1') { e.preventDefault(); changeLens('TACTICAL'); }
      if (e.key === 'F2') { e.preventDefault(); changeLens('POLITICAL'); }
      if (e.key === 'F3') { e.preventDefault(); changeLens('CONTROL_CLAN'); }
      if (e.key === 'F4') { e.preventDefault(); changeLens('POPS_REFUGEE'); }
      if (e.key === 'F5') { e.preventDefault(); changeLens('LOGISTICS'); }
      if (e.code === 'Space') {
        e.preventDefault();
        if (stateRef.current.meta.phase === 'STRATEGY_PHASE') {
          handleStartXun();
        } else {
          setPlaySpeed((s) => (s === 0 ? 1 : 0));
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 进行阶段 (EXECUTION_PHASE) 40-Tick 自动推演定时器
  useEffect(() => {
    if (gameState.meta.phase !== 'EXECUTION_PHASE' || playSpeed === 0) return;
    const intervalMs = Math.round(320 / playSpeed);
    const timer = setInterval(() => {
      setGameState((prev) => {
        if (prev.meta.phase !== 'EXECUTION_PHASE') return prev;
        const next = structuredClone(prev);
        stepExecutionTick(next);
        return next;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [gameState.meta.phase, playSpeed]);

  const changeLens = (mode) => {
    setLensMode(mode);
    sceneRef.current?.setLensMode(mode);
    if (sceneRef.current) {
      setProjectedLabels(sceneRef.current.getProjectedLabels());
    }
  };

  // 计算当前玩家势力汇总资源
  const factionTotals = useMemo(() => {
    const myCities = Object.values(gameState.settlements).filter((s) => s.factionId === activeFactionId);
    const myUnits = Object.values(gameState.units).filter((u) => u.factionId === activeFactionId);
    let gold = 0;
    let food = 0;
    let troops = 0;
    let freePeasants = 0;
    for (const c of myCities) {
      gold += c.gold;
      food += c.food;
      troops += c.troops;
      freePeasants += c.pops.freePeasants;
    }
    for (const u of myUnits) {
      troops += u.troops;
    }
    return { cities: myCities.length, gold, food, troops, freePeasants };
  }, [gameState, activeFactionId]);

  // 选中城池的实时产出与控制度预览
  const settlementPreview = useMemo(() => {
    if (!selectedSettlement) return null;
    return computeSettlementControlAndYieldPreview(gameState, selectedSettlement);
  }, [gameState, selectedSettlement]);

  // 启动十日进行阶段
  const handleStartXun = () => {
    const next = structuredClone(gameState);
    startExecutionPhase(next);
    setPlaySpeed((s) => (s === 0 ? 1 : s));
    setGameState(next);
  };

  // 瞬间完成本旬剩余全部 Ticks
  const handleSkipRemainingXun = () => {
    const next = structuredClone(gameState);
    if (next.meta.phase === 'STRATEGY_PHASE') {
      startExecutionPhase(next);
    }
    let guard = 0;
    while (next.meta.phase === 'EXECUTION_PHASE' && guard++ < 50) {
      stepExecutionTick(next);
    }
    setGameState(next);
  };

  // 切换当前操控的君主 (支持 5 大诸侯随时同屏体验)
  const handleSwitchFaction = (facId) => {
    const next = structuredClone(gameState);
    next.meta.activeHotseatFactionId = facId;
    next.meta.playerFactionIds = [facId];
    const capId = next.factions[facId]?.capitalSettlementId;
    setGameState(next);
    if (capId && next.settlements[capId]) {
      setSelectedSettlementId(capId);
      sceneRef.current?.focusOnTile(next.settlements[capId].x, next.settlements[capId].y);
    }
  };

  // 切换君主治国国策 (TUNTIAN / MERITOCRACY / NINE_RANK_CLAN / BALANCED)
  const handleChangePolicy = (policyId) => {
    const next = structuredClone(gameState);
    const fac = next.factions[activeFactionId];
    if (!fac) return;
    fac.activePolicy = policyId;
    const polDef = FACTION_POLICIES[policyId];
    next.battleLogs.unshift({
      id: Date.now(),
      dateStr: formatGameDate(next.meta.date),
      type: 'POLITICS',
      text: `📜【国策变法】${fac.name} 颁布新国策【${polDef.name}】：${polDef.desc}`,
      highlight: true,
    });
    setGameState(next);
  };

  // 城池内政操作：征召新兵 (直接从自耕农抽调，影响劳动力开工率!)
  const handleConscriptTroops = () => {
    if (!isMySettlement || gameState.meta.phase !== 'STRATEGY_PHASE') return;
    const next = structuredClone(gameState);
    const s = next.settlements[selectedSettlement.id];
    const preview = computeSettlementControlAndYieldPreview(next, s);
    const draftCount = Math.round(3500 * preview.conscriptBonus);
    const goldCost = 700;

    if (s.gold < goldCost || s.pops.freePeasants < draftCount + 3000) return;
    s.gold -= goldCost;
    s.pops.freePeasants -= draftCount;
    s.troops += draftCount;
    s.publicOrder = Math.max(40, s.publicOrder - 3);

    next.battleLogs.unshift({
      id: Date.now(),
      dateStr: formatGameDate(next.meta.date),
      type: 'ECONOMY',
      text: `🛡️【征召新兵】${s.name} 耗资 ${goldCost} 金，从自耕农中征召新兵 ${draftCount.toLocaleString()} 人（注意农牧劳动力余量）。`,
      x: s.x,
      y: s.y,
    });
    setGameState(next);
  };

  // 城池内政操作：招抚流民 / 军屯安民
  const handleSettleRefugees = () => {
    if (!isMySettlement || gameState.meta.phase !== 'STRATEGY_PHASE') return;
    const next = structuredClone(gameState);
    const s = next.settlements[selectedSettlement.id];
    if (s.gold < 400 || s.pops.refugees < 200) return;

    const settled = Math.min(s.pops.refugees, Math.max(800, Math.round(s.pops.refugees * 0.45)));
    s.gold -= 400;
    s.pops.refugees -= settled;
    s.pops.freePeasants += settled;
    s.publicOrder = Math.min(100, s.publicOrder + 5);

    next.battleLogs.unshift({
      id: Date.now(),
      dateStr: formatGameDate(next.meta.date),
      type: 'ECONOMY',
      text: `🌾【招抚流民】${s.name} 开仓放粮，成功将 ${settled.toLocaleString()} 名流民落籍转化为国家自耕农！`,
      x: s.x,
      y: s.y,
    });
    setGameState(next);
  };

  // 东汉世家门阀博弈：清丈隐户 vs 征调世家部曲私兵
  const handleClanAction = (actionType) => {
    if (!isMySettlement || gameState.meta.phase !== 'STRATEGY_PHASE') return;
    const next = structuredClone(gameState);
    const s = next.settlements[selectedSettlement.id];
    const clan = s.dominantClanId ? next.clans[s.dominantClanId] : null;
    if (!clan) return;

    if (actionType === 'AUDIT_RETAINERS') {
      // 清丈隐户：将 3,000 部曲转回自耕农，控制度 +8%，但世家态度 -15
      const count = Math.min(s.pops.clanRetainers, 3500);
      if (count <= 0) return;
      s.pops.clanRetainers -= count;
      s.pops.freePeasants += count;
      s.controlRate = Math.min(100, s.controlRate + 8);
      clan.attitudeByFaction[activeFactionId] = Math.max(
        10,
        (clan.attitudeByFaction[activeFactionId] ?? 60) - 15
      );
      next.battleLogs.unshift({
        id: Date.now(),
        dateStr: formatGameDate(next.meta.date),
        type: 'POLITICS',
        text: `⚖️【清丈隐户】${s.name} 强行清查【${clan.name}】庄园隐匿人口，将 ${count.toLocaleString()} 名部曲收归国家编户，控制度提升！`,
        highlight: true,
        x: s.x,
        y: s.y,
      });
    } else if (actionType === 'LEVY_CLAN_TROOPS') {
      // 征调世家私兵：态度 >= 55 时可立即无偿获得 4,000 精兵 + 3,000 战马/步兵军备
      const att = clan.attitudeByFaction[activeFactionId] ?? 50;
      if (att < 55 || s.pops.clanRetainers < 3000) return;
      s.pops.clanRetainers -= 3000;
      s.troops += 4000;
      s.arsenal.infantryArms += 3000;
      s.arsenal.warhorses += 2000;
      clan.attitudeByFaction[activeFactionId] = att - 18;
      clan.influence = Math.min(100, clan.influence + 6);
      next.battleLogs.unshift({
        id: Date.now(),
        dateStr: formatGameDate(next.meta.date),
        type: 'POLITICS',
        text: `🐎【世家资助】名门【${clan.name}】响应君主号召，于 ${s.name} 捐献私家部曲精兵 4,000 人及良马甲胄！`,
        highlight: true,
        x: s.x,
        y: s.y,
      });
    }
    setGameState(next);
  };

  // 扩建城外大地图内政建筑 (Lv1 -> Lv2 -> Lv3)
  const handleUpgradeEconomicPlot = (plotId) => {
    if (!isMySettlement || gameState.meta.phase !== 'STRATEGY_PHASE') return;
    const next = structuredClone(gameState);
    const s = next.settlements[selectedSettlement.id];
    const plot = s.economicPlots.find((p) => p.id === plotId);
    if (!plot || plot.level >= 3) return;

    const def = ECONOMIC_BUILDING_DEFS[plot.type];
    const cost = def.upgradeCost[plot.level];
    if (s.gold < cost) return;

    s.gold -= cost;
    plot.level += 1;
    plot.maxDurability = plot.level * 300;
    plot.durability = plot.maxDurability;

    next.battleLogs.unshift({
      id: Date.now(),
      dateStr: formatGameDate(next.meta.date),
      type: 'ECONOMY',
      text: `🏗️【领地扩建】${s.name} 城外【${def.name}】成功扩建至 Lv${plot.level}，被动产量大幅提升！`,
      x: plot.x,
      y: plot.y,
    });
    setGameState(next);
  };

  // 切换城市在 Vic3 自动军需漕运网中的物流角色
  const handleCycleLogisticsRole = () => {
    if (!isMySettlement) return;
    const roles = ['REAR_SUPPLY', 'BALANCED', 'FRONTLINE_DEMAND'];
    const next = structuredClone(gameState);
    const s = next.settlements[selectedSettlement.id];
    const idx = roles.indexOf(s.logisticsRole || 'BALANCED');
    s.logisticsRole = roles[(idx + 1) % roles.length];
    setGameState(next);
  };

  // 打开五将三列阵型出征面板
  const openDeployModalForSettlement = () => {
    if (!selectedSettlement) return;
    const idleOfficers = Object.values(gameState.officers)
      .filter(
        (o) =>
          o.factionId === activeFactionId &&
          o.locationSettlementId === selectedSettlement.id &&
          !o.assignedUnitId
      )
      .sort((a, b) => b.leadership + b.might * 0.4 - (a.leadership + a.might * 0.4));

    const defaultPicked = idleOfficers.slice(0, Math.min(4, idleOfficers.length));
    const form = FORMATIONS.FISH_SCALE;
    const initialSlots = defaultPicked.map((o, idx) => ({
      officerId: o.id,
      row: idx < form.rowSlots.FRONT ? 'FRONT' : 'REAR',
      isCommander: idx === 0,
    }));

    setDeployFormationId('FISH_SCALE');
    setDeploySlots(initialSlots);
    setDeployTroops(Math.min(15000, Math.max(3000, Math.floor(selectedSettlement.troops * 0.5 / 1000) * 1000)));

    // 默认锁定相邻的第一个敌方据点
    const enemyTarget =
      (selectedSettlement.connectedSettlementIds || [])
        .map((id) => gameState.settlements[id])
        .find((s) => s && s.factionId !== activeFactionId) ||
      Object.values(gameState.settlements).find((s) => s.factionId !== activeFactionId);

    if (enemyTarget) setDeployTargetSettlementId(enemyTarget.id);
    setShowDeployModal(true);
  };

  // 确认擂鼓出征
  const handleConfirmDeployUnit = () => {
    if (!selectedSettlement || deploySlots.length === 0) return;
    const next = structuredClone(gameState);
    const origin = next.settlements[selectedSettlement.id];
    const target = next.settlements[deployTargetSettlementId];
    if (!origin || !target || origin.troops < deployTroops) return;

    const form = FORMATIONS[deployFormationId] || FORMATIONS.FISH_SCALE;
    if (form.arsenalRequired) {
      const aType = form.arsenalRequired.type;
      const needed = form.arsenalRequired.flatCount || deployTroops;
      if ((origin.arsenal[aType] || 0) < needed) {
        alert(`武库【${form.arsenalRequired.label}】库存不足！需要 ${needed.toLocaleString()}，当前仅有 ${(origin.arsenal[aType] || 0).toLocaleString()}。（或改选【长蛇】无军备阵型）`);
        return;
      }
      origin.arsenal[aType] -= needed;
    }

    const syn = evaluateUnitSynergyPreview(next, deployFormationId, deploySlots);
    const orderedSlots = deploySlots.map((s) => ({
      ...s,
      isCommander: s.officerId === syn.commander?.id,
    }));

    const newUnitId = Math.max(0, ...Object.keys(next.units).map(Number)) + 1;
    const path = findPathAStar(next, origin.x, origin.y, target.x, target.y, deployFormationId);
    const foodTaken = Math.min(origin.food - 5000, Math.round(deployTroops * 1.6));

    origin.troops -= deployTroops;
    origin.food -= foodTaken;

    next.units[newUnitId] = {
      id: newUnitId,
      factionId: activeFactionId,
      originSettlementId: origin.id,
      formationId: deployFormationId,
      slots: orderedSlots,
      troops: deployTroops,
      wounded: 0,
      morale: origin.morale,
      goldCarried: 600,
      foodCarried: foodTaken,
      x: origin.x,
      y: origin.y,
      order: {
        type: 'MARCH_AND_ATTACK',
        targetX: target.x,
        targetY: target.y,
        targetSettlementId: target.id,
        path,
      },
      statusEffect: 'NORMAL',
      statusDurationTicks: 0,
      lastTacticBanner: null,
    };

    for (const s of orderedSlots) {
      if (next.officers[s.officerId]) {
        next.officers[s.officerId].assignedUnitId = newUnitId;
      }
    }

    const names = orderedSlots.map((s) => next.officers[s.officerId]?.name).join('、');
    next.battleLogs.unshift({
      id: Date.now(),
      dateStr: formatGameDate(next.meta.date),
      type: 'COMBAT',
      text: `🥁【全军出击】${names} 率军 ${deployTroops.toLocaleString()} 布【${form.name}之阵】自 ${origin.name} 出征，直扑【${target.name}】！`,
      highlight: true,
      x: origin.x,
      y: origin.y,
    });

    setShowDeployModal(false);
    setSelectedUnitId(newUnitId);
    setGameState(next);
  };

  return h(
    'div',
    { className: 'relative w-screen h-screen overflow-hidden bg-slate-950 select-none' },

    // ==================== 1. 底层 Three.js 2.5D 沙盘全屏画布 ====================
    h('div', { ref: viewportRef, className: 'absolute inset-0 w-full h-full z-0 cursor-grab active:cursor-grabbing' }),

    // ==================== 2. 3D 沙盘之上的 2D 投影兵牌与城池战略标签层 ====================
    h(
      'div',
      { className: 'absolute inset-0 pointer-events-none z-10 overflow-hidden' },
      projectedLabels.map((lbl) => {
        if (lbl.kind === 'SETTLEMENT') {
          const s = lbl.data;
          const fac = lbl.faction;
          const roleBadge =
            s.logisticsRole === 'REAR_SUPPLY'
              ? '📦后方'
              : s.logisticsRole === 'FRONTLINE_DEMAND'
              ? '⚔️前线'
              : '';
          return h(
            'div',
            {
              key: `s-${s.id}`,
              style: {
                transform: `translate3d(${lbl.screenX}px, ${lbl.screenY}px, 0) translate(-50%, -100%)`,
              },
              onClick: () => {
                setSelectedSettlementId(s.id);
                setSelectedUnitId(null);
              },
              className: `pointer-events-auto cursor-pointer transition-transform ${
                lbl.isSelected ? 'scale-110 z-30' : 'hover:scale-105 opacity-95'
              }`,
            },
            h(
              'div',
              {
                className: `flex items-center gap-1.5 px-2 py-0.5 rounded border shadow-lg backdrop-blur-md text-xs ${
                  lbl.isSelected
                    ? 'bg-slate-900/95 border-amber-400 ring-2 ring-amber-400/40'
                    : 'bg-slate-900/85 border-slate-600/80'
                }`,
              },
              h(
                'span',
                {
                  style: { backgroundColor: fac?.color || '#475569' },
                  className: 'w-4 h-4 rounded-sm flex items-center justify-center font-bold text-[11px] text-white shadow',
                },
                fac?.bannerChar || '无'
              ),
              h('span', { className: 'font-bold text-amber-100 tracking-wide' }, s.name),
              h('span', { className: 'text-emerald-300 font-mono text-[11px]' }, `${(s.troops / 1000).toFixed(1)}k`),
              lensMode === 'CONTROL_CLAN' &&
                h('span', { className: 'text-amber-300 font-mono text-[10px]' }, `控${s.controlRate}%`),
              lensMode === 'LOGISTICS' &&
                roleBadge &&
                h('span', { className: 'text-[10px] px-1 rounded bg-slate-800 text-amber-200' }, roleBadge)
            )
          );
        }

        if (lbl.kind === 'UNIT') {
          const u = lbl.data;
          const fac = lbl.faction;
          return h(
            'div',
            {
              key: `u-${u.id}`,
              style: {
                transform: `translate3d(${lbl.screenX}px, ${lbl.screenY}px, 0) translate(-50%, -100%)`,
              },
              onClick: () => setSelectedUnitId(u.id),
              className: `pointer-events-auto cursor-pointer ${lbl.isSelected ? 'z-40 scale-110' : 'z-20 hover:scale-105'}`,
            },
            // 若该部队刚刚发动兵法联动，头顶弹出金色战法飘字
            u.lastTacticBanner &&
              h(
                'div',
                {
                  className:
                    'mb-1 px-2 py-0.5 rounded bg-gradient-to-r from-red-700 via-amber-600 to-red-700 border border-yellow-300 text-[11px] font-extrabold text-yellow-100 shadow-lg whitespace-nowrap animate-bounce',
                },
                `⚡ ${u.lastTacticBanner.text} (-${u.lastTacticBanner.damage})`
              ),
            h(
              'div',
              {
                style: { borderColor: lbl.isSelected ? '#38bdf8' : fac?.color || '#3b82f6' },
                className: 'px-2 py-0.5 rounded bg-slate-950/90 border-2 shadow-xl flex flex-col items-center min-w-[96px]',
              },
              h(
                'div',
                { className: 'flex items-center gap-1 text-[11px] font-bold text-white' },
                h('span', null, lbl.formDef.symbol),
                h('span', null, `${lbl.commanderName}队`),
                h('span', { className: 'text-[10px] text-amber-300' }, `[${lbl.formDef.name}]`)
              ),
              h(
                'div',
                { className: 'flex items-center gap-2 text-[10px] font-mono' },
                h('span', { className: 'text-sky-300' }, `${u.troops.toLocaleString()}兵`),
                h('span', { className: u.morale < 35 ? 'text-red-400 font-bold' : 'text-emerald-300' }, `士${u.morale}`)
              ),
              u.statusEffect === 'BLOOD_FEUD_RAGE' &&
                h('span', { className: 'text-[9px] px-1 rounded bg-red-900/90 text-red-200 font-bold' }, '💢死敌血战'),
              u.statusEffect === 'CONFUSED' &&
                h('span', { className: 'text-[9px] px-1 rounded bg-purple-900/90 text-purple-200 font-bold' }, '💫混乱中')
            )
          );
        }

        if (lbl.kind === 'PLOT') {
          const p = lbl.data;
          const def = lbl.def;
          return h(
            'div',
            {
              key: `p-${p.id}`,
              style: {
                transform: `translate3d(${lbl.screenX}px, ${lbl.screenY}px, 0) translate(-50%, -100%)`,
              },
              className: 'px-1.5 py-0.2 rounded bg-slate-900/75 border border-slate-700/80 text-[10px] text-slate-200 whitespace-nowrap',
            },
            `${def?.icon || ''} ${def?.name || p.type} Lv${p.level}`
          );
        }

        if (lbl.kind === 'FACILITY') {
          const f = lbl.data;
          return h(
            'div',
            {
              key: `f-${f.id}`,
              style: {
                transform: `translate3d(${lbl.screenX}px, ${lbl.screenY}px, 0) translate(-50%, -100%)`,
              },
              className: 'px-1.5 py-0.5 rounded bg-amber-950/85 border border-amber-500/70 text-[10px] text-amber-200 font-semibold whitespace-nowrap',
            },
            `🏹 ${f.name} (${f.durability})`
          );
        }

        return null;
      })
    ),

    // ==================== 3. 顶部帝国全局态势与五大地图透镜栏 ====================
    h(
      'header',
      {
        className:
          'absolute top-0 left-0 right-0 h-13 bg-slate-950/90 border-b border-amber-500/30 backdrop-blur-md z-30 flex items-center justify-between px-4',
      },
      // 左侧：君主切换与当前年号旬期
      h(
        'div',
        { className: 'flex items-center gap-3' },
        h(
          'div',
          { className: 'flex items-center gap-1.5 bg-slate-900 border border-amber-500/40 rounded px-2 py-1' },
          h(
            'span',
            {
              style: { backgroundColor: activeFaction?.color },
              className: 'w-5 h-5 rounded flex items-center justify-center font-bold text-xs text-white',
            },
            activeFaction?.bannerChar
          ),
          h(
            'select',
            {
              value: activeFactionId,
              onChange: (e) => handleSwitchFaction(Number(e.target.value)),
              className: 'bg-transparent text-amber-200 font-bold text-sm focus:outline-none cursor-pointer',
              title: '同屏热座模式：可随时切换扮演五大诸侯势力',
            },
            Object.values(gameState.factions).map((f) =>
              h('option', { key: f.id, value: f.id, className: 'bg-slate-900 text-amber-100' }, `${f.name} (${f.courtRank})`)
            )
          )
        ),
        h(
          'div',
          { className: 'px-3 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-bold' },
          formatGameDate(gameState.meta.date, gameState.meta.phase === 'EXECUTION_PHASE'),
          h(
            'span',
            {
              className: `ml-2 px-1.5 py-0.5 rounded text-[11px] ${
                gameState.meta.phase === 'STRATEGY_PHASE'
                  ? 'bg-emerald-600/80 text-white'
                  : 'bg-red-600/90 text-white animate-pulse'
              }`,
            },
            gameState.meta.phase === 'STRATEGY_PHASE' ? '战略下令阶段' : `进行推演中 (${gameState.meta.date.tickInXun}/40)`
          )
        )
      ),

      // 中部：全局核心资源与国策快速切换
      h(
        'div',
        { className: 'flex items-center gap-4 text-xs' },
        h(
          'div',
          { className: 'flex items-center gap-3 bg-slate-900/80 px-3 py-1.5 rounded border border-slate-800' },
          h('span', { title: '势力总资金' }, '🪙 资金: ', h('b', { className: 'text-amber-300 font-mono' }, factionTotals.gold.toLocaleString())),
          h('span', { title: '势力总兵粮' }, '🌾 兵粮: ', h('b', { className: 'text-lime-300 font-mono' }, factionTotals.food.toLocaleString())),
          h('span', { title: '现役总兵力' }, '⚔️ 总兵力: ', h('b', { className: 'text-sky-300 font-mono' }, factionTotals.troops.toLocaleString())),
          h('span', { title: '国家编户自耕农总数（决定赋税与可征召兵源）' }, '👥 编户齐民: ', h('b', { className: 'text-emerald-300 font-mono' }, factionTotals.freePeasants.toLocaleString())),
          h('span', { title: '君主朝廷信望' }, '👑 信望: ', h('b', { className: 'text-purple-300 font-mono' }, activeFaction?.prestige))
        ),
        h(
          'div',
          { className: 'flex items-center gap-1.5 bg-slate-900/90 border border-slate-700 rounded px-2.5 py-1' },
          h('span', { className: 'text-slate-400 text-[11px]' }, '国策:'),
          h(
            'select',
            {
              value: activeFaction?.activePolicy || 'BALANCED',
              onChange: (e) => handleChangePolicy(e.target.value),
              className: 'bg-transparent text-amber-300 font-semibold text-xs focus:outline-none cursor-pointer',
            },
            Object.values(FACTION_POLICIES).map((pol) =>
              h('option', { key: pol.id, value: pol.id, className: 'bg-slate-900 text-slate-100' }, pol.name)
            )
          )
        )
      ),

      // 右侧：F1~F5 五大战略透镜与全体武将总表入口
      h(
        'div',
        { className: 'flex items-center gap-1.5' },
        LENS_OPTIONS.map((l) =>
          h(
            'button',
            {
              key: l.id,
              onClick: () => changeLens(l.id),
              title: l.desc,
              className: `px-2 py-1 rounded text-[11px] font-semibold transition border ${
                lensMode === l.id
                  ? 'bg-amber-500 text-slate-950 border-amber-300 shadow'
                  : 'bg-slate-900/80 text-slate-300 border-slate-700 hover:border-amber-400/60'
              }`,
            },
            l.name
          )
        ),
        h(
          'button',
          {
            onClick: () => setShowOfficerTableModal(true),
            className: 'ml-2 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-amber-500/40 text-amber-200 text-xs font-semibold',
          },
          '📋 天下名将录'
        )
      )
    ),

    // ==================== 4. 左侧：据点内政、四阶人口、世家门阀與武库面板 ====================
    selectedSettlement &&
      h(
        'aside',
        {
          className:
            'absolute top-16 left-3 bottom-16 w-84 bg-slate-950/92 border border-amber-500/30 rounded-lg backdrop-blur-md z-20 flex flex-col shadow-2xl overflow-hidden',
        },
        // 据点标题头
        h(
          'div',
          { className: 'p-3 bg-gradient-to-r from-slate-900 via-slate-900 to-slate-800 border-b border-slate-800 flex items-center justify-between' },
          h(
            'div',
            null,
            h(
              'div',
              { className: 'flex items-center gap-2' },
              h('span', { className: 'text-lg font-extrabold text-amber-200' }, selectedSettlement.name),
              h(
                'span',
                { className: 'text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700' },
                `${selectedSettlement.province} · ${
                  selectedSettlement.type === 'MAJOR_CITY' ? '大都市' : selectedSettlement.type === 'PASS' ? '险要关隘' : '战略军港'
                }`
              )
            ),
            h(
              'div',
              { className: 'text-xs text-slate-400 mt-0.5' },
              `所属: ${gameState.factions[selectedSettlement.factionId]?.name || '无主'} | 太守: ${
                gameState.officers[selectedSettlement.prefectOfficerId]?.name || '未任命'
              }`
            )
          ),
          // Vic3 军需漕运网角色一键切换
          h(
            'button',
            {
              onClick: handleCycleLogisticsRole,
              disabled: !isMySettlement,
              title: '点击切换本城在【Vic3 水陆自动军需漕运网】中的调拨角色',
              className: `px-2 py-1 rounded text-[11px] font-bold border ${
                selectedSettlement.logisticsRole === 'REAR_SUPPLY'
                  ? 'bg-emerald-950/90 border-emerald-500 text-emerald-300'
                  : selectedSettlement.logisticsRole === 'FRONTLINE_DEMAND'
                  ? 'bg-orange-950/90 border-orange-500 text-orange-300'
                  : 'bg-slate-800 border-slate-600 text-slate-300'
              }`,
            },
            selectedSettlement.logisticsRole === 'REAR_SUPPLY'
              ? '📦 后方供应基地'
              : selectedSettlement.logisticsRole === 'FRONTLINE_DEMAND'
              ? '⚔️ 前线重点军镇'
              : '⚖️ 中转平衡据点'
          )
        ),

        // 4 个子标签页切换栏
        h(
          'div',
          { className: 'grid grid-cols-4 bg-slate-900/90 border-b border-slate-800 text-xs font-semibold' },
          [
            ['OVERVIEW', '🏰 城防武库'],
            ['POPS_CLAN', '👥 人口世家'],
            ['PLOTS', '🌾 领地用地'],
            ['OFFICERS', '⚔️ 驻城武将'],
          ].map(([tabId, label]) =>
            h(
              'button',
              {
                key: tabId,
                onClick: () => setLeftTab(tabId),
                className: `py-2 text-center border-b-2 transition ${
                  leftTab === tabId
                    ? 'border-amber-400 text-amber-300 bg-slate-800/60'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`,
              },
              label
            )
          )
        ),

        // 标签页内容主体
        h(
          'div',
          { className: 'flex-1 overflow-y-auto p-3 space-y-3 text-xs' },

          // ---- TAB 1: 城防、资金兵粮与武库库存 ----
          leftTab === 'OVERVIEW' &&
            h(
              React.Fragment,
              null,
              // 核心城防与钱粮指标卡
              h(
                'div',
                { className: 'grid grid-cols-2 gap-2 bg-slate-900/70 p-2.5 rounded border border-slate-800' },
                h('div', null, h('span', { className: 'text-slate-400' }, '现役守军: '), h('b', { className: 'text-sky-300 font-mono' }, selectedSettlement.troops.toLocaleString())),
                h('div', null, h('span', { className: 'text-slate-400' }, '待愈伤兵: '), h('b', { className: 'text-amber-300 font-mono' }, selectedSettlement.woundedTroops.toLocaleString())),
                h('div', null, h('span', { className: 'text-slate-400' }, '守军士气: '), h('b', { className: 'text-emerald-300 font-mono' }, `${selectedSettlement.morale}/100`)),
                h('div', null, h('span', { className: 'text-slate-400' }, '城防耐久: '), h('b', { className: 'text-slate-200 font-mono' }, `${selectedSettlement.wallDurability}/${selectedSettlement.maxWallDurability}`)),
                h('div', null, h('span', { className: 'text-slate-400' }, '金库资金: '), h('b', { className: 'text-amber-300 font-mono' }, `${selectedSettlement.gold.toLocaleString()} (+${settlementPreview?.netGold || 0}/旬)`)),
                h('div', null, h('span', { className: 'text-slate-400' }, '仓廪兵粮: '), h('b', { className: 'text-lime-300 font-mono' }, `${selectedSettlement.food.toLocaleString()} (+${settlementPreview?.netFood || 0}/旬)`))
              ),

              // EU5 政令控制度简报
              h(
                'div',
                { className: 'p-2.5 rounded bg-slate-900/80 border border-slate-800' },
                h(
                  'div',
                  { className: 'flex justify-between items-center mb-1' },
                  h('span', { className: 'font-semibold text-amber-200' }, '🏛️ EU5 政令控制度 (Control)'),
                  h('span', { className: 'font-mono font-bold text-emerald-300' }, `${selectedSettlement.controlRate}%`)
                ),
                h(
                  'div',
                  { className: 'w-full h-2 bg-slate-800 rounded overflow-hidden' },
                  h('div', {
                    style: { width: `${selectedSettlement.controlRate}%` },
                    className: 'h-full bg-gradient-to-r from-amber-500 to-emerald-400',
                  })
                ),
                h(
                  'p',
                  { className: 'text-[11px] text-slate-400 mt-1' },
                  `国家实收赋税比例 ${selectedSettlement.controlRate}%，其余被地方世家豪强截留 (+${settlementPreview?.clanSiphonedGold || 0}金/旬)。`
                )
              ),

              // 城市武库库存 (绑定出征阵型!)
              h(
                'div',
                { className: 'p-2.5 rounded bg-slate-900/80 border border-slate-800 space-y-1.5' },
                h('div', { className: 'font-semibold text-amber-200' }, '⚒️ 城池武库军备库存 (每旬自动生产)'),
                h(
                  'div',
                  { className: 'grid grid-cols-2 gap-1.5 text-[11px]' },
                  h(
                    'div',
                    { className: 'p-1.5 rounded bg-slate-950/70 border border-slate-800 flex justify-between' },
                    h('span', null, '🛡️ 步兵军备:'),
                    h('b', { className: 'text-sky-300 font-mono' }, selectedSettlement.arsenal.infantryArms.toLocaleString())
                  ),
                  h(
                    'div',
                    { className: 'p-1.5 rounded bg-slate-950/70 border border-slate-800 flex justify-between' },
                    h('span', null, '🏹 强弩弓箭:'),
                    h('b', { className: 'text-amber-300 font-mono' }, selectedSettlement.arsenal.crossbows.toLocaleString())
                  ),
                  h(
                    'div',
                    { className: 'p-1.5 rounded bg-slate-950/70 border border-slate-800 flex justify-between' },
                    h('span', null, '🐎 西凉/冀州战马:'),
                    h('b', { className: 'text-purple-300 font-mono' }, selectedSettlement.arsenal.warhorses.toLocaleString())
                  ),
                  h(
                    'div',
                    { className: 'p-1.5 rounded bg-slate-950/70 border border-slate-800 flex justify-between' },
                    h('span', null, '🗼 井阑 / ☄️ 投石:'),
                    h('b', { className: 'text-emerald-300 font-mono' }, `${selectedSettlement.arsenal.siegeTowers} / ${selectedSettlement.arsenal.catapults}`)
                  )
                )
              ),

              // 战略阶段核心城池指令按钮
              isMySettlement &&
                h(
                  'div',
                  { className: 'grid grid-cols-2 gap-2 pt-1' },
                  h(
                    'button',
                    {
                      onClick: openDeployModalForSettlement,
                      disabled: gameState.meta.phase !== 'STRATEGY_PHASE',
                      className:
                        'col-span-2 py-2.5 rounded bg-gradient-to-r from-amber-600 to-red-600 hover:from-amber-500 hover:to-red-500 text-white font-extrabold text-sm shadow-lg disabled:opacity-40 cursor-pointer',
                    },
                    '🥁 编组五将部队 · 擂鼓出征'
                  ),
                  h(
                    'button',
                    {
                      onClick: handleConscriptTroops,
                      disabled: gameState.meta.phase !== 'STRATEGY_PHASE',
                      className: 'py-2 rounded bg-slate-800 hover:bg-slate-700 border border-sky-500/40 text-sky-200 font-semibold cursor-pointer',
                    },
                    '🛡️ 征召自耕农参军 (-700金)'
                  ),
                  h(
                    'button',
                    {
                      onClick: handleSettleRefugees,
                      disabled: gameState.meta.phase !== 'STRATEGY_PHASE',
                      className: 'py-2 rounded bg-slate-800 hover:bg-slate-700 border border-emerald-500/40 text-emerald-200 font-semibold cursor-pointer',
                    },
                    '🌾 开仓招抚流民 (-400金)'
                  )
                )
            ),

          // ---- TAB 2: EU5/Vic3 四阶真实人口与东汉世家门阀博弈 ----
          leftTab === 'POPS_CLAN' &&
            h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'p-2.5 rounded bg-slate-900/80 border border-slate-800 space-y-2' },
                h('div', { className: 'font-bold text-amber-200' }, '👥 EU5 / Vic3 真实人口阶层与劳动力开工率'),
                h(
                  'div',
                  { className: 'space-y-1 text-[11px]' },
                  h(
                    'div',
                    { className: 'flex justify-between' },
                    h('span', { className: 'text-emerald-300 font-semibold' }, '• 国家自耕农 (赋税+兵源):'),
                    h('span', { className: 'font-mono' }, `${selectedSettlement.pops.freePeasants.toLocaleString()} 人`)
                  ),
                  h(
                    'div',
                    { className: 'flex justify-between' },
                    h('span', { className: 'text-amber-300 font-semibold' }, '• 世家部曲/佃农 (豪强隐户):'),
                    h('span', { className: 'font-mono' }, `${selectedSettlement.pops.clanRetainers.toLocaleString()} 人`)
                  ),
                  h(
                    'div',
                    { className: 'flex justify-between' },
                    h('span', { className: 'text-sky-300 font-semibold' }, '• 百工匠户 (锻冶/工房):'),
                    h('span', { className: 'font-mono' }, `${selectedSettlement.pops.artisans.toLocaleString()} 人`)
                  ),
                  h(
                    'div',
                    { className: 'flex justify-between' },
                    h('span', { className: 'text-red-300 font-semibold' }, '• 失地流民 (跨城迁徙):'),
                    h('span', { className: 'font-mono' }, `${selectedSettlement.pops.refugees.toLocaleString()} 人`)
                  )
                ),
                settlementPreview &&
                  h(
                    'div',
                    { className: 'pt-2 border-t border-slate-800 text-[11px] space-y-1' },
                    h(
                      'div',
                      { className: 'flex justify-between' },
                      h('span', null, '🌾 农牧商业劳动力开工率:'),
                      h(
                        'b',
                        { className: settlementPreview.employment.peasantRatio < 0.9 ? 'text-red-400' : 'text-emerald-400' },
                        `${Math.round(settlementPreview.employment.peasantRatio * 100)}%`
                      )
                    ),
                    h(
                      'div',
                      { className: 'flex justify-between' },
                      h('span', null, '⚒️ 军工匠作劳动力开工率:'),
                      h('b', { className: 'text-sky-300' }, `${Math.round(settlementPreview.employment.artisanRatio * 100)}%`)
                    )
                  )
              ),

              // 世家门阀互动卡
              selectedSettlement.dominantClanId &&
                (() => {
                  const clan = gameState.clans[selectedSettlement.dominantClanId];
                  if (!clan) return null;
                  const att = clan.attitudeByFaction[activeFactionId] ?? 50;
                  return h(
                    'div',
                    { className: 'p-2.5 rounded bg-slate-900/80 border border-amber-500/30 space-y-2' },
                    h(
                      'div',
                      { className: 'flex justify-between items-center' },
                      h('span', { className: 'font-bold text-amber-300' }, `🏛️ ${clan.name}`),
                      h('span', { className: 'text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-amber-200' }, `权势 ${clan.influence} | 好感 ${att}`)
                    ),
                    h('p', { className: 'text-[11px] text-slate-400 leading-relaxed' }, clan.description),
                    isMySettlement &&
                      h(
                        'div',
                        { className: 'grid grid-cols-2 gap-2 pt-1' },
                        h(
                          'button',
                          {
                            onClick: () => handleClanAction('AUDIT_RETAINERS'),
                            className: 'py-1.5 px-2 rounded bg-slate-800 hover:bg-slate-700 border border-amber-500/40 text-amber-200 text-[11px] font-semibold cursor-pointer',
                          },
                          '⚖️ 清丈隐户 (+自耕农)'
                        ),
                        h(
                          'button',
                          {
                            onClick: () => handleClanAction('LEVY_CLAN_TROOPS'),
                            disabled: att < 55,
                            className: 'py-1.5 px-2 rounded bg-slate-800 hover:bg-slate-700 border border-purple-500/40 text-purple-200 text-[11px] font-semibold disabled:opacity-40 cursor-pointer',
                          },
                          '🐎 征调世家部曲私兵'
                        )
                      )
                  );
                })()
            ),

          // ---- TAB 3: 城外大地图 Lv1~Lv3 被动内政用地 ----
          leftTab === 'PLOTS' &&
            h(
              'div',
              { className: 'space-y-2' },
              h(
                'p',
                { className: 'text-[11px] text-slate-400' },
                '大地图领地建筑每旬 100% 自动产出钱粮与军备，无需重复手点；点击扩建可升至 Lv3。'
              ),
              (selectedSettlement.economicPlots || []).length === 0 &&
                h('div', { className: 'text-slate-500 py-4 text-center' }, '军事关隘/渡口无城外农业用地，依靠自动军需漕运网补给。'),
              (selectedSettlement.economicPlots || []).map((plot) => {
                const def = ECONOMIC_BUILDING_DEFS[plot.type];
                const nextCost = plot.level < 3 ? def.upgradeCost[plot.level] : null;
                return h(
                  'div',
                  {
                    key: plot.id,
                    className: 'p-2.5 rounded bg-slate-900/85 border border-slate-800 flex items-center justify-between',
                  },
                  h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'font-bold text-amber-200 flex items-center gap-1.5' },
                      h('span', null, def?.icon),
                      h('span', null, `${def?.name} Lv${plot.level}`),
                      h('span', { className: 'text-[10px] text-slate-400 font-mono' }, `(${plot.x},${plot.y})`)
                    ),
                    h('div', { className: 'text-[11px] text-slate-400 mt-0.5' }, def?.desc)
                  ),
                  isMySettlement &&
                    plot.level < 3 &&
                    h(
                      'button',
                      {
                        onClick: () => handleUpgradeEconomicPlot(plot.id),
                        disabled: selectedSettlement.gold < nextCost,
                        className:
                          'px-2.5 py-1 rounded bg-amber-600/90 hover:bg-amber-500 text-white font-bold text-[11px] disabled:opacity-40 shrink-0 cursor-pointer',
                      },
                      `⬆ 升Lv${plot.level + 1} (${nextCost}金)`
                    )
                );
              })
            ),

          // ---- TAB 4: 驻城武将、特技、CK3性格与兵法详情 ----
          leftTab === 'OFFICERS' &&
            h(
              'div',
              { className: 'space-y-2' },
              Object.values(gameState.officers)
                .filter((o) => o.locationSettlementId === selectedSettlement.id && o.factionId === selectedSettlement.factionId)
                .map((off) =>
                  h(
                    'div',
                    {
                      key: off.id,
                      className: 'p-2 rounded bg-slate-900/85 border border-slate-800 space-y-1',
                    },
                    h(
                      'div',
                      { className: 'flex items-center justify-between' },
                      h(
                        'div',
                        { className: 'flex items-center gap-1.5' },
                        h('span', { className: 'font-bold text-amber-200 text-xs' }, `${off.name} (${off.courtesyName})`),
                        off.assignedUnitId &&
                          h('span', { className: 'text-[10px] px-1 rounded bg-sky-900 text-sky-200' }, '出征中')
                      ),
                      h('span', { className: 'text-[10px] text-slate-400' }, off.courtOfficeId || '将校')
                    ),
                    h(
                      'div',
                      { className: 'grid grid-cols-4 gap-1 text-[11px] font-mono bg-slate-950/60 px-2 py-1 rounded' },
                      h('span', null, '统:', h('b', { className: 'text-sky-300' }, off.leadership)),
                      h('span', null, '武:', h('b', { className: 'text-red-300' }, off.might)),
                      h('span', null, '智:', h('b', { className: 'text-emerald-300' }, off.intelligence)),
                      h('span', null, '政:', h('b', { className: 'text-amber-300' }, off.politics))
                    ),
                    // 被动特技 + CK3 性格 + 已学兵法标签
                    h(
                      'div',
                      { className: 'flex flex-wrap gap-1 pt-0.5' },
                      (off.passiveTraits || []).map((tId) => {
                        const tr = PASSIVE_TRAITS[tId];
                        return (
                          tr &&
                          h(
                            'span',
                            {
                              key: tId,
                              title: tr.desc,
                              className: 'px-1.5 py-0.2 rounded bg-amber-500/20 border border-amber-400/50 text-amber-200 text-[10px] font-bold',
                            },
                            `★${tr.name}`
                          )
                        );
                      }),
                      (off.personalities || []).map((pId) => {
                        const per = PERSONALITY_TRAITS[pId];
                        return (
                          per &&
                          h(
                            'span',
                            {
                              key: pId,
                              title: per.desc,
                              className: 'px-1.5 py-0.2 rounded bg-purple-950 border border-purple-500/40 text-purple-200 text-[10px]',
                            },
                            per.name
                          )
                        );
                      }),
                      (off.learnedTactics || []).map((tacId) => {
                        const tac = TACTICS[tacId];
                        return (
                          tac &&
                          h(
                            'span',
                            {
                              key: tacId,
                              className: 'px-1 py-0.2 rounded bg-slate-800 text-slate-300 text-[10px]',
                            },
                            tac.name
                          )
                        );
                      })
                    )
                  )
                )
            )
        )
      ),

    // ==================== 5. 右侧：战略缩略图、选中军团详情与可点击实时战报流 ====================
    h(
      'aside',
      {
        className:
          'absolute top-16 right-3 bottom-16 w-80 flex flex-col gap-2.5 z-20 pointer-events-none',
      },

      // 5.1 2D 交互式全战区战略缩略图 + 视角旋转罗盘
      h(
        'div',
        {
          className:
            'pointer-events-auto bg-slate-950/92 border border-amber-500/30 rounded-lg p-2.5 backdrop-blur-md shadow-xl',
        },
        h(
          'div',
          { className: 'flex items-center justify-between text-xs font-bold text-amber-200 mb-1.5' },
          h('span', null, '🗺️ 中原战区态势缩略图'),
          h(
            'div',
            { className: 'flex items-center gap-1' },
            h(
              'button',
              {
                onClick: () => sceneRef.current?.zoomBy(1.18),
                title: '放大地图 (滚轮向上)',
                className: 'px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px] cursor-pointer',
              },
              '＋ 放大'
            ),
            h(
              'button',
              {
                onClick: () => sceneRef.current?.resetNorth(),
                title: '重置居中战区视角 (快捷键 N)',
                className: 'px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px] cursor-pointer',
              },
              '🎯 居中'
            ),
            h(
              'button',
              {
                onClick: () => sceneRef.current?.zoomBy(0.84),
                title: '缩小地图 (滚轮向下)',
                className: 'px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px] cursor-pointer',
              },
              '－ 缩小'
            )
          )
        ),
        // 缩略图画板
        h(
          'div',
          {
            className: 'relative w-full h-36 bg-slate-900 rounded border border-slate-700 overflow-hidden cursor-pointer',
            onClick: (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const gx = Math.round(((e.clientX - rect.left) / rect.width) * MAP_WIDTH);
              const gy = Math.round(((e.clientY - rect.top) / rect.height) * MAP_HEIGHT);
              sceneRef.current?.focusOnTile(gx, gy);
            },
          },
          // 黄河示意带
          h('div', {
            style: { top: '42%', height: '6%' },
            className: 'absolute left-0 right-0 bg-sky-700/50 pointer-events-none',
          }),
          // 各据点圆点
          Object.values(gameState.settlements).map((s) => {
            const fac = gameState.factions[s.factionId];
            return h('div', {
              key: s.id,
              title: `${s.name} (${fac?.name || '无'})`,
              style: {
                left: `${(s.x / MAP_WIDTH) * 100}%`,
                top: `${(s.y / MAP_HEIGHT) * 100}%`,
                backgroundColor: fac?.color || '#94a3b8',
              },
              onClick: (e) => {
                e.stopPropagation();
                setSelectedSettlementId(s.id);
                sceneRef.current?.focusOnTile(s.x, s.y);
              },
              className: `absolute -translate-x-1/2 -translate-y-1/2 rounded-full border ${
                s.type === 'MAJOR_CITY' ? 'w-3 h-3 border-white' : 'w-2 h-2 border-slate-300'
              } ${selectedSettlementId === s.id ? 'ring-2 ring-yellow-300 scale-125' : ''}`,
            });
          }),
          // 野外行军部队闪烁点
          Object.values(gameState.units).map((u) => {
            const fac = gameState.factions[u.factionId];
            return h('div', {
              key: `mini-u-${u.id}`,
              style: {
                left: `${(u.x / MAP_WIDTH) * 100}%`,
                top: `${(u.y / MAP_HEIGHT) * 100}%`,
                backgroundColor: fac?.color || '#fff',
              },
              className: 'absolute w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-yellow-200 animate-pulse',
            });
          })
        ),
        h(
          'div',
          { className: 'text-[10px] text-slate-400 mt-1 flex justify-between' },
          h('span', null, '左键平移 · 滚轮缩放 · 右键/QE旋转伪3D视角'),
          h('span', { className: 'text-amber-300' }, '右键地图可变更军团目标')
        )
      ),

      // 5.2 当前选中的野外五将部队详情卡
      selectedUnit &&
        (() => {
          const fac = gameState.factions[selectedUnit.factionId];
          const form = FORMATIONS[selectedUnit.formationId] || FORMATIONS.FISH_SCALE;
          const syn = evaluateUnitSynergyPreview(gameState, selectedUnit.formationId, selectedUnit.slots);
          return h(
            'div',
            {
              className:
                'pointer-events-auto bg-slate-950/92 border border-sky-500/40 rounded-lg p-3 backdrop-blur-md shadow-xl text-xs space-y-2',
            },
            h(
              'div',
              { className: 'flex items-center justify-between border-b border-slate-800 pb-1.5' },
              h(
                'div',
                { className: 'font-bold text-sky-300 flex items-center gap-1.5' },
                h('span', null, form.symbol),
                h('span', null, `${syn.commander?.name || '野战'}军团 · 【${form.name}阵】`)
              ),
              h('span', { className: 'text-[11px] text-amber-300 font-mono' }, `预计旬发动率 ${syn.estTriggerProbPerXun}%`)
            ),
            h(
              'div',
              { className: 'grid grid-cols-3 gap-1.5 text-[11px] font-mono bg-slate-900/80 p-2 rounded' },
              h('span', null, '兵力: ', h('b', { className: 'text-sky-300' }, selectedUnit.troops.toLocaleString())),
              h('span', null, '伤兵: ', h('b', { className: 'text-amber-300' }, selectedUnit.wounded.toLocaleString())),
              h('span', null, '士气: ', h('b', { className: 'text-emerald-300' }, selectedUnit.morale)),
              h('span', null, '统率: ', h('b', { className: 'text-white' }, syn.effectiveLDR)),
              h('span', null, '联动率: ', h('b', { className: 'text-yellow-300' }, `${syn.estChainProb}%`)),
              h('span', null, '军粮: ', h('b', { className: 'text-lime-300' }, selectedUnit.foodCarried.toLocaleString()))
            ),
            // 前中后三列武将排布显示
            h(
              'div',
              { className: 'space-y-1' },
              selectedUnit.slots.map((s) => {
                const off = gameState.officers[s.officerId];
                const best = syn.officerTriggerRates[s.officerId];
                return (
                  off &&
                  h(
                    'div',
                    {
                      key: s.officerId,
                      className: 'flex items-center justify-between px-2 py-1 rounded bg-slate-900/70 border border-slate-800 text-[11px]',
                    },
                    h(
                      'div',
                      { className: 'flex items-center gap-1.5' },
                      h(
                        'span',
                        {
                          className: `px-1 rounded text-[10px] font-bold ${
                            s.row === 'FRONT'
                              ? 'bg-red-900/80 text-red-200'
                              : s.row === 'MIDDLE'
                              ? 'bg-amber-900/80 text-amber-200'
                              : 'bg-sky-900/80 text-sky-200'
                          }`,
                        },
                        s.row === 'FRONT' ? '前列' : s.row === 'MIDDLE' ? '中列' : '后列'
                      ),
                      h('span', { className: 'font-bold text-slate-100' }, off.name),
                      s.isCommander && h('span', { className: 'text-[10px] text-amber-400 font-bold' }, '[主将]')
                    ),
                    best &&
                      h(
                        'span',
                        { className: 'text-[10px] text-amber-300 font-mono' },
                        `【${best.tactic.name}】${best.percent}%/日`
                      )
                  )
                );
              })
            )
          );
        })(),

      // 5.3 实时可点击回溯战报与天下事件流
      h(
        'div',
        {
          className:
            'pointer-events-auto flex-1 bg-slate-950/92 border border-amber-500/30 rounded-lg p-2.5 backdrop-blur-md shadow-xl flex flex-col overflow-hidden',
        },
        h(
          'div',
          { className: 'text-xs font-bold text-amber-200 border-b border-slate-800 pb-1.5 mb-1.5 flex justify-between' },
          h('span', null, '📜 实时军情与兵法联动战报 (点击定位)'),
          h('span', { className: 'text-[10px] text-slate-400' }, `共 ${gameState.battleLogs.length} 条`)
        ),
        h(
          'div',
          { className: 'flex-1 overflow-y-auto space-y-1.5 pr-1 text-[11px]' },
          gameState.battleLogs.map((log) =>
            h(
              'div',
              {
                key: log.id,
                onClick: () => {
                  if (log.x != null && log.y != null) {
                    sceneRef.current?.focusOnTile(log.x, log.y);
                  }
                },
                className: `p-2 rounded border transition cursor-pointer ${
                  log.highlight
                    ? 'bg-amber-950/40 border-amber-500/50 text-amber-100'
                    : 'bg-slate-900/75 border-slate-800 text-slate-300 hover:border-slate-600'
                }`,
              },
              h('div', { className: 'text-[10px] text-slate-400 font-mono mb-0.5' }, log.dateStr),
              h('div', { className: 'leading-snug' }, log.text)
            )
          )
        )
      )
    ),

    // ==================== 6. 中央兵法联动特写横幅 (Tactic Chain Cut-in) ====================
    gameState.activeCutin &&
      h(
        'div',
        {
          className:
            'absolute top-20 left-1/2 -translate-x-1/2 z-40 pointer-events-none cutin-banner',
        },
        h(
          'div',
          {
            style: { borderColor: gameState.activeCutin.factionColor },
            className:
              'px-8 py-4 rounded-xl bg-gradient-to-r from-slate-950 via-red-950/95 to-slate-950 border-2 shadow-2xl text-center min-w-[440px]',
          },
          h(
            'div',
            { className: 'text-xs font-bold tracking-widest text-amber-300 uppercase mb-1' },
            gameState.activeCutin.chainCount >= 2
              ? `🔥 三国志9 兵法连锁 · 【${gameState.activeCutin.chainCount}人联动发动！】 🔥`
              : '⚡ 武将兵法发动 ⚡'
          ),
          h(
            'div',
            { className: 'text-2xl font-black text-white tracking-wider drop-shadow' },
            `${gameState.activeCutin.officerNames.join(' × ')} — 【${gameState.activeCutin.tacticName}】！`
          ),
          h(
            'div',
            { className: 'text-xs text-amber-200 italic mt-1' },
            gameState.activeCutin.barkText
          ),
          h(
            'div',
            { className: 'text-sm font-mono font-extrabold text-red-400 mt-1.5' },
            `对 ${gameState.activeCutin.targetName} 造成 ${gameState.activeCutin.damage.toLocaleString()} 人毁灭性杀伤！`
          )
        )
      ),

    // ==================== 7. 底部十日一“旬”战略/进行阶段控制坞 ====================
    h(
      'footer',
      {
        className:
          'absolute bottom-0 left-0 right-0 h-14 bg-slate-950/95 border-t border-amber-500/30 backdrop-blur-md z-30 flex items-center justify-between px-5',
      },
      // 左侧快捷功能坞
      h(
        'div',
        { className: 'flex items-center gap-2 text-xs' },
        h(
          'button',
          {
            onClick: () => {
              if (selectedSettlement && isMySettlement) {
                openDeployModalForSettlement();
              }
            },
            disabled: !isMySettlement || gameState.meta.phase !== 'STRATEGY_PHASE',
            className:
              'px-3.5 py-1.5 rounded bg-amber-600/90 hover:bg-amber-500 text-white font-bold disabled:opacity-40 cursor-pointer',
          },
          '⚔️ 军事出征'
        ),
        h(
          'button',
          {
            onClick: () => setLeftTab('PLOTS'),
            className: 'px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 cursor-pointer',
          },
          '🌾 领地建设'
        ),
        h(
          'button',
          {
            onClick: () => setLeftTab('POPS_CLAN'),
            className: 'px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 cursor-pointer',
          },
          '🏛️ 世家与流民'
        ),
        h(
          'button',
          {
            onClick: () => setShowOfficerTableModal(true),
            className: 'px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 cursor-pointer',
          },
          '👥 武将名录'
        )
      ),

      // 中部：十日推演进度条 (Day 1 ~ Day 10)
      h(
        'div',
        { className: 'flex-1 max-w-md mx-6' },
        h(
          'div',
          { className: 'flex justify-between text-[11px] text-slate-400 mb-1' },
          h('span', null, `十日一旬推演进度 (第 ${gameState.meta.date.dayInXun} / 10 日)`),
          h('span', { className: 'font-mono text-amber-300' }, `Tick ${gameState.meta.date.tickInXun} / 40`)
        ),
        h(
          'div',
          { className: 'w-full h-2.5 bg-slate-800 rounded-full overflow-hidden border border-slate-700' },
          h('div', {
            style: { width: `${(gameState.meta.date.tickInXun / 40) * 100}%` },
            className: 'h-full bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 transition-all duration-150',
          })
        )
      ),

      // 右侧：进行阶段主按钮与倍速控制
      h(
        'div',
        { className: 'flex items-center gap-2' },
        [
          [0, '⏸ 暂停'],
          [1, '1x'],
          [2, '2x'],
          [4, '4x'],
        ].map(([spd, label]) =>
          h(
            'button',
            {
              key: spd,
              onClick: () => setPlaySpeed(spd),
              className: `px-2.5 py-1.5 rounded text-xs font-bold border cursor-pointer ${
                playSpeed === spd
                  ? 'bg-amber-500 text-slate-950 border-amber-300'
                  : 'bg-slate-900 text-slate-300 border-slate-700 hover:border-slate-500'
              }`,
            },
            label
          )
        ),
        h(
          'button',
          {
            onClick: handleSkipRemainingXun,
            title: '立即演算完本旬全部 10 天并进入下一旬',
            className: 'px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-amber-200 text-xs font-semibold cursor-pointer',
          },
          '⏭ 快进本旬'
        ),
        gameState.meta.phase === 'STRATEGY_PHASE' &&
          h(
            'button',
            {
              onClick: handleStartXun,
              className:
                'px-5 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-black text-sm shadow-lg ring-1 ring-emerald-300/50 cursor-pointer',
            },
            '▶ 进行 (开启10日推演)'
          )
      )
    ),

    // ==================== 8. 弹窗 A：五将三列阵型编成与兵法联动实时预览面板 ====================
    showDeployModal &&
      selectedSettlement &&
      (() => {
        const availableOfficers = Object.values(gameState.officers).filter(
          (o) =>
            o.factionId === activeFactionId &&
            o.locationSettlementId === selectedSettlement.id &&
            !o.assignedUnitId
        );
        const form = FORMATIONS[deployFormationId] || FORMATIONS.FISH_SCALE;
        const syn = evaluateUnitSynergyPreview(gameState, deployFormationId, deploySlots);

        const toggleOfficerSelection = (officerId) => {
          const exists = deploySlots.find((s) => s.officerId === officerId);
          if (exists) {
            setDeploySlots(deploySlots.filter((s) => s.officerId !== officerId));
          } else {
            if (deploySlots.length >= 5) return;
            const defaultRow = form.rowSlots.FRONT > 0 ? 'FRONT' : 'MIDDLE';
            setDeploySlots([
              ...deploySlots,
              { officerId, row: defaultRow, isCommander: deploySlots.length === 0 },
            ]);
          }
        };

        const cycleSlotRow = (officerId) => {
          const order = ['FRONT', 'MIDDLE', 'REAR'];
          setDeploySlots(
            deploySlots.map((s) => {
              if (s.officerId !== officerId) return s;
              const nextRow = order[(order.indexOf(s.row) + 1) % 3];
              return { ...s, row: nextRow };
            })
          );
        };

        return h(
          'div',
          {
            className:
              'fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-6',
          },
          h(
            'div',
            {
              className:
                'w-full max-w-4xl bg-slate-950 border-2 border-amber-500/50 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]',
            },
            // Header
            h(
              'div',
              { className: 'px-5 py-3.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between' },
              h(
                'div',
                null,
                h('h2', { className: 'text-base font-extrabold text-amber-200' }, `🥁 【${selectedSettlement.name}】出征军团编成 · 前中后三列阵型与兵法联动台`),
                h('p', { className: 'text-xs text-slate-400' }, '最多选派 5 名武将；同宗族血亲、义兄弟或相性接近的武将同队将大幅提升 2~5 人【兵法联动】概率！')
              ),
              h(
                'button',
                {
                  onClick: () => setShowDeployModal(false),
                  className: 'px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer',
                },
                '✕ 关闭'
              )
            ),

            // Body
            h(
              'div',
              { className: 'p-5 overflow-y-auto grid grid-cols-12 gap-5 text-xs' },

              // 左列 (5 cols): 候选武将池 + 兵力与进攻目标选择
              h(
                'div',
                { className: 'col-span-5 space-y-3' },
                h('div', { className: 'font-bold text-amber-300' }, `1. 选派随军武将 (${deploySlots.length}/5 人)`),
                h(
                  'div',
                  { className: 'space-y-1.5 max-h-56 overflow-y-auto pr-1' },
                  availableOfficers.map((off) => {
                    const picked = deploySlots.some((s) => s.officerId === off.id);
                    return h(
                      'div',
                      {
                        key: off.id,
                        onClick: () => toggleOfficerSelection(off.id),
                        className: `p-2 rounded border cursor-pointer flex items-center justify-between transition ${
                          picked
                            ? 'bg-amber-950/50 border-amber-400 text-amber-100'
                            : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:border-slate-600'
                        }`,
                      },
                      h(
                        'div',
                        null,
                        h('div', { className: 'font-bold' }, `${picked ? '☑ ' : '☐ '}${off.name} (统${off.leadership} 武${off.might} 智${off.intelligence})`),
                        h(
                          'div',
                          { className: 'text-[10px] text-slate-400 mt-0.5' },
                          `相性:${off.compatibility} | 兵法: ${(off.learnedTactics || [])
                            .map((id) => TACTICS[id]?.name)
                            .join('/')}`
                        )
                      ),
                      picked && h('span', { className: 'text-[10px] px-1.5 py-0.5 rounded bg-amber-500 text-slate-950 font-bold' }, '已入列')
                    );
                  })
                ),

                // 调拨兵力与目标据点
                h(
                  'div',
                  { className: 'p-3 rounded bg-slate-900/90 border border-slate-800 space-y-2.5' },
                  h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'flex justify-between mb-1' },
                      h('span', { className: 'text-slate-300 font-semibold' }, '出征兵力规模:'),
                      h('b', { className: 'text-sky-300 font-mono' }, `${deployTroops.toLocaleString()} / ${selectedSettlement.troops.toLocaleString()} 人`)
                    ),
                    h('input', {
                      type: 'range',
                      min: 2000,
                      max: Math.max(3000, selectedSettlement.troops - 2000),
                      step: 1000,
                      value: deployTroops,
                      onChange: (e) => setDeployTroops(Number(e.target.value)),
                      className: 'w-full accent-amber-500 cursor-pointer',
                    })
                  ),
                  h(
                    'div',
                    null,
                    h('div', { className: 'text-slate-300 font-semibold mb-1' }, '进攻或进驻目标据点:'),
                    h(
                      'select',
                      {
                        value: deployTargetSettlementId,
                        onChange: (e) => setDeployTargetSettlementId(Number(e.target.value)),
                        className: 'w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-amber-200 font-bold',
                      },
                      Object.values(gameState.settlements)
                        .filter((s) => s.id !== selectedSettlement.id)
                        .map((s) =>
                          h(
                            'option',
                            { key: s.id, value: s.id },
                            `${s.name} (${gameState.factions[s.factionId]?.name || '中立'} · 守军 ${s.troops.toLocaleString()})`
                          )
                        )
                    )
                  )
                )
              ),

              // 右列 (7 cols): 阵型选择、前中后三列站位图与实时兵法联动推演
              h(
                'div',
                { className: 'col-span-7 space-y-3' },
                h('div', { className: 'font-bold text-amber-300' }, '2. 选择阵型（绑定消耗城池武库军备）'),
                h(
                  'div',
                  { className: 'grid grid-cols-3 gap-2' },
                  Object.values(FORMATIONS).map((f) =>
                    h(
                      'div',
                      {
                        key: f.id,
                        onClick: () => setDeployFormationId(f.id),
                        className: `p-2 rounded border cursor-pointer transition ${
                          deployFormationId === f.id
                            ? 'bg-amber-500/20 border-amber-400 text-amber-100'
                            : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:border-slate-600'
                        }`,
                      },
                      h(
                        'div',
                        { className: 'font-bold flex items-center justify-between' },
                        h('span', null, `${f.symbol} ${f.name}阵`),
                        h('span', { className: 'text-[10px] font-mono text-amber-300' }, `攻${f.atk}/防${f.def}/速${f.speed}`)
                      ),
                      h(
                        'div',
                        { className: 'text-[10px] text-slate-400 mt-0.5' },
                        f.arsenalRequired ? `需武库: ${f.arsenalRequired.label}` : '无需军备 (民兵/急行军)'
                      )
                    )
                  )
                ),

                // 三列站位与联动率实时预览卡
                h(
                  'div',
                  { className: 'p-3 rounded bg-slate-900/90 border border-amber-500/30 space-y-2.5' },
                  h(
                    'div',
                    { className: 'flex items-center justify-between border-b border-slate-800 pb-2' },
                    h(
                      'div',
                      null,
                      h('span', { className: 'text-slate-400' }, '自动判定主将: '),
                      h('b', { className: 'text-amber-300 text-sm' }, syn.commander?.name || '未选派'),
                      h('span', { className: 'ml-3 text-slate-400' }, '部队有效统率: '),
                      h('b', { className: 'text-sky-300 font-mono text-sm' }, syn.effectiveLDR)
                    ),
                    h(
                      'div',
                      { className: 'flex items-center gap-3' },
                      h(
                        'span',
                        { className: 'px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400 text-amber-200 font-bold' },
                        `⚡ 预计每旬兵法率: ${syn.estTriggerProbPerXun}%`
                      ),
                      h(
                        'span',
                        { className: 'px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400 text-emerald-200 font-bold' },
                        `🔗 联动响应率: ${syn.estChainProb}%`
                      )
                    )
                  ),

                  // 点击切换前/中/后列站位
                  h(
                    'div',
                    { className: 'space-y-1.5' },
                    h('div', { className: 'text-[11px] text-slate-400' }, '点击武将右侧列位按钮可调整【前列(近战+18%) / 中列 / 后列(远程与谋略+22%)】：'),
                    deploySlots.map((slot) => {
                      const off = gameState.officers[slot.officerId];
                      const best = syn.officerTriggerRates[slot.officerId];
                      return (
                        off &&
                        h(
                          'div',
                          {
                            key: slot.officerId,
                            className: 'flex items-center justify-between p-2 rounded bg-slate-950/80 border border-slate-800',
                          },
                          h(
                            'div',
                            { className: 'flex items-center gap-2' },
                            h('span', { className: 'font-bold text-amber-100' }, off.name),
                            off.id === syn.commander?.id &&
                              h('span', { className: 'px-1.5 py-0.2 rounded bg-amber-500 text-slate-950 text-[10px] font-extrabold' }, '主将'),
                            best &&
                              h(
                                'span',
                                { className: 'text-[11px] text-emerald-300' },
                                `主修兵法:【${best.tactic.name}】(单日触发 ${best.percent}%)`
                              )
                          ),
                          h(
                            'button',
                            {
                              onClick: () => cycleSlotRow(slot.officerId),
                              className: `px-2.5 py-1 rounded text-[11px] font-bold cursor-pointer ${
                                slot.row === 'FRONT'
                                  ? 'bg-red-700 text-white'
                                  : slot.row === 'MIDDLE'
                                  ? 'bg-amber-700 text-white'
                                  : 'bg-sky-700 text-white'
                              }`,
                            },
                            slot.row === 'FRONT' ? '⚔️ 前列 (点击切换)' : slot.row === 'MIDDLE' ? '🛡️ 中列 (点击切换)' : '🏹 后列 (点击切换)'
                          )
                        )
                      );
                    })
                  ),

                  // 羁绊连线高亮提示
                  syn.links.length > 0 &&
                    h(
                      'div',
                      { className: 'pt-2 border-t border-slate-800' },
                      h('div', { className: 'text-[11px] font-bold text-amber-300 mb-1' }, '✨ 已激活的武将联动羁绊加成：'),
                      h(
                        'div',
                        { className: 'flex flex-wrap gap-1.5' },
                        syn.links.map((lk, i) =>
                          h(
                            'span',
                            {
                              key: i,
                              style: { borderColor: lk.color, color: lk.color },
                              className: 'px-2 py-0.5 rounded bg-slate-950 border text-[11px] font-bold',
                            },
                            `${lk.fromName} ⟷ ${lk.toName}：${lk.label} (联动×${lk.multiplier})`
                          )
                        )
                      )
                    )
                )
              )
            ),

            // Footer
            h(
              'div',
              { className: 'px-5 py-3 bg-slate-900 border-t border-slate-800 flex items-center justify-end gap-3' },
              h(
                'button',
                {
                  onClick: () => setShowDeployModal(false),
                  className: 'px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold cursor-pointer',
                },
                '取消'
              ),
              h(
                'button',
                {
                  onClick: handleConfirmDeployUnit,
                  disabled: deploySlots.length === 0,
                  className:
                    'px-6 py-2 rounded bg-gradient-to-r from-amber-500 to-red-600 hover:from-amber-400 hover:to-red-500 text-white font-black text-xs shadow-lg disabled:opacity-40 cursor-pointer',
                },
                '🚩 确认编成 · 立即出征'
              )
            )
          )
        );
      })(),

    // ==================== 9. 弹窗 B：天下名将多维排序大表 ====================
    showOfficerTableModal &&
      h(
        'div',
        {
          className:
            'fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-6',
        },
        h(
          'div',
          {
            className:
              'w-full max-w-5xl bg-slate-950 border-2 border-amber-500/50 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]',
          },
          h(
            'div',
            { className: 'px-5 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between' },
            h('h2', { className: 'text-base font-extrabold text-amber-200' }, '📋 《中原逐鹿》天下名将与世家门阀总览表'),
            h(
              'button',
              {
                onClick: () => setShowOfficerTableModal(false),
                className: 'px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer',
              },
              '✕ 关闭'
            )
          ),
          h(
            'div',
            { className: 'p-4 overflow-y-auto' },
            h(
              'table',
              { className: 'w-full text-left border-collapse text-xs' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  { className: 'border-b border-slate-700 text-amber-300 bg-slate-900/90' },
                  h('th', { className: 'p-2' }, '武将'),
                  h('th', { className: 'p-2' }, '所属势力'),
                  h('th', { className: 'p-2' }, '所在据点'),
                  h('th', { className: 'p-2' }, '统率'),
                  h('th', { className: 'p-2' }, '武力'),
                  h('th', { className: 'p-2' }, '智力'),
                  h('th', { className: 'p-2' }, '政治'),
                  h('th', { className: 'p-2' }, '相性'),
                  h('th', { className: 'p-2' }, '特技与性格'),
                  h('th', { className: 'p-2' }, '已习得兵法')
                )
              ),
              h(
                'tbody',
                null,
                Object.values(gameState.officers)
                  .sort((a, b) => b.leadership + b.might - (a.leadership + a.might))
                  .map((o) => {
                    const fac = gameState.factions[o.factionId];
                    const city = gameState.settlements[o.locationSettlementId];
                    return h(
                      'tr',
                      { key: o.id, className: 'border-b border-slate-800/80 hover:bg-slate-900/60' },
                      h('td', { className: 'p-2 font-bold text-amber-100' }, `${o.name} (${o.courtesyName})`),
                      h('td', { className: 'p-2', style: { color: fac?.color } }, fac?.name || '在野'),
                      h('td', { className: 'p-2 text-slate-300' }, city?.name || '-'),
                      h('td', { className: 'p-2 font-mono text-sky-300 font-bold' }, o.leadership),
                      h('td', { className: 'p-2 font-mono text-red-300 font-bold' }, o.might),
                      h('td', { className: 'p-2 font-mono text-emerald-300 font-bold' }, o.intelligence),
                      h('td', { className: 'p-2 font-mono text-amber-300 font-bold' }, o.politics),
                      h('td', { className: 'p-2 font-mono text-slate-400' }, o.compatibility),
                      h(
                        'td',
                        { className: 'p-2 space-x-1' },
                        (o.passiveTraits || []).map((t) =>
                          h('span', { key: t, className: 'px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 text-[10px]' }, PASSIVE_TRAITS[t]?.name)
                        ),
                        (o.personalities || []).map((p) =>
                          h('span', { key: p, className: 'px-1.5 py-0.5 rounded bg-purple-900/60 text-purple-200 text-[10px]' }, PERSONALITY_TRAITS[p]?.name)
                        )
                      ),
                      h(
                        'td',
                        { className: 'p-2 text-[11px] text-slate-300' },
                        (o.learnedTactics || []).map((id) => TACTICS[id]?.name).join(' · ')
                      )
                    );
                  })
              )
            )
          )
        )
      )
  );
}
