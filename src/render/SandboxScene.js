/**
 * SPEC-03: Three.js 2.5D 桌面端高刷沙盘渲染引擎
 * 支持：
 * - "伪3D" 可旋转 (Q/E 或右键拖拽 Yaw 360°) 与俯仰调节 (Pitch 32°~68°)、WASD 平移、滚轮缩放
 * - 64x44 高度图地形网格 + 黄河水波动画 + 官道与山岳立体起伏
 * - F1~F5 五大战略地图透镜实时着色切换 (战术沙盘 / 政治疆域 / 控制度世家 / 人口流民 / 军需漕运网)
 * - 立体城池/关隘/港口体块、城外 Lv1~Lv3 大地图内政建筑、野外连弩橹/前哨阵、5将立体兵棋与动态行军路线箭头
 */

import * as THREE from 'three';
import { ECONOMIC_BUILDING_DEFS, FORMATIONS, TERRAIN_DEFS, TERRAIN_ENUM } from '../data/tacticsAndFormations.js';

export class SandboxScene {
  /**
   * @param {HTMLElement} container
   * @param {object} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.lensMode = 'TACTICAL'; // TACTICAL | POLITICAL | CONTROL_CLAN | POPS_REFUGEE | LOGISTICS
    this.selectedSettlementId = 4; // 默认选中许昌
    this.selectedUnitId = null;
    this.targetingMode = null; // 若非空，表示正在为某部队或出征选择地图目标

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0f172a');
    this.scene.fog = new THREE.FogExp2('#0f172a', 0.0065);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // 低畸变 "伪3D" 战略沙盘透视相机 (FOV = 28°)
    this.camera = new THREE.PerspectiveCamera(28, width / height, 1, 450);

    // 相机球坐标参数
    this.target = new THREE.Vector3(33, 0, 24); // 默认聚焦中原 (洛阳—虎牢关—许昌—官渡走廊)
    this.distance = 44;
    this.yaw = 0; // 0 弧度 = 正北朝上
    this.pitch = 0.92; // ~53° 经典三国志9俯视倾角

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    container.innerHTML = '';
    container.appendChild(this.renderer.domElement);

    // 灯光系统
    const ambient = new THREE.AmbientLight('#e2e8f0', 1.15);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight('#fffbeb', 1.55);
    sun.position.set(25, 55, 30);
    sun.castShadow = true;
    this.scene.add(sun);

    // 场景分组容器
    this.terrainGroup = new THREE.Group();
    this.settlementGroup = new THREE.Group();
    this.plotGroup = new THREE.Group();
    this.unitGroup = new THREE.Group();
    this.routeGroup = new THREE.Group();
    this.lensOverlayGroup = new THREE.Group();

    this.scene.add(this.terrainGroup);
    this.scene.add(this.settlementGroup);
    this.scene.add(this.plotGroup);
    this.scene.add(this.unitGroup);
    this.scene.add(this.routeGroup);
    this.scene.add(this.lensOverlayGroup);

    this.pickables = [];
    this.labelAnchors = []; // 用于投射屏幕 2D 浮动战略标牌
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.keysPressed = new Set();
    this.isDragging = false;
    this.dragButton = 0;
    this.lastMouse = { x: 0, y: 0 };
    this.clock = new THREE.Clock();

    this._bindEvents();
    this._updateCameraTransform();
    this._startLoop();
  }

  /**
   * 根据 GameState 初始化或刷新整个 2.5D 沙盘网格与实体
   */
  syncState(state) {
    this.state = state;
    if (!this.terrainBuilt) {
      this._buildTerrainMesh(state);
      this.terrainBuilt = true;
    } else {
      this._updateTerrainVertexColors(state);
    }
    this._rebuildSettlementsAndPlots(state);
    this._rebuildUnitsAndRoutes(state);
    this._rebuildLensOverlays(state);
  }

  setLensMode(mode) {
    this.lensMode = mode;
    if (this.state) {
      this._updateTerrainVertexColors(this.state);
      this._rebuildLensOverlays(this.state);
    }
  }

  focusOnTile(x, y) {
    this.target.set(x, 0, y);
    this._updateCameraTransform();
  }

  rotateCamera(deltaYaw, deltaPitch = 0) {
    this.yaw += deltaYaw;
    this.pitch = Math.max(0.55, Math.min(1.28, this.pitch + deltaPitch));
    this._updateCameraTransform();
  }

