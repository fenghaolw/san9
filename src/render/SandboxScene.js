/**
 * SPEC-03 (v1.2): 尖顶六边形蜂窝网格 (Pointy-Top Hex Grid) 极简 2D 战略沙盘渲染器
 * 特性：
 * - 完美等距 6 方向六边形几何 (Odd-R 偏移坐标，相邻六边形中心距离恒等)
 * - 极简降噪默认视图：默认隐藏细碎网格线、非选中城池的内政小图标与城际连线，画面干净大气
 * - 支持全自由图层过滤开关 (setLayerFilters)：军团兵牌、城池铭牌、城外内政用地(仅选中/全部/隐藏)、
 *   势力疆域、连通干线、六边形蜂窝网格、山川地名水印均可一键显隐。
 */

import { getHexDistance } from '../core/map/pathfinder.js';
import { ECONOMIC_BUILDING_DEFS, FORMATIONS, TERRAIN_ENUM } from '../data/tacticsAndFormations.js';

const SQRT3 = Math.sqrt(3);
const ROW_V_FACTOR = 1.5 / SQRT3; // ~0.8660254 (使相邻六边形中心在世界坐标中等距为 1.0)

// 尖顶六边形 6 个顶点角度 (30°, 90°, 150°, 210°, 270°, 330°)
const HEX_CORNERS = [0, 1, 2, 3, 4, 5].map((i) => {
  const rad = ((60 * i + 30) * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
});

export class SandboxScene {
  /**
   * @param {HTMLElement} container
   * @param {object} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.lensMode = 'TACTICAL';
    this.selectedSettlementId = 4; // 默认选中许昌
    this.selectedUnitId = null;

    // 默认极简降噪图层过滤配置
    this.layerFilters = {
      showUnits: true,
      showSettlementBadges: true,
      economicPlotMode: 'SELECTED', // 'SELECTED' (仅选中城池) | 'ALL' (全部) | 'NONE' (隐藏)
      showTerritoryBorders: true,
      showLogisticsLines: false,
      showHexGrid: false,
      showGeoWatermarks: false,
    };

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container.innerHTML = '';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // tileSize 表示单个六边形的水平宽度 W_hex = sqrt(3) * R
    this.tileSize = 31;
    this.centerX = 32.5;
    this.centerY = 23.5;

    this.hoveredTile = null;
    this.keysPressed = new Set();
    this.isDragging = false;
    this.downMouse = null;
    this.lastMouse = { x: 0, y: 0 };
    this.animTime = 0;

    this.territorySettlementGrid = null;

    this._resizeCanvas();
    this._bindEvents();
    this._startLoop();
  }

  syncState(state) {
    this.state = state;
    this._computeTerritoryVoronoi(state);
  }

  setLensMode(mode) {
    this.lensMode = mode;
  }

  setLayerFilters(nextFilters) {
    this.layerFilters = { ...this.layerFilters, ...nextFilters };
  }

  focusOnTile(gx, gy) {
    this.centerX = gx + ((gy & 1) ? 0.5 : 0);
    this.centerY = gy;
  }

  zoomBy(factor) {
    this.tileSize = Math.max(18, Math.min(72, this.tileSize * factor));
  }

  resetNorth() {
    this.centerX = 32.5;
    this.centerY = 23.5;
    this.tileSize = 31;
  }

  rotateCamera(delta) {
    this.zoomBy(delta < 0 ? 1.15 : 0.87);
  }

  getProjectedLabels() {
    return [];
  }

  /**
   * 计算每个六边形格子归属的最近据点 (按真实六边形步数距离 <= 7 格)
   */
  _computeTerritoryVoronoi(state) {
    if (!state) return;
    const { width, height, terrain } = state.map;
    this.territorySettlementGrid = new Int16Array(width * height).fill(-1);
    const settlements = Object.values(state.settlements);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (terrain[idx] === TERRAIN_ENUM.WATER || terrain[idx] === TERRAIN_ENUM.CLIFF) continue;

        let nearestId = -1;
        let bestScore = 7.5;
        for (const s of settlements) {
          const weight = s.type === 'MAJOR_CITY' ? 1.0 : 1.35;
          const d = getHexDistance(s.x, s.y, x, y) * weight;
          if (d < bestScore) {
            bestScore = d;
            nearestId = s.id;
          }
        }
        this.territorySettlementGrid[idx] = nearestId;
      }
    }
  }

  /**
   * 六边形网格坐标 (gx, gy) 转画布屏幕像素中心 (px, py)
   */
  gridToScreen(gx, gy, viewW = this.viewW, viewH = this.viewH) {
    const wx = gx + ((gy & 1) ? 0.5 : 0);
    const wy = gy * ROW_V_FACTOR;
    const cWy = this.centerY * ROW_V_FACTOR;
    return {
      x: (wx - this.centerX) * this.tileSize + viewW / 2,
      y: (wy - cWy) * this.tileSize + viewH / 2,
    };
  }

  /**
   * 屏幕像素坐标 (clientX, clientY) 反算最近的六边形网格坐标 (gx, gy)
   */
  screenToGrid(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    const cWy = this.centerY * ROW_V_FACTOR;
    const wx = (sx - w / 2) / this.tileSize + this.centerX;
    const wy = (sy - h / 2) / this.tileSize + cWy;

    const approxGy = Math.round(wy / ROW_V_FACTOR);
    let bestGx = Math.round(wx - ((approxGy & 1) ? 0.5 : 0));
    let bestGy = approxGy;
    let minDist = Infinity;

    // 在周围 3x3 候选六边形中精确匹配中心最近的一格
    for (let dy = -1; dy <= 1; dy++) {
      const cy = approxGy + dy;
      const baseCx = Math.round(wx - ((cy & 1) ? 0.5 : 0));
      for (let dx = -1; dx <= 1; dx++) {
        const cx = baseCx + dx;
        const p = this.gridToScreen(cx, cy, w, h);
        const d = Math.hypot(p.x - sx, p.y - sy);
        if (d < minDist) {
          minDist = d;
          bestGx = cx;
          bestGy = cy;
        }
      }
    }

    return {
      gx: bestGx,
      gy: bestGy,
      exactX: wx,
      exactY: wy / ROW_V_FACTOR,
    };
  }

  _resizeCanvas() {
    if (!this.container) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.viewW = w;
    this.viewH = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /**
   * 绘制单个尖顶六边形路径
   */
  _traceHexPath(ctx, cx, cy, radius) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const vx = cx + radius * HEX_CORNERS[i][0];
      const vy = cy + radius * HEX_CORNERS[i][1];
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
  }

  _renderFrame() {
    const state = this.state;
    if (!state) return;

    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    const ts = this.tileSize;
    // 外接圆半径稍微放大 1.03 倍以消除相邻六边形之间的亚像素抗锯齿缝隙
    const hexR = (ts / SQRT3) * 1.035;
    const crispHexR = ts / SQRT3;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // 深色古典石板底色
    ctx.fillStyle = '#0b111e';
    ctx.fillRect(0, 0, w, h);

    const { width, height, terrain } = state.map;
    const filters = this.layerFilters;

    const minX = Math.max(0, Math.floor(this.centerX - w / (2 * ts) - 3));
    const maxX = Math.min(width - 1, Math.ceil(this.centerX + w / (2 * ts) + 3));
    const minY = Math.max(0, Math.floor(this.centerY - h / (2 * ts * ROW_V_FACTOR) - 3));
    const maxY = Math.min(height - 1, Math.ceil(this.centerY + h / (2 * ts * ROW_V_FACTOR) + 3));

    // 低饱和度雅致古风地形配色 (不刺眼、衬托城池与兵牌)
    const tilePalette = {
      [TERRAIN_ENUM.PLAIN]: '#2d442b',
      [TERRAIN_ENUM.ROAD]: '#524938',
      [TERRAIN_ENUM.FOREST]: '#1f3520',
      [TERRAIN_ENUM.MOUNTAIN]: '#45413b',
      [TERRAIN_ENUM.CLIFF]: '#2c2825',
      [TERRAIN_ENUM.WATER]: '#143b59',
      [TERRAIN_ENUM.FORD]: '#265873',
      [TERRAIN_ENUM.MARSH]: '#273f36',
    };

    // ==================== 第一层：六边形平滑地形与战略透镜底色 ====================
    for (let gy = minY; gy <= maxY; gy++) {
      for (let gx = minX; gx <= maxX; gx++) {
        const idx = gy * width + gx;
        const t = terrain[idx];
        const pos = this.gridToScreen(gx, gy, w, h);

        this._traceHexPath(ctx, pos.x, pos.y, hexR);
        ctx.fillStyle = tilePalette[t] || '#2d442b';
        ctx.fill();

        // 领地与战略透镜染色
        const ownerSettlementId = this.territorySettlementGrid ? this.territorySettlementGrid[idx] : -1;
        const ownerSettlement = ownerSettlementId > 0 ? state.settlements[ownerSettlementId] : null;
        const ownerFaction = ownerSettlement?.factionId ? state.factions[ownerSettlement.factionId] : null;

        if (t !== TERRAIN_ENUM.WATER && ownerSettlement && ownerFaction) {
          if (this.lensMode === 'POLITICAL') {
            ctx.fillStyle = hexToRgba(ownerFaction.color, 0.45);
            ctx.fill();
          } else if (this.lensMode === 'CONTROL_CLAN') {
            const cRate = ownerSettlement.controlRate ?? 80;
            ctx.fillStyle =
              cRate >= 85
                ? 'rgba(34, 197, 94, 0.38)'
                : cRate >= 65
                ? 'rgba(234, 179, 8, 0.38)'
                : 'rgba(239, 68, 68, 0.45)';
            ctx.fill();
          } else if (filters.showTerritoryBorders && this.lensMode === 'TACTICAL') {
            ctx.fillStyle = hexToRgba(ownerFaction.color, 0.14);
            ctx.fill();
          }
        }

        // 若用户开启了【六边形网格】，绘制蜂窝细框
        if (filters.showHexGrid && ts >= 20) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }

        // 精简地形符号 (仅对山岳与渡口做干净示意)
        if (ts >= 20) {
          if (t === TERRAIN_ENUM.MOUNTAIN || t === TERRAIN_ENUM.CLIFF) {
            this._drawMountainPeak(ctx, pos.x, pos.y, crispHexR, t === TERRAIN_ENUM.CLIFF);
          } else if (t === TERRAIN_ENUM.FORD) {
            this._drawFordDots(ctx, pos.x, pos.y, crispHexR);
          }
        }
      }
    }

    // ==================== 第二层：平滑官道干线绘制 (连接官道六边形中心) ====================
    ctx.save();
    ctx.strokeStyle = this.lensMode === 'LOGISTICS' ? 'rgba(251, 191, 36, 0.7)' : 'rgba(214, 191, 142, 0.32)';
    ctx.lineWidth = Math.max(2, ts * 0.12);
    ctx.lineCap = 'round';
    for (let gy = minY; gy <= maxY; gy++) {
      for (let gx = minX; gx <= maxX; gx++) {
        const idx = gy * width + gx;
        if (terrain[idx] !== TERRAIN_ENUM.ROAD && terrain[idx] !== TERRAIN_ENUM.FORD) continue;
        const p1 = this.gridToScreen(gx, gy, w, h);
        // 仅向东、东南、西南三个正方向连线避免重复
        const isOdd = (gy & 1) === 1;
        const dirs = isOdd ? [[1, 0], [0, 1], [1, 1]] : [[1, 0], [-1, 1], [0, 1]];
        for (const [dx, dy] of dirs) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nt = terrain[ny * width + nx];
          if (nt === TERRAIN_ENUM.ROAD || nt === TERRAIN_ENUM.FORD) {
            const p2 = this.gridToScreen(nx, ny, w, h);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }
      }
    }
    ctx.restore();

    // ==================== 第三层：可选山川地理水印 ====================
    if (filters.showGeoWatermarks && ts >= 20) {
      this._drawGeoWatermark(ctx, '黄 河', 26, 19, '#7dd3fc', w, h);
      this._drawGeoWatermark(ctx, '太 行 山', 23, 12, '#cbd5e1', w, h);
      this._drawGeoWatermark(ctx, '嵩 山', 28, 27, '#cbd5e1', w, h);
      this._drawGeoWatermark(ctx, '崤 山', 14, 28, '#cbd5e1', w, h);
    }

    // ==================== 第四层：城际漕运连线 (仅在开启开关或 F5 漕运透镜时显示) ====================
    if (filters.showLogisticsLines || this.lensMode === 'LOGISTICS') {
      this._drawLogisticsConnections(ctx, state, w, h);
    }

    // ==================== 第五层：城外内政用地 (默认仅显示当前选中城池，彻底告别杂乱!) ====================
    if (filters.economicPlotMode !== 'NONE') {
      this._drawEconomicPlots(ctx, state, w, h, filters.economicPlotMode === 'SELECTED');
    }
    this._drawFieldFacilities(ctx, state, w, h);

    // ==================== 第六层：12 座核心都市与 6 座关港 ====================
    this._drawSettlements(ctx, state, w, h);

    // ==================== 第七层：野战军团兵牌与行军箭头 ====================
    if (filters.showUnits) {
      this._drawUnitsAndMarchRoutes(ctx, state, w, h);
    }

    // ==================== 第八层：鼠标悬停六边形高亮 ====================
    if (this.hoveredTile) {
      const { gx, gy } = this.hoveredTile;
      if (gx >= 0 && gx < width && gy >= 0 && gy < height) {
        const pos = this.gridToScreen(gx, gy, w, h);
        this._traceHexPath(ctx, pos.x, pos.y, crispHexR);
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  _drawMountainPeak(ctx, cx, cy, r, isCliff) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.55, cy + r * 0.38);
    ctx.lineTo(cx, cy - r * (isCliff ? 0.58 : 0.42));
    ctx.lineTo(cx + r * 0.55, cy + r * 0.38);
    ctx.closePath();
    ctx.fillStyle = isCliff ? '#1c1917' : '#36322e';
    ctx.fill();
    ctx.strokeStyle = isCliff ? '#a8a29e' : '#78716c';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.restore();
  }

  _drawFordDots(ctx, cx, cy, r) {
    ctx.save();
    ctx.fillStyle = '#fde68a';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(cx + i * r * 0.35, cy, Math.max(1.8, r * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawGeoWatermark(ctx, text, gx, gy, color, viewW, viewH) {
    const p = this.gridToScreen(gx, gy, viewW, viewH);
    ctx.save();
    ctx.font = `bold ${Math.max(12, Math.round(this.tileSize * 0.45))}px "Songti SC", serif`;
    ctx.fillStyle = hexToRgba(color, 0.32);
    ctx.textAlign = 'center';
    ctx.fillText(text, p.x, p.y);
    ctx.restore();
  }

  _drawLogisticsConnections(ctx, state, viewW, viewH) {
    const drawn = new Set();
    for (const s of Object.values(state.settlements)) {
      const p1 = this.gridToScreen(s.x, s.y, viewW, viewH);
      for (const nId of s.connectedSettlementIds || []) {
        const key = s.id < nId ? `${s.id}-${nId}` : `${nId}-${s.id}`;
        if (drawn.has(key)) continue;
        drawn.add(key);

        const target = state.settlements[nId];
        if (!target) continue;
        const p2 = this.gridToScreen(target.x, target.y, viewW, viewH);
        const sameFaction = s.factionId && s.factionId === target.factionId;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = sameFaction ? 'rgba(251, 191, 36, 0.75)' : 'rgba(148, 163, 184, 0.28)';
        ctx.lineWidth = sameFaction ? 2.5 : 1.2;
        ctx.setLineDash([7, 5]);
        ctx.lineDashOffset = -this.animTime * 22;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  _drawEconomicPlots(ctx, state, viewW, viewH, onlySelected) {
    const ts = this.tileSize;
    const hexR = ts / SQRT3;
    const plotColors = {
      FARM: '#4d7c0f',
      MARKET: '#b45309',
      BARRACKS: '#b91c1c',
      SMITHY: '#c2410c',
      STABLE: '#7e22ce',
      WORKSHOP: '#0e7490',
    };

    for (const s of Object.values(state.settlements)) {
      if (onlySelected && s.id !== this.selectedSettlementId) continue;

      const cityScreen = this.gridToScreen(s.x, s.y, viewW, viewH);
      for (const plot of s.economicPlots || []) {
        const pos = this.gridToScreen(plot.x, plot.y, viewW, viewH);
        const def = ECONOMIC_BUILDING_DEFS[plot.type];
        const bg = plotColors[plot.type] || '#334155';

        ctx.save();
        // 细虚线连接母城
        ctx.beginPath();
        ctx.moveTo(cityScreen.x, cityScreen.y);
        ctx.lineTo(pos.x, pos.y);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 六边形内政地块
        this._traceHexPath(ctx, pos.x, pos.y, hexR * 0.68);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.strokeStyle = plot.level === 3 ? '#fde047' : '#e2e8f0';
        ctx.lineWidth = plot.level === 3 ? 2 : 1.2;
        ctx.stroke();

        ctx.font = `${Math.max(10, Math.round(ts * 0.36))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def?.icon || '🏠', pos.x, pos.y);

        if (ts >= 22) {
          ctx.font = 'bold 9px sans-serif';
          ctx.fillStyle = '#fef08a';
          ctx.fillText(`${def?.name || ''}Lv${plot.level}`, pos.x, pos.y + hexR * 0.85);
        }
        ctx.restore();
      }
    }
  }

  _drawFieldFacilities(ctx, state, viewW, viewH) {
    const ts = this.tileSize;
    const hexR = ts / SQRT3;
    for (const fac of Object.values(state.facilities || {})) {
      if (fac.durability <= 0) continue;
      const pos = this.gridToScreen(fac.x, fac.y, viewW, viewH);
      const facColor = state.factions[fac.factionId]?.color || '#f59e0b';

      ctx.save();
      this._traceHexPath(ctx, pos.x, pos.y, hexR * 0.62);
      ctx.fillStyle = '#1e293b';
      ctx.fill();
      ctx.strokeStyle = facColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = `${Math.max(10, Math.round(ts * 0.34))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fac.type === 'TOWER' ? '🏹' : '⛺', pos.x, pos.y);
      ctx.restore();
    }
  }

  _drawSettlements(ctx, state, viewW, viewH) {
    const ts = this.tileSize;
    const hexR = ts / SQRT3;

    for (const s of Object.values(state.settlements)) {
      const pos = this.gridToScreen(s.x, s.y, viewW, viewH);
      const faction = s.factionId ? state.factions[s.factionId] : null;
      const facColor = faction ? faction.color : '#64748b';
      const isSelected = this.selectedSettlementId === s.id;

      ctx.save();

      // 若选中该据点，高亮其周围 6 格六边形 ZOC 控制环
      if (isSelected) {
        this._traceHexPath(ctx, pos.x, pos.y, hexR * 1.85);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const r = s.type === 'MAJOR_CITY' ? Math.max(13, hexR * 0.92) : Math.max(10, hexR * 0.72);

      // 六边形城垣底座
      this._traceHexPath(ctx, pos.x, pos.y, r);
      ctx.fillStyle = '#0f172a';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fde047' : '#e2e8f0';
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.stroke();

      // 内圈势力色核
      this._traceHexPath(ctx, pos.x, pos.y, r * 0.74);
      ctx.fillStyle = facColor;
      ctx.fill();

      // 据点中心汉字或关港符号
      ctx.font = `900 ${Math.max(11, Math.round(r * 0.85))}px "Songti SC", serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const centerSymbol =
        s.type === 'MAJOR_CITY'
          ? faction?.bannerChar || '城'
          : s.type === 'PASS'
          ? '关'
          : '港';
      ctx.fillText(centerSymbol, pos.x, pos.y + 0.5);

      // 城池铭牌 (支持通过 layerFilters.showSettlementBadges 控制显隐)
      if (this.layerFilters.showSettlementBadges || isSelected) {
        const labelText = s.name;
        const troopText = `${(s.troops / 1000).toFixed(1)}k`;
        ctx.font = 'bold 11px "PingFang SC", sans-serif';
        const labelW = Math.max(70, ctx.measureText(labelText + troopText).width + 22);
        const labelH = 18;
        const lx = pos.x - labelW / 2;
        const ly = pos.y - r - labelH - 4;

        ctx.fillStyle = isSelected ? 'rgba(15, 23, 42, 0.96)' : 'rgba(15, 23, 42, 0.84)';
        ctx.strokeStyle = isSelected ? '#facc15' : facColor;
        ctx.lineWidth = isSelected ? 1.8 : 1.1;
        roundRect(ctx, lx, ly, labelW, labelH, 4);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = '#fef3c7';
        ctx.fillText(labelText, lx + 5, ly + labelH / 2 + 0.5);

        ctx.textAlign = 'right';
        ctx.font = 'bold 10px monospace';
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(troopText, lx + labelW - 5, ly + labelH / 2 + 0.5);
      }

      ctx.restore();
    }
  }

  _drawUnitsAndMarchRoutes(ctx, state, viewW, viewH) {
    const ts = this.tileSize;

    // 1. 绘制六边形中心连线行军路径
    for (const u of Object.values(state.units)) {
      const fac = state.factions[u.factionId];
      const facColor = fac ? fac.color : '#3b82f6';
      const isSelected = this.selectedUnitId === u.id;

      if (u.order?.path && u.order.path.length > 0) {
        ctx.save();
        const startPos = this.gridToScreen(u.x, u.y, viewW, viewH);
        ctx.beginPath();
        ctx.moveTo(startPos.x, startPos.y);
        for (const [px, py] of u.order.path) {
          const pt = this.gridToScreen(px, py, viewW, viewH);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.strokeStyle = isSelected ? '#38bdf8' : facColor;
        ctx.lineWidth = isSelected ? 3 : 2;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -this.animTime * 25;
        ctx.stroke();
        ctx.restore();
      }
    }

    // 2. 绘制紧凑型军团兵牌
    for (const u of Object.values(state.units)) {
      const pos = this.gridToScreen(u.x, u.y, viewW, viewH);
      const fac = state.factions[u.factionId];
      const facColor = fac ? fac.color : '#3b82f6';
      const isSelected = this.selectedUnitId === u.id;
      const cmdOfficer = state.officers[u.slots[0]?.officerId];
      const formDef = FORMATIONS[u.formationId] || FORMATIONS.FISH_SCALE;

      ctx.save();

      const cardW = Math.max(70, ts * 2.1);
      const cardH = Math.max(28, ts * 0.92);
      const cx = pos.x - cardW / 2;
      const cy = pos.y - cardH / 2;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
      ctx.strokeStyle = isSelected ? '#38bdf8' : facColor;
      ctx.lineWidth = isSelected ? 2.5 : 1.8;
      roundRect(ctx, cx, cy, cardW, cardH, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = facColor;
      roundRect(ctx, cx + 2, cy + 2, 15, cardH - 4, 3);
      ctx.fill();

      ctx.font = 'bold 10px serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fac?.bannerChar || '军', cx + 9.5, cy + cardH / 2);

      ctx.textAlign = 'left';
      ctx.font = 'bold 10px "PingFang SC", sans-serif';
      ctx.fillStyle = '#fef08a';
      ctx.fillText(
        `${cmdOfficer ? cmdOfficer.name : '部队'}·${formDef.name}`,
        cx + 20,
        cy + cardH * 0.36
      );

      ctx.font = 'bold 9px monospace';
      ctx.fillStyle = '#7dd3fc';
      ctx.fillText(`${(u.troops / 1000).toFixed(1)}k`, cx + 20, cy + cardH * 0.74);

      ctx.textAlign = 'right';
      ctx.fillStyle = u.morale < 35 ? '#f87171' : '#4ade80';
      ctx.fillText(`士${u.morale}`, cx + cardW - 5, cy + cardH * 0.74);

      if (u.lastTacticBanner) {
        const bannerText = `⚡${u.lastTacticBanner.text}`;
        ctx.font = 'bold 10px sans-serif';
        const bw = ctx.measureText(bannerText).width + 12;
        ctx.fillStyle = '#b91c1c';
        roundRect(ctx, pos.x - bw / 2, cy - 22, bw, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#fef08a';
        ctx.textAlign = 'center';
        ctx.fillText(bannerText, pos.x, cy - 14);
      }

      ctx.restore();
    }
  }

  _bindEvents() {
    window.addEventListener('resize', () => this._resizeCanvas());

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      this.keysPressed.add(k);
      if (k === 'n') this.resetNorth();
      if (k === 'q' || k === '=') this.zoomBy(1.15);
      if (k === 'e' || k === '-') this.zoomBy(0.87);
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed.delete(e.key.toLowerCase());
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = false;
      this.downMouse = { x: e.clientX, y: e.clientY, button: e.button };
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mousemove', (e) => {
      this.hoveredTile = this.screenToGrid(e.clientX, e.clientY);
      if (!this.downMouse) return;

      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      if (Math.hypot(e.clientX - this.downMouse.x, e.clientY - this.downMouse.y) > 4) {
        this.isDragging = true;
      }

      if (this.isDragging && this.downMouse.button === 0) {
        this.centerX -= dx / this.tileSize;
        this.centerY -= dy / (this.tileSize * ROW_V_FACTOR);
        this.centerX = Math.max(2, Math.min(62, this.centerX));
        this.centerY = Math.max(2, Math.min(42, this.centerY));
      }
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.downMouse) return;
      const wasDragging = this.isDragging;
      const btn = this.downMouse.button;
      this.downMouse = null;
      this.isDragging = false;

      if (!wasDragging && e.target === this.canvas) {
        this._handleCanvasClick(e, btn);
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        this.tileSize = Math.max(18, Math.min(72, this.tileSize * factor));
      },
      { passive: false }
    );
  }

  _handleCanvasClick(e, button) {
    if (!this.state) return;
    const { gx, gy } = this.screenToGrid(e.clientX, e.clientY);

    const hitUnit = Object.values(this.state.units).find(
      (u) => getHexDistance(u.x, u.y, gx, gy) <= 1
    );
    const hitSettlement = Object.values(this.state.settlements).find(
      (s) => getHexDistance(s.x, s.y, gx, gy) <= 1
    );

    if (button === 2) {
      const meta = hitSettlement
        ? { pickType: 'SETTLEMENT', id: hitSettlement.id }
        : { pickType: 'TERRAIN' };
      this.callbacks.onRightClickTile?.(gx, gy, meta);
      return;
    }

    if (hitUnit) {
      this.selectedUnitId = hitUnit.id;
      this.callbacks.onSelectUnit?.(hitUnit.id);
    } else if (hitSettlement) {
      this.selectedSettlementId = hitSettlement.id;
      this.selectedUnitId = null;
      this.callbacks.onSelectSettlement?.(hitSettlement.id);
    } else {
      this.callbacks.onClickTile?.(gx, gy);
    }
  }

  _startLoop() {
    let last = performance.now();
    const loop = (now) => {
      this.animFrameId = requestAnimationFrame(loop);
      const dt = (now - last) / 1000;
      last = now;
      this.animTime += dt;

      if (this.keysPressed.size > 0) {
        const panSpeed = (320 / this.tileSize) * dt;
        if (this.keysPressed.has('w') || this.keysPressed.has('arrowup')) this.centerY -= panSpeed;
        if (this.keysPressed.has('s') || this.keysPressed.has('arrowdown')) this.centerY += panSpeed;
        if (this.keysPressed.has('a') || this.keysPressed.has('arrowleft')) this.centerX -= panSpeed;
        if (this.keysPressed.has('d') || this.keysPressed.has('arrowright')) this.centerX += panSpeed;
        this.centerX = Math.max(2, Math.min(62, this.centerX));
        this.centerY = Math.max(2, Math.min(42, this.centerY));
      }

      this._renderFrame();
    };
    this.animFrameId = requestAnimationFrame(loop);
  }
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const clean = (hex || '#3b82f6').replace('#', '');
  const num = parseInt(clean, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
