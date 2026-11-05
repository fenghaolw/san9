/**
 * SPEC-03 (v1.1): 纯 2D HTML5 High-DPI Canvas 平面战略沙盘渲染引擎
 * 零 3D 依赖，采用古典军事舆图 + 战术兵棋风格 (Flat 2D Wargame & Classical Map)：
 * - 支持 WASD / 鼠标左键拖拽平移、滚轮以鼠标为中心无级缩放、双击或按钮一键归中
 * - 支持 F1~F5 五大战略地图透镜实时叠加 (战术沙盘 / 政治疆域 / 控制度与世家 / 四阶人口与流民 / 军需漕运网)
 * - 清晰绘制：黄河水纹、太行/嵩山/崤山山形水墨纹理、帝国官道、城外 Lv1~Lv3 内政用地、
 *   双层城郭/关隘/渡口、部队行军动态虚线箭头、五将战术兵牌与兵法联动飘字。
 */

import { ECONOMIC_BUILDING_DEFS, FORMATIONS, TERRAIN_DEFS, TERRAIN_ENUM } from '../data/tacticsAndFormations.js';

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

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container.innerHTML = '';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // 视图相机状态：中心对准中原核心走廊 (陈留—虎牢关—许昌—官渡, x=32, y=23)
    this.tileSize = 30; // 单格默认像素尺寸 (支持 16px ~ 68px 缩放)
    this.centerX = 32.5;
    this.centerY = 23.5;

    this.hoveredTile = null;
    this.keysPressed = new Set();
    this.isDragging = false;
    this.downMouse = null;
    this.lastMouse = { x: 0, y: 0 };
    this.animTime = 0;

    // 预计算每个格子所属的最近城池 ID (用于 F2 政治疆域与 F3 控制度染色)
    this.territoryOwnerGrid = null;

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

  focusOnTile(gx, gy) {
    this.centerX = gx;
    this.centerY = gy;
  }

  zoomBy(factor) {
    this.tileSize = Math.max(16, Math.min(68, this.tileSize * factor));
  }

  resetNorth() {
    this.centerX = 32.5;
    this.centerY = 23.5;
    this.tileSize = 30;
  }

  rotateCamera(delta) {
    // 兼容旧按钮调用：在 2D 平面模式下映射为缩放
    this.zoomBy(delta < 0 ? 1.15 : 0.87);
  }

  getProjectedLabels() {
    // 2D 平面模式下所有城池、内政建筑与部队兵牌直接在高分屏 Canvas 上原生绘制，无需额外 DOM 投影层
    return [];
  }

  /**
   * 计算每个网格点归属的最近据点 (半径 8.5 格以内)，并生成疆域边界
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
        let bestDist = 8.5;
        for (const s of settlements) {
          const weight = s.type === 'MAJOR_CITY' ? 1.0 : 1.35;
          const d = Math.hypot(s.x - x, s.y - y) * weight;
          if (d < bestDist) {
            bestDist = d;
            nearestId = s.id;
          }
        }
        this.territorySettlementGrid[idx] = nearestId;
      }
    }
  }

  /**
   * 屏幕像素坐标 (clientX, clientY) 转地图网格坐标 (gx, gy)
   */
  screenToGrid(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    const gx = (sx - w / 2) / this.tileSize + this.centerX;
    const gy = (sy - h / 2) / this.tileSize + this.centerY;
    return {
      gx: Math.floor(gx),
      gy: Math.floor(gy),
      exactX: gx,
      exactY: gy,
    };
  }

  /**
   * 网格坐标 (gx, gy) 转画布中心像素坐标 (px, py)
   */
  gridToScreen(gx, gy, viewW, viewH) {
    return {
      x: (gx + 0.5 - this.centerX) * this.tileSize + viewW / 2,
      y: (gy + 0.5 - this.centerY) * this.tileSize + viewH / 2,
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
   * 主渲染管线：按层绘制 2D 平面战略沙盘
   */
  _renderFrame() {
    const state = this.state;
    if (!state) return;

    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    const ts = this.tileSize;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // 背景深邃古卷底色
    ctx.fillStyle = '#0c1322';
    ctx.fillRect(0, 0, w, h);

    const { width, height, terrain } = state.map;

    // 计算当前视口可见的网格范围 (视锥体裁剪)
    const minX = Math.max(0, Math.floor(this.centerX - w / (2 * ts) - 2));
    const maxX = Math.min(width - 1, Math.ceil(this.centerX + w / (2 * ts) + 2));
    const minY = Math.max(0, Math.floor(this.centerY - h / (2 * ts) - 2));
    const maxY = Math.min(height - 1, Math.ceil(this.centerY + h / (2 * ts) + 2));

    // ==================== 第一层：地形方格与 F1~F5 战略透镜底色 ====================
    const tilePalette = {
      [TERRAIN_ENUM.PLAIN]: '#3e5c38',
      [TERRAIN_ENUM.ROAD]: '#7b6b4d',
      [TERRAIN_ENUM.FOREST]: '#2a4728',
      [TERRAIN_ENUM.MOUNTAIN]: '#57524a',
      [TERRAIN_ENUM.CLIFF]: '#3b3631',
      [TERRAIN_ENUM.WATER]: '#194a6e',
      [TERRAIN_ENUM.FORD]: '#356d8a',
      [TERRAIN_ENUM.MARSH]: '#365347',
    };

    for (let gy = minY; gy <= maxY; gy++) {
      for (let gx = minX; gx <= maxX; gx++) {
        const idx = gy * width + gx;
        const t = terrain[idx];
        const px = (gx - this.centerX) * ts + w / 2;
        const py = (gy - this.centerY) * ts + h / 2;

        // 基础地形色
        ctx.fillStyle = tilePalette[t] || '#3e5c38';
        ctx.fillRect(px, py, ts + 0.6, ts + 0.6);

        // 战略透镜染色叠加 (F2 政治疆域 / F3 控制度热力图 / F4 人口密度 / F5 军需漕运网)
        const ownerSettlementId = this.territorySettlementGrid ? this.territorySettlementGrid[idx] : -1;
        const ownerSettlement = ownerSettlementId > 0 ? state.settlements[ownerSettlementId] : null;
        const ownerFaction = ownerSettlement?.factionId ? state.factions[ownerSettlement.factionId] : null;

        if (t !== TERRAIN_ENUM.WATER && ownerSettlement && ownerFaction) {
          if (this.lensMode === 'POLITICAL') {
            ctx.fillStyle = hexToRgba(ownerFaction.color, 0.44);
            ctx.fillRect(px, py, ts + 0.5, ts + 0.5);
          } else if (this.lensMode === 'CONTROL_CLAN') {
            const cRate = ownerSettlement.controlRate ?? 80;
            const heatColor =
              cRate >= 85
                ? 'rgba(34, 197, 94, 0.42)'
                : cRate >= 65
                ? 'rgba(234, 179, 8, 0.42)'
                : 'rgba(239, 68, 68, 0.48)';
            ctx.fillStyle = heatColor;
            ctx.fillRect(px, py, ts + 0.5, ts + 0.5);
          } else if (this.lensMode === 'TACTICAL') {
            // 战术模式下仅给领地涂一层极淡的势力归属色 (12% 透明度)
            ctx.fillStyle = hexToRgba(ownerFaction.color, 0.12);
            ctx.fillRect(px, py, ts + 0.5, ts + 0.5);
          }
        }

        // 绘制地形细节纹理 (山形、林木、水纹、浅滩、官道)
        if (ts >= 20) {
          if (t === TERRAIN_ENUM.MOUNTAIN || t === TERRAIN_ENUM.CLIFF) {
            this._drawMountainIcon(ctx, px, py, ts, t === TERRAIN_ENUM.CLIFF);
          } else if (t === TERRAIN_ENUM.FOREST) {
            this._drawForestIcon(ctx, px, py, ts);
          } else if (t === TERRAIN_ENUM.WATER) {
            this._drawWaterWave(ctx, px, py, ts, gx, gy);
          } else if (t === TERRAIN_ENUM.FORD) {
            this._drawFordSteppingStones(ctx, px, py, ts);
          } else if (t === TERRAIN_ENUM.ROAD) {
            ctx.strokeStyle = 'rgba(234, 214, 172, 0.42)';
            ctx.lineWidth = Math.max(1, ts * 0.08);
            ctx.strokeRect(px + ts * 0.25, py + ts * 0.25, ts * 0.5, ts * 0.5);
          }
        }

        // 棋盘细网格线
        if (ts >= 22) {
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
          ctx.lineWidth = 0.75;
          ctx.strokeRect(px, py, ts, ts);
        }

        // 绘制不同据点领地之间的分界线
        if (ownerSettlementId > 0 && this.territorySettlementGrid) {
          const rightOwner = gx + 1 < width ? this.territorySettlementGrid[gy * width + (gx + 1)] : ownerSettlementId;
          const downOwner = gy + 1 < height ? this.territorySettlementGrid[(gy + 1) * width + gx] : ownerSettlementId;
          ctx.strokeStyle = ownerFaction ? hexToRgba(ownerFaction.color, 0.65) : 'rgba(148,163,184,0.4)';
          ctx.lineWidth = 1.5;
          if (rightOwner !== ownerSettlementId && rightOwner > 0) {
            ctx.beginPath();
            ctx.moveTo(px + ts, py);
            ctx.lineTo(px + ts, py + ts);
            ctx.stroke();
          }
          if (downOwner !== ownerSettlementId && downOwner > 0) {
            ctx.beginPath();
            ctx.moveTo(px, py + ts);
            ctx.lineTo(px + ts, py + ts);
            ctx.stroke();
          }
        }
      }
    }

    // ==================== 第二层：山川地理书法标注 ====================
    if (ts >= 20) {
      this._drawGeoWatermark(ctx, '黄 河 九 曲', 26, 19, '#7dd3fc', w, h);
      this._drawGeoWatermark(ctx, '太 行 山 脉', 23, 12, '#cbd5e1', w, h);
      this._drawGeoWatermark(ctx, '嵩 山 天 险', 28, 27, '#cbd5e1', w, h);
      this._drawGeoWatermark(ctx, '崤 山 · 函 谷', 14, 28, '#cbd5e1', w, h);
      this._drawGeoWatermark(ctx, '淮 水 流 域', 42, 38, '#7dd3fc', w, h);
    }

    // ==================== 第三层：F5 军需漕运网干线与动态运粮流向 ====================
    this._drawLogisticsConnections(ctx, state, w, h);

    // ==================== 第四层：大地图 Lv1~Lv3 内政建筑与野外军事设施 ====================
    this._drawEconomicPlotsAndFacilities(ctx, state, w, h);

    // ==================== 第五层：12 座都市与 6 座咽喉关港 ====================
    this._drawSettlements(ctx, state, w, h);

    // ==================== 第六层：部队行军路线虚线箭头与五将战术兵牌 ====================
    this._drawUnitsAndMarchRoutes(ctx, state, w, h);

    // ==================== 第七层：鼠标悬停格子高亮与浮窗提示 ====================
    if (this.hoveredTile) {
      const { gx, gy } = this.hoveredTile;
      if (gx >= 0 && gx < width && gy >= 0 && gy < height) {
        const px = (gx - this.centerX) * ts + w / 2;
        const py = (gy - this.centerY) * ts + h / 2;
        ctx.strokeStyle = '#fde047';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, ts - 2, ts - 2);
      }
    }

    ctx.restore();
  }

  _drawMountainIcon(ctx, px, py, ts, isCliff) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(px + ts * 0.15, py + ts * 0.82);
    ctx.lineTo(px + ts * 0.5, py + ts * (isCliff ? 0.14 : 0.24));
    ctx.lineTo(px + ts * 0.85, py + ts * 0.82);
    ctx.closePath();
    ctx.fillStyle = isCliff ? '#292524' : '#44403c';
    ctx.fill();
    ctx.strokeStyle = isCliff ? '#a8a29e' : '#78716c';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 山巅高光
    if (isCliff) {
      ctx.beginPath();
      ctx.moveTo(px + ts * 0.38, py + ts * 0.38);
      ctx.lineTo(px + ts * 0.5, py + ts * 0.14);
      ctx.lineTo(px + ts * 0.62, py + ts * 0.38);
      ctx.fillStyle = '#d6d3d1';
      ctx.fill();
    }
    ctx.restore();
  }

  _drawForestIcon(ctx, px, py, ts) {
    ctx.save();
    ctx.fillStyle = '#1e3a1e';
    ctx.beginPath();
    ctx.arc(px + ts * 0.38, py + ts * 0.45, ts * 0.22, 0, Math.PI * 2);
    ctx.arc(px + ts * 0.64, py + ts * 0.52, ts * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawWaterWave(ctx, px, py, ts, gx, gy) {
    ctx.save();
    const offset = Math.sin(this.animTime * 2 + gx * 0.7 + gy * 0.5) * 2;
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(px + ts * 0.2 + offset, py + ts * 0.5);
    ctx.quadraticCurveTo(px + ts * 0.5, py + ts * 0.35, px + ts * 0.8 + offset, py + ts * 0.5);
    ctx.stroke();
    ctx.restore();
  }

  _drawFordSteppingStones(ctx, px, py, ts) {
    ctx.save();
    ctx.fillStyle = '#fde68a';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(px + ts * (0.28 + i * 0.22), py + ts * 0.5, Math.max(2, ts * 0.08), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawGeoWatermark(ctx, text, gx, gy, color, viewW, viewH) {
    const p = this.gridToScreen(gx, gy, viewW, viewH);
    ctx.save();
    ctx.font = `bold ${Math.max(11, Math.round(this.tileSize * 0.42))}px "Songti SC", "Noto Serif SC", serif`;
    ctx.fillStyle = hexToRgba(color, 0.35);
    ctx.textAlign = 'center';
    ctx.fillText(text, p.x, p.y);
    ctx.restore();
  }

  /**
   * 绘制据点之间的连通干线与 F5 军需漕运网动态流向
   */
  _drawLogisticsConnections(ctx, state, viewW, viewH) {
    const drawn = new Set();
    const isLogisticsLens = this.lensMode === 'LOGISTICS';

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

        if (isLogisticsLens) {
          ctx.strokeStyle = sameFaction ? '#fbbf24' : 'rgba(148, 163, 184, 0.35)';
          ctx.lineWidth = sameFaction ? 3 : 1.5;
          ctx.setLineDash(sameFaction ? [8, 6] : [4, 4]);
          ctx.lineDashOffset = -this.animTime * 24;
        } else {
          ctx.strokeStyle = 'rgba(217, 179, 108, 0.25)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * 绘制城外 Lv1~Lv3 大地图内政建筑与野外军事设施
   */
  _drawEconomicPlotsAndFacilities(ctx, state, viewW, viewH) {
    const ts = this.tileSize;
    const plotColors = {
      FARM: '#4d7c0f',
      MARKET: '#b45309',
      BARRACKS: '#b91c1c',
      SMITHY: '#c2410c',
      STABLE: '#7e22ce',
      WORKSHOP: '#0e7490',
    };

    for (const s of Object.values(state.settlements)) {
      const cityScreen = this.gridToScreen(s.x, s.y, viewW, viewH);

      for (const plot of s.economicPlots || []) {
        const pos = this.gridToScreen(plot.x, plot.y, viewW, viewH);
        const def = ECONOMIC_BUILDING_DEFS[plot.type];
        const bg = plotColors[plot.type] || '#334155';

        // 细虚线连接所属母城
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cityScreen.x, cityScreen.y);
        ctx.lineTo(pos.x, pos.y);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // 内政用地小方牌
        const boxR = Math.max(9, ts * 0.38);
        ctx.fillStyle = bg;
        ctx.strokeStyle = plot.level === 3 ? '#fde047' : '#cbd5e1';
        ctx.lineWidth = plot.level === 3 ? 2 : 1.2;
        roundRect(ctx, pos.x - boxR, pos.y - boxR, boxR * 2, boxR * 2, 4);
        ctx.fill();
        ctx.stroke();

        if (ts >= 22) {
          ctx.font = `${Math.max(10, Math.round(ts * 0.38))}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(def?.icon || '🏠', pos.x, pos.y - 1);

          // 等级角标 Lv1~Lv3
          ctx.font = `bold ${Math.max(8, Math.round(ts * 0.25))}px monospace`;
          ctx.fillStyle = '#fef08a';
          ctx.fillText(`Lv${plot.level}`, pos.x, pos.y + boxR + 7);
        }
        ctx.restore();
      }
    }

    // 野外军事设施 (连弩橹 / 前哨阵)
    for (const fac of Object.values(state.facilities || {})) {
      if (fac.durability <= 0) continue;
      const pos = this.gridToScreen(fac.x, fac.y, viewW, viewH);
      const facColor = state.factions[fac.factionId]?.color || '#f59e0b';
      const r = Math.max(9, ts * 0.38);

      ctx.save();
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = facColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.font = `${Math.max(10, Math.round(ts * 0.36))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fac.type === 'TOWER' ? '🏹' : '⛺', pos.x, pos.y);

      if (ts >= 24) {
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#fde68a';
        ctx.fillText(fac.name, pos.x, pos.y + r + 9);
      }
      ctx.restore();
    }
  }

  /**
   * 绘制 12 座核心都市与 6 座咽喉关隘/黄河渡口
   */
  _drawSettlements(ctx, state, viewW, viewH) {
    const ts = this.tileSize;

    for (const s of Object.values(state.settlements)) {
      const pos = this.gridToScreen(s.x, s.y, viewW, viewH);
      const faction = s.factionId ? state.factions[s.factionId] : null;
      const facColor = faction ? faction.color : '#64748b';
      const isSelected = this.selectedSettlementId === s.id;

      ctx.save();

      // 选中城池时绘制 ZOC 控制范围圈與呼吸高亮光环
      if (isSelected) {
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.35)';
        ctx.fillStyle = 'rgba(250, 204, 21, 0.06)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        const zocPx = (s.zocRadius + 0.5) * ts * 2;
        ctx.strokeRect(pos.x - zocPx / 2, pos.y - zocPx / 2, zocPx, zocPx);
        ctx.fillRect(pos.x - zocPx / 2, pos.y - zocPx / 2, zocPx, zocPx);
        ctx.setLineDash([]);
      }

      const r = s.type === 'MAJOR_CITY' ? Math.max(14, ts * 0.58) : Math.max(11, ts * 0.45);

      if (s.type === 'MAJOR_CITY') {
        // 大都市：古典双层方形城池城郭
        ctx.fillStyle = '#1e293b';
        ctx.strokeStyle = isSelected ? '#fde047' : '#e2e8f0';
        ctx.lineWidth = isSelected ? 3 : 2;
        roundRect(ctx, pos.x - r, pos.y - r, r * 2, r * 2, 4);
        ctx.fill();
        ctx.stroke();

        // 内城势力主殿色块
        ctx.fillStyle = facColor;
        roundRect(ctx, pos.x - r * 0.68, pos.y - r * 0.68, r * 1.36, r * 1.36, 2);
        ctx.fill();

        // 中央势力汉字徽记
        ctx.font = `900 ${Math.max(11, Math.round(r * 0.92))}px "Songti SC", serif`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(faction?.bannerChar || '城', pos.x, pos.y + 1);
      } else if (s.type === 'PASS') {
        // 险要关隘 (虎牢关/潼关/壶关)：八角雄关图案
        ctx.fillStyle = '#334155';
        ctx.strokeStyle = isSelected ? '#fde047' : facColor;
        ctx.lineWidth = isSelected ? 3 : 2.2;
        roundRect(ctx, pos.x - r * 1.15, pos.y - r * 0.85, r * 2.3, r * 1.7, 3);
        ctx.fill();
        ctx.stroke();

        ctx.font = `bold ${Math.max(10, Math.round(r * 0.8))}px sans-serif`;
        ctx.fillStyle = '#fef08a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⛩️', pos.x, pos.y);
      } else {
        // 战略军港 (官渡港/白马港/延津港)：圆形水寨
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = isSelected ? '#fde047' : facColor;
        ctx.lineWidth = isSelected ? 3 : 2.2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.font = `${Math.max(10, Math.round(r * 0.85))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚓', pos.x, pos.y);
      }

      // 城池顶部铭牌：[城名 | 兵力 | レンズ附加信息]
      const labelText = `${s.name}`;
      const troopText = `${(s.troops / 1000).toFixed(1)}k`;
      ctx.font = 'bold 12px "PingFang SC", sans-serif';
      const labelW = Math.max(76, ctx.measureText(labelText + troopText).width + 26);
      const labelH = 20;
      const lx = pos.x - labelW / 2;
      const ly = pos.y - r - labelH - 5;

      ctx.fillStyle = isSelected ? 'rgba(15, 23, 42, 0.96)' : 'rgba(15, 23, 42, 0.88)';
      ctx.strokeStyle = isSelected ? '#facc15' : facColor;
      ctx.lineWidth = isSelected ? 2 : 1.2;
      roundRect(ctx, lx, ly, labelW, labelH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fef3c7';
      ctx.fillText(labelText, lx + 6, ly + labelH / 2);

      ctx.textAlign = 'right';
      ctx.font = 'bold 11px monospace';
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(troopText, lx + labelW - 6, ly + labelH / 2);

      // 城防耐久与兵粮士气细条
      const barW = r * 2;
      const wallPct = Math.max(0, Math.min(1, s.wallDurability / s.maxWallDurability));
      ctx.fillStyle = 'rgba(15,23,42,0.85)';
      ctx.fillRect(pos.x - r, pos.y + r + 3, barW, 4);
      ctx.fillStyle = wallPct > 0.5 ? '#22c55e' : '#ef4444';
      ctx.fillRect(pos.x - r, pos.y + r + 3, barW * wallPct, 4);

      // 战略透镜专属附加标签
      if (this.lensMode === 'CONTROL_CLAN') {
        const clanName = s.dominantClanId ? state.clans[s.dominantClanId]?.name.split('·')[0] : '';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = s.controlRate >= 85 ? '#4ade80' : '#facc15';
        ctx.fillText(`控制度:${s.controlRate}% ${clanName}`, pos.x, pos.y + r + 16);
      } else if (this.lensMode === 'POPS_REFUGEE') {
        // 绘制自耕农(绿) / 世家部曲(金) / 流民(红) 迷你柱状图
        const bars = [
          { val: s.pops.freePeasants, color: '#22c55e', dx: -12 },
          { val: s.pops.clanRetainers, color: '#eab308', dx: 0 },
          { val: s.pops.refugees, color: '#ef4444', dx: 12 },
        ];
        for (const b of bars) {
          const bh = Math.min(34, Math.max(4, Math.round(b.val / 1500)));
          ctx.fillStyle = b.color;
          ctx.fillRect(pos.x + b.dx - 4, ly - bh - 3, 8, bh);
        }
      } else if (this.lensMode === 'LOGISTICS') {
        const roleTag =
          s.logisticsRole === 'REAR_SUPPLY'
            ? '📦后方供应基地'
            : s.logisticsRole === 'FRONTLINE_DEMAND'
            ? '⚔️前线重点军镇'
            : '⚖️中转据点';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fde047';
        ctx.fillText(roleTag, pos.x, pos.y + r + 16);
      }

      ctx.restore();
    }
  }

  /**
   * 绘制野外五将部队兵牌与动态行军路线箭头
   */
  _drawUnitsAndMarchRoutes(ctx, state, viewW, viewH) {
    const ts = this.tileSize;

    // 1. 先绘制行军路线虚线与目标准星
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
        ctx.lineWidth = isSelected ? 3.2 : 2.2;
        ctx.setLineDash([7, 5]);
        ctx.lineDashOffset = -this.animTime * 28;
        ctx.stroke();
        ctx.setLineDash([]);

        // 终点准星圆环
        const last = u.order.path[u.order.path.length - 1];
        const endPos = this.gridToScreen(last[0], last[1], viewW, viewH);
        ctx.beginPath();
        ctx.arc(endPos.x, endPos.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#38bdf8' : facColor;
        ctx.fill();
        ctx.restore();
      }
    }

    // 2. 绘制五将战术兵牌 (Wargame Counter)
    for (const u of Object.values(state.units)) {
      const pos = this.gridToScreen(u.x, u.y, viewW, viewH);
      const fac = state.factions[u.factionId];
      const facColor = fac ? fac.color : '#3b82f6';
      const isSelected = this.selectedUnitId === u.id;
      const cmdOfficer = state.officers[u.slots[0]?.officerId];
      const formDef = FORMATIONS[u.formationId] || FORMATIONS.FISH_SCALE;

      ctx.save();

      const cardW = Math.max(76, ts * 2.35);
      const cardH = Math.max(34, ts * 1.15);
      const cx = pos.x - cardW / 2;
      const cy = pos.y - cardH / 2;

      // 兵牌阴影与背景
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = isSelected ? '#38bdf8' : facColor;
      ctx.lineWidth = isSelected ? 3 : 2;
      roundRect(ctx, cx, cy, cardW, cardH, 6);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 左侧势力色条
      ctx.fillStyle = facColor;
      roundRect(ctx, cx + 2, cy + 2, 18, cardH - 4, 4);
      ctx.fill();

      ctx.font = 'bold 11px serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fac?.bannerChar || '军', cx + 11, cy + cardH / 2);

      // 兵牌第一行：阵型符号 + 主将名 + 阵型名
      ctx.textAlign = 'left';
      ctx.font = 'bold 11px "PingFang SC", sans-serif';
      ctx.fillStyle = '#fef08a';
      ctx.fillText(
        `${formDef.symbol}${cmdOfficer ? cmdOfficer.name : '部队'} [${formDef.name}]`,
        cx + 24,
        cy + cardH * 0.34
      );

      // 兵牌第二行：兵力 + 士气
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = '#7dd3fc';
      ctx.fillText(`${u.troops.toLocaleString()}兵`, cx + 24, cy + cardH * 0.72);

      ctx.textAlign = 'right';
      ctx.fillStyle = u.morale < 35 ? '#f87171' : '#4ade80';
      ctx.fillText(`士${u.morale}`, cx + cardW - 6, cy + cardH * 0.72);

      // CK3 状态角标 (死敌血战 / 混乱)
      if (u.statusEffect === 'BLOOD_FEUD_RAGE') {
        ctx.fillStyle = '#dc2626';
        roundRect(ctx, pos.x - 32, cy - 15, 64, 13, 3);
        ctx.fill();
        ctx.font = 'bold 9px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText('💢死敌血战', pos.x, cy - 8.5);
      } else if (u.statusEffect === 'CONFUSED') {
        ctx.fillStyle = '#7e22ce';
        roundRect(ctx, pos.x - 28, cy - 15, 56, 13, 3);
        ctx.fill();
        ctx.font = 'bold 9px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText('💫混乱中', pos.x, cy - 8.5);
      }

      // 兵法发动与 2~5 联动飘字横幅
      if (u.lastTacticBanner) {
        const bannerText = `⚡ ${u.lastTacticBanner.text} (-${u.lastTacticBanner.damage})`;
        ctx.font = 'bold 11px "PingFang SC", sans-serif';
        const bw = ctx.measureText(bannerText).width + 16;
        const bx = pos.x - bw / 2;
        const by = cy - 32;
        ctx.fillStyle = '#b91c1c';
        ctx.strokeStyle = '#fde047';
        ctx.lineWidth = 1.5;
        roundRect(ctx, bx, by, bw, 18, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#fef08a';
        ctx.textAlign = 'center';
        ctx.fillText(bannerText, pos.x, by + 9.5);
      }

      ctx.restore();
    }
  }

  _bindEvents() {
    window.addEventListener('resize', () => {
      this._resizeCanvas();
    });

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
      const gridPos = this.screenToGrid(e.clientX, e.clientY);
      this.hoveredTile = gridPos;

      if (!this.downMouse) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;

      if (Math.hypot(e.clientX - this.downMouse.x, e.clientY - this.downMouse.y) > 4) {
        this.isDragging = true;
      }

      if (this.isDragging && this.downMouse.button === 0) {
        this.centerX -= dx / this.tileSize;
        this.centerY -= dy / this.tileSize;
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
        const before = this.screenToGrid(e.clientX, e.clientY);
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        this.tileSize = Math.max(16, Math.min(68, this.tileSize * factor));
        const after = this.screenToGrid(e.clientX, e.clientY);

        // 保持鼠标指向的格子在缩放时不偏移
        this.centerX += before.exactX - after.exactX;
        this.centerY += before.exactY - after.exactY;
        this.centerX = Math.max(2, Math.min(62, this.centerX));
        this.centerY = Math.max(2, Math.min(42, this.centerY));
      },
      { passive: false }
    );
  }

  _handleCanvasClick(e, button) {
    if (!this.state) return;
    const { gx, gy, exactX, exactY } = this.screenToGrid(e.clientX, e.clientY);

    // 1. 检查是否点击了某支部队兵牌 (距离 <= 1.25 格)
    const hitUnit = Object.values(this.state.units).find(
      (u) => Math.hypot(u.x + 0.5 - exactX, u.y + 0.5 - exactY) <= 1.35
    );

    // 2. 检查是否点击了某座城池或关港 (距离 <= 1.35 格)
    const hitSettlement = Object.values(this.state.settlements).find(
      (s) => Math.hypot(s.x + 0.5 - exactX, s.y + 0.5 - exactY) <= 1.4
    );

    // 3. 检查是否点击了某处城外内政用地 (自动选中其所属母城)
    let hitPlotSettlementId = null;
    for (const s of Object.values(this.state.settlements)) {
      if ((s.economicPlots || []).some((p) => p.x === gx && p.y === gy)) {
        hitPlotSettlementId = s.id;
        break;
      }
    }

    if (button === 2) {
      // 右键点击：若已选中本方部队，下达进军目标指令
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
    } else if (hitPlotSettlementId) {
      this.selectedSettlementId = hitPlotSettlementId;
      this.selectedUnitId = null;
      this.callbacks.onSelectSettlement?.(hitPlotSettlementId);
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

      // WASD 键盘平滑移动
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