  resetNorth() {
    this.yaw = 0;
    this.pitch = 0.92;
    this._updateCameraTransform();
  }

  /**
   * 构建 64x44 2.5D 高度图地形网格
   */
  _buildTerrainMesh(state) {
    this.terrainGroup.clear();
    const { width, height, elevation } = state.map;

    const geom = new THREE.PlaneGeometry(width, height, width - 1, height - 1);
    geom.rotateX(-Math.PI / 2);

    const posAttr = geom.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);

    for (let i = 0; i < posAttr.count; i++) {
      // PlaneGeometry 顶点转网格坐标 (0..width-1, 0..height-1)
      const vx = Math.min(width - 1, Math.max(0, Math.round(posAttr.getX(i) + width / 2)));
      const vz = Math.min(height - 1, Math.max(0, Math.round(posAttr.getZ(i) + height / 2)));
      const idx = vz * width + vx;
      const h = elevation[idx] ?? 0.2;

      posAttr.setX(i, vx);
      posAttr.setY(i, h);
      posAttr.setZ(i, vz);
    }

    geom.computeVertexNormals();
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.08,
      flatShading: true,
    });

    this.terrainMesh = new THREE.Mesh(geom, mat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.userData = { pickType: 'TERRAIN' };
    this.terrainGroup.add(this.terrainMesh);

    // 添加半透明黄河水面层
    const waterGeom = new THREE.PlaneGeometry(width, height);
    waterGeom.rotateX(-Math.PI / 2);
    waterGeom.translate(width / 2 - 0.5, -0.08, height / 2 - 0.5);
    const waterMat = new THREE.MeshStandardMaterial({
      color: '#1d6fa5',
      transparent: true,
      opacity: 0.72,
      roughness: 0.25,
      metalness: 0.35,
    });
    this.waterMesh = new THREE.Mesh(waterGeom, waterMat);
    this.terrainGroup.add(this.waterMesh);

    this._updateTerrainVertexColors(state);
  }

  /**
   * 根据当前激活的战略地图透镜 (F1~F5) 动态刷新地形顶点颜色
   */
  _updateTerrainVertexColors(state) {
    if (!this.terrainMesh) return;
    const { width, height, terrain } = state.map;
    const posAttr = this.terrainMesh.geometry.attributes.position;
    const colorAttr = this.terrainMesh.geometry.attributes.color;
    const c = new THREE.Color();

    // 预备各据点领地归属查找 (7格半径 Voronoi 近似)
    const settlements = Object.values(state.settlements);
    const findNearestSettlement = (x, z) => {
      let best = null;
      let bestDist = 9.5;
      for (const s of settlements) {
        const d = Math.hypot(s.x - x, s.y - z);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      return best;
    };

    for (let i = 0; i < posAttr.count; i++) {
      const vx = Math.min(width - 1, Math.max(0, Math.round(posAttr.getX(i))));
      const vz = Math.min(height - 1, Math.max(0, Math.round(posAttr.getZ(i))));
      const idx = vz * width + vx;
      const t = terrain[idx];
      const baseHex = TERRAIN_DEFS[t]?.color || '#5b7c47';
      c.set(baseHex);

      if (t !== TERRAIN_ENUM.WATER && this.lensMode !== 'TACTICAL') {
        const nearest = findNearestSettlement(vx, vz);
        if (nearest && nearest.factionId) {
          if (this.lensMode === 'POLITICAL') {
            const facColor = new THREE.Color(state.factions[nearest.factionId]?.color || '#64748b');
            c.lerp(facColor, 0.58);
          } else if (this.lensMode === 'CONTROL_CLAN') {
            // 控制度热力图：绿 (100%) -> 黄 (75%) -> 红 (<50%)
            const ratio = Math.max(0, Math.min(1, (nearest.controlRate - 45) / 55));
            const heatColor = new THREE.Color().setHSL(ratio * 0.33, 0.85, 0.42);
            c.lerp(heatColor, 0.68);
          } else if (this.lensMode === 'POPS_REFUGEE') {
            const totalPops =
              nearest.pops.freePeasants +
              nearest.pops.clanRetainers +
              nearest.pops.artisans;
            const popRatio = Math.min(1, totalPops / 85000);
            const popColor = new THREE.Color().setHSL(0.55 - popRatio * 0.4, 0.8, 0.45);
            c.lerp(popColor, 0.55);
          } else if (this.lensMode === 'LOGISTICS') {
            if (t === TERRAIN_ENUM.ROAD || t === TERRAIN_ENUM.FORD) {
              c.set('#fbbf24'); // 高亮帝国官道与漕运网
            } else {
              c.lerp(new THREE.Color('#1e293b'), 0.55);
            }
          }
        }
      }

      colorAttr.setXYZ(i, c.r, c.g, c.b);
    }

    colorAttr.needsUpdate = true;
  }

  /**
   * 构建 12 座都市、6 座关港、大地图 Lv1~Lv3 内政建筑与野外军事设施
   */
  _rebuildSettlementsAndPlots(state) {
    this.settlementGroup.clear();
    this.plotGroup.clear();
    this.pickables = [this.terrainMesh];
    this.labelAnchors = [];

    // 1. 渲染据点 (都市 / 关隘 / 港口)
    for (const s of Object.values(state.settlements)) {
      const faction = s.factionId ? state.factions[s.factionId] : null;
      const facColor = faction ? faction.color : '#94a3b8';
      const isSelected = this.selectedSettlementId === s.id;

      const group = new THREE.Group();
      const tileH = state.map.elevation[s.y * state.map.width + s.x] ?? 0.28;
      group.position.set(s.x, tileH, s.y);

      if (s.type === 'MAJOR_CITY') {
        // 大都市：双层城垣 + 中央主殿
        const wallMesh = new THREE.Mesh(
          new THREE.BoxGeometry(1.55, 0.65, 1.55),
          new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.7 })
        );
        wallMesh.position.y = 0.32;
        wallMesh.castShadow = true;
        wallMesh.userData = { pickType: 'SETTLEMENT', id: s.id };
        this.pickables.push(wallMesh);
        group.add(wallMesh);

        const keepMesh = new THREE.Mesh(
          new THREE.ConeGeometry(0.92, 0.75, 4),
          new THREE.MeshStandardMaterial({ color: facColor, roughness: 0.45 })
        );
        keepMesh.rotation.y = Math.PI / 4;
        keepMesh.position.y = 0.95;
        group.add(keepMesh);
      } else if (s.type === 'PASS') {
        // 险要关隘 (虎牢关/潼关/壶关)：横跨隘口的雄关城楼
        const passMesh = new THREE.Mesh(
          new THREE.BoxGeometry(1.35, 0.85, 0.95),
          new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.6 })
        );
        passMesh.position.y = 0.42;
        passMesh.userData = { pickType: 'SETTLEMENT', id: s.id };
        this.pickables.push(passMesh);
        group.add(passMesh);

        const roof = new THREE.Mesh(
          new THREE.BoxGeometry(1.45, 0.25, 1.05),
          new THREE.MeshStandardMaterial({ color: facColor })
        );
        roof.position.y = 0.92;
        group.add(roof);
      } else {
        // 渡口军港 (官渡港/白马港/延津港)
        const dockMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.68, 0.78, 0.5, 6),
          new THREE.MeshStandardMaterial({ color: facColor, roughness: 0.5 })
        );
        dockMesh.position.y = 0.25;
        dockMesh.userData = { pickType: 'SETTLEMENT', id: s.id };
        this.pickables.push(dockMesh);
        group.add(dockMesh);
      }

      // 选中高亮光环
      if (isSelected) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(1.05, 1.32, 32),
          new THREE.MeshBasicMaterial({ color: '#fde047', side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.06;
        group.add(ring);
      }

      this.settlementGroup.add(group);

      this.labelAnchors.push({
        kind: 'SETTLEMENT',
        id: s.id,
        worldPos: new THREE.Vector3(s.x, tileH + 1.45, s.y),
        data: s,
        faction,
        isSelected,
      });

      // 2. 渲染该城下辖的大地图 Lv1~Lv3 内政建筑
      for (const plot of s.economicPlots || []) {
        const ph = state.map.elevation[plot.y * state.map.width + plot.x] ?? 0.26;
        const pGroup = new THREE.Group();
        pGroup.position.set(plot.x, ph, plot.y);

        const plotColors = {
          FARM: '#65a30d',
          MARKET: '#eab308',
          BARRACKS: '#ef4444',
          SMITHY: '#f97316',
          STABLE: '#a855f7',
          WORKSHOP: '#06b6d4',
        };
        const pColor = plotColors[plot.type] || '#94a3b8';
        const hScale = 0.18 + plot.level * 0.11;

        const baseBlock = new THREE.Mesh(
          new THREE.BoxGeometry(0.68, hScale, 0.68),
          new THREE.MeshStandardMaterial({ color: pColor, roughness: 0.6 })
        );
        baseBlock.position.y = hScale / 2;
        baseBlock.userData = { pickType: 'SETTLEMENT', id: s.id };
        this.pickables.push(baseBlock);
        pGroup.add(baseBlock);

        this.plotGroup.add(pGroup);

        this.labelAnchors.push({
          kind: 'PLOT',
          id: plot.id,
          worldPos: new THREE.Vector3(plot.x, ph + hScale + 0.35, plot.y),
          data: plot,
          def: ECONOMIC_BUILDING_DEFS[plot.type],
        });
      }
    }

    // 3. 渲染野外军事设施 (连弩橹 / 前哨阵)
    for (const fac of Object.values(state.facilities || {})) {
      if (fac.durability <= 0) continue;
      const fh = state.map.elevation[fac.y * state.map.width + fac.x] ?? 0.3;
      const fGroup = new THREE.Group();
      fGroup.position.set(fac.x, fh, fac.y);
      const facColor = state.factions[fac.factionId]?.color || '#cbd5e1';

      const towerMesh = new THREE.Mesh(
        new THREE.ConeGeometry(0.45, 0.85, 6),
        new THREE.MeshStandardMaterial({ color: facColor })
      );
      towerMesh.position.y = 0.42;
      fGroup.add(towerMesh);
      this.plotGroup.add(fGroup);

      this.labelAnchors.push({
        kind: 'FACILITY',
        id: fac.id,
        worldPos: new THREE.Vector3(fac.x, fh + 1.0, fac.y),
        data: fac,
      });
    }
  }

  /**
   * 渲染野外作战部队立体兵棋 (Wargame Token) 与动态行军路线箭头
   */
  _rebuildUnitsAndRoutes(state) {
    this.unitGroup.clear();
    this.routeGroup.clear();

    for (const u of Object.values(state.units)) {
      const faction = state.factions[u.factionId];
      const facColor = faction ? faction.color : '#3b82f6';
      const uh = state.map.elevation[u.y * state.map.width + u.x] ?? 0.3;
      const isSelected = this.selectedUnitId === u.id;

      const uGroup = new THREE.Group();
      uGroup.position.set(u.x, uh, u.y);

      // 立体八角战术兵牌底座
      const tokenMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.58, 0.65, 0.32, 8),
        new THREE.MeshStandardMaterial({
          color: facColor,
          roughness: 0.35,
          metalness: 0.25,
        })
      );
      tokenMesh.position.y = 0.22;
      tokenMesh.castShadow = true;
      tokenMesh.userData = { pickType: 'UNIT', id: u.id };
      this.pickables.push(tokenMesh);
      uGroup.add(tokenMesh);

      // 帅旗旗杆
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 1.05, 6),
        new THREE.MeshBasicMaterial({ color: '#fef08a' })
      );
      pole.position.set(0.25, 0.6, 0);
      uGroup.add(pole);

      if (isSelected) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.72, 0.92, 24),
          new THREE.MeshBasicMaterial({ color: '#38bdf8', side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.06;
        uGroup.add(ring);
      }

      this.unitGroup.add(uGroup);

      const cmdOfficer = state.officers[u.slots[0]?.officerId];
      const formDef = FORMATIONS[u.formationId] || FORMATIONS.FISH_SCALE;

      this.labelAnchors.push({
        kind: 'UNIT',
        id: u.id,
        worldPos: new THREE.Vector3(u.x, uh + 1.15, u.y),
        data: u,
        commanderName: cmdOfficer ? cmdOfficer.name : `部队#${u.id}`,
        formDef,
        faction,
        isSelected,
      });

      // 绘制部队行军路线箭头
      if (u.order?.path && u.order.path.length > 0) {
        const points = [new THREE.Vector3(u.x, uh + 0.18, u.y)];
        for (const [px, py] of u.order.path) {
          const ph = state.map.elevation[py * state.map.width + px] ?? 0.3;
          points.push(new THREE.Vector3(px, ph + 0.18, py));
        }
        const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
        const lineMat = new THREE.LineBasicMaterial({
          color: isSelected ? '#38bdf8' : facColor,
          linewidth: 2,
        });
        const line = new THREE.Line(lineGeom, lineMat);
        this.routeGroup.add(line);
      }
    }
  }

  /**
   * 渲染战略地图透镜专属 3D 辅助图层 (如 F4 四阶人口柱状图、F5 军需漕运网连接线)
   */
  _rebuildLensOverlays(state) {
    this.lensOverlayGroup.clear();
    if (!state) return;

    if (this.lensMode === 'POPS_REFUGEE') {
      // 在每座城市上方升起自耕农(绿) / 世家部曲(金) / 流民(红) 3D 柱状图
      for (const s of Object.values(state.settlements)) {
        const sh = state.map.elevation[s.y * state.map.width + s.x] ?? 0.3;
        const bars = [
          { val: s.pops.freePeasants, color: '#22c55e', dx: -0.45 },
          { val: s.pops.clanRetainers, color: '#eab308', dx: 0 },
          { val: s.pops.refugees, color: '#ef4444', dx: 0.45 },
        ];
        for (const b of bars) {
          const h = Math.max(0.25, (b.val / 15000) * 1.1);
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.32, h, 0.32),
            new THREE.MeshStandardMaterial({ color: b.color })
          );
          mesh.position.set(s.x + b.dx, sh + 1.1 + h / 2, s.y);
          this.lensOverlayGroup.add(mesh);
        }
      }
    } else if (this.lensMode === 'LOGISTICS') {
      // 绘制连通的军需漕运干线
      const drawn = new Set();
      for (const s of Object.values(state.settlements)) {
        for (const nId of s.connectedSettlementIds || []) {
          const key = s.id < nId ? `${s.id}-${nId}` : `${nId}-${s.id}`;
          if (drawn.has(key)) continue;
          drawn.add(key);
          const target = state.settlements[nId];
          if (!target) continue;
          const sameFaction = s.factionId && s.factionId === target.factionId;
          const p1 = new THREE.Vector3(s.x, 0.55, s.y);
          const p2 = new THREE.Vector3(target.x, 0.55, target.y);
          const geom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
          const mat = new THREE.LineBasicMaterial({
            color: sameFaction ? '#fbbf24' : '#475569',
          });
          this.lensOverlayGroup.add(new THREE.Line(geom, mat));
        }
      }
    }
  }

  /**
   * 计算所有 3D 锚点在当前屏幕上的 2D 像素坐标，供 React 浮层绘制清晰兵牌与城池标签
   */
  getProjectedLabels() {
    if (!this.container) return [];
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const result = [];

    for (const item of this.labelAnchors) {
      // 内政建筑仅在相机拉近 (distance <= 52) 时显示文字标签，保持远景清爽
      if (item.kind === 'PLOT' && this.distance > 52) continue;

      const v = item.worldPos.clone().project(this.camera);
      if (v.z > 1) continue; // 在相机背面
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-(v.y * 0.5) + 0.5) * height;
      if (x < -80 || x > width + 80 || y < -80 || y > height + 80) continue;

      result.push({
        ...item,
        screenX: Math.round(x),
        screenY: Math.round(y),
      });
    }
    return result;
  }

  _updateCameraTransform() {
    const horizDist = this.distance * Math.cos(this.pitch);
    const vertDist = this.distance * Math.sin(this.pitch);

    const cx = this.target.x + horizDist * Math.sin(this.yaw);
    const cz = this.target.z + horizDist * Math.cos(this.yaw);
    const cy = this.target.y + vertDist;

    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(this.target);
    this.callbacks.onCameraMove?.();
  }

  _bindEvents() {
    const dom = this.renderer.domElement;

    window.addEventListener('resize', () => {
      if (!this.container) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.callbacks.onCameraMove?.();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      this.keysPressed.add(k);
      if (k === 'q') this.rotateCamera(-0.22, 0);
      if (k === 'e') this.rotateCamera(0.22, 0);
      if (k === 'n') this.resetNorth();
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed.delete(e.key.toLowerCase());
    });

    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('mousedown', (e) => {
      this.isDragging = false;
      this.dragButton = e.button;
      this.downMouse = { x: e.clientX, y: e.clientY };
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.downMouse) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      if (Math.hypot(e.clientX - this.downMouse.x, e.clientY - this.downMouse.y) > 4) {
        this.isDragging = true;
      }

      if (this.isDragging) {
        if (this.dragButton === 2 || e.shiftKey) {
          // 右键拖拽或 Shift+左键：旋转与俯仰 "伪3D" 视角
          this.yaw -= dx * 0.0065;
          this.pitch = Math.max(0.52, Math.min(1.32, this.pitch + dy * 0.005));
          this._updateCameraTransform();
        } else if (this.dragButton === 0 || this.dragButton === 1) {
          // 左键或中键拖拽：沿当前相机朝向平移沙盘
          const panScale = this.distance * 0.0014;
          const forwardX = -Math.sin(this.yaw);
          const forwardZ = -Math.cos(this.yaw);
          const rightX = Math.cos(this.yaw);
          const rightZ = -Math.sin(this.yaw);

          this.target.x -= (rightX * dx - forwardX * dy) * panScale;
          this.target.z -= (rightZ * dx - forwardZ * dy) * panScale;
          this.target.x = Math.max(2, Math.min(62, this.target.x));
          this.target.z = Math.max(2, Math.min(42, this.target.z));
          this._updateCameraTransform();
        }
      }
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.downMouse) return;
      const wasDragging = this.isDragging;
      this.downMouse = null;
      this.isDragging = false;

      if (!wasDragging && e.target === dom) {
        this._handlePointerClick(e);
      }
    });

    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.distance = Math.max(16, Math.min(78, this.distance + e.deltaY * 0.035));
        this._updateCameraTransform();
      },
      { passive: false }
    );
  }

  _handlePointerClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    if (hits.length === 0) return;

    const hit = hits[0];
    const meta = hit.object.userData;

    if (e.button === 2) {
      // 右键点击地图：如果当前选中了己方部队，直接下达变更行军目标指令
      const gx = Math.round(hit.point.x);
      const gy = Math.round(hit.point.z);
      this.callbacks.onRightClickTile?.(gx, gy, meta);
      return;
    }

    if (meta.pickType === 'SETTLEMENT') {
      this.selectedSettlementId = meta.id;
      this.selectedUnitId = null;
      this.callbacks.onSelectSettlement?.(meta.id);
      if (this.state) this.syncState(this.state);
    } else if (meta.pickType === 'UNIT') {
      this.selectedUnitId = meta.id;
      this.callbacks.onSelectUnit?.(meta.id);
      if (this.state) this.syncState(this.state);
    } else if (meta.pickType === 'TERRAIN') {
      const gx = Math.round(hit.point.x);
      const gy = Math.round(hit.point.z);
      this.callbacks.onClickTile?.(gx, gy);
    }
  }

  _startLoop() {
    const animate = () => {
      this.animFrameId = requestAnimationFrame(animate);
      const dt = this.clock.getDelta();

      // WASD 键盘平滑平移
      if (this.keysPressed.size > 0) {
        const speed = this.distance * 0.55 * dt;
        const forwardX = -Math.sin(this.yaw);
        const forwardZ = -Math.cos(this.yaw);
        const rightX = Math.cos(this.yaw);
        const rightZ = -Math.sin(this.yaw);

        let moved = false;
        if (this.keysPressed.has('w') || this.keysPressed.has('arrowup')) {
          this.target.x += forwardX * speed;
          this.target.z += forwardZ * speed;
          moved = true;
        }
        if (this.keysPressed.has('s') || this.keysPressed.has('arrowdown')) {
          this.target.x -= forwardX * speed;
          this.target.z -= forwardZ * speed;
          moved = true;
        }
        if (this.keysPressed.has('a') || this.keysPressed.has('arrowleft')) {
          this.target.x -= rightX * speed;
          this.target.z -= rightZ * speed;
          moved = true;
        }
        if (this.keysPressed.has('d') || this.keysPressed.has('arrowright')) {
          this.target.x += rightX * speed;
          this.target.z += rightZ * speed;
          moved = true;
        }
        if (moved) {
          this.target.x = Math.max(2, Math.min(62, this.target.x));
          this.target.z = Math.max(2, Math.min(42, this.target.z));
          this._updateCameraTransform();
        }
      }

      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }
}
