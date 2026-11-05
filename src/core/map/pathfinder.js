/**
 * SPEC-01 & SPEC-03: 8方向带权 A* 寻路、流场 (Flow Field) 与敌对 ZOC 拦截计算器
 */

import { FORMATIONS, TERRAIN_DEFS, TERRAIN_ENUM } from '../../data/tacticsAndFormations.js';

const DIRS_8 = [
  [0, -1, 1.0],
  [1, -1, 1.414],
  [1, 0, 1.0],
  [1, 1, 1.414],
  [0, 1, 1.0],
  [-1, 1, 1.414],
  [-1, 0, 1.0],
  [-1, -1, 1.414],
];

/**
 * 计算单格移动代价
 */
export function getTileMoveCost(state, x, y, formationId = 'FISH_SCALE') {
  const { width, height, terrain } = state.map;
  if (x < 0 || x >= width || y < 0 || y >= height) return 999;

  const t = terrain[y * width + x];
  if (t === TERRAIN_ENUM.CLIFF) return 999;

  const def = TERRAIN_DEFS[t] || TERRAIN_DEFS[TERRAIN_ENUM.PLAIN];
  const form = FORMATIONS[formationId] || FORMATIONS.FISH_SCALE;

  if (t === TERRAIN_ENUM.MOUNTAIN && form.ignoreMountainPenalty) {
    return 1.0;
  }

  const cat =
    form.category === 'CAVALRY'
      ? 'CAVALRY'
      : form.category === 'SIEGE'
      ? 'SIEGE'
      : 'INFANTRY';

  return def.moveCost[cat] ?? 1.0;
}

/**
 * 判定坐标 (x, y) 是否处于敌方据点或敌方部队的 ZOC 控制区内 (SPEC-01 2.2)
 */
export function isInEnemyZOC(state, x, y, factionId, hasFlyingGeneral = false) {
  if (hasFlyingGeneral) return false; // 吕布/关羽【飞将】无视陆地 ZOC

  for (const s of Object.values(state.settlements)) {
    if (s.factionId && s.factionId !== factionId && s.troops > 0) {
      const dist = Math.max(Math.abs(s.x - x), Math.abs(s.y - y));
      if (dist <= 1) return true;
    }
  }

  for (const u of Object.values(state.units)) {
    if (u.factionId !== factionId && u.troops > 0) {
      const dist = Math.max(Math.abs(u.x - x), Math.abs(u.y - y));
      if (dist <= 1) return true;
    }
  }

  for (const f of Object.values(state.facilities || {})) {
    if (f.factionId !== factionId && f.durability > 0) {
      const dist = Math.max(Math.abs(f.x - x), Math.abs(f.y - y));
      if (dist <= 1) return true;
    }
  }

  return false;
}

/**
 * 8方向 A* 寻路，返回从 (startX, startY) 到 (goalX, goalY) 的坐标序列 [[x1,y1], ...]
 */
export function findPathAStar(state, startX, startY, goalX, goalY, formationId = 'FISH_SCALE', maxSteps = 1200) {
  const { width, height } = state.map;
  if (startX === goalX && startY === goalY) return [];

  const toKey = (x, y) => y * width + x;
  const startKey = toKey(startX, startY);
  const goalKey = toKey(goalX, goalY);

  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const closed = new Set();

  // 简易优先队列
  const open = [{ x: startX, y: startY, key: startKey, f: Math.hypot(goalX - startX, goalY - startY) }];

  let steps = 0;
  let bestNode = { x: startX, y: startY, key: startKey, dist: Math.hypot(goalX - startX, goalY - startY) };

  while (open.length > 0 && steps++ < maxSteps) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift();
    if (!current) break;

    if (current.key === goalKey) {
      return reconstructPath(cameFrom, current.key, width);
    }

    closed.add(current.key);

    for (const [dx, dy, diagMult] of DIRS_8) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

      const nKey = toKey(nx, ny);
      if (closed.has(nKey)) continue;

      const tileCost = getTileMoveCost(state, nx, ny, formationId);
      if (tileCost >= 99 && nKey !== goalKey) continue;

      const tentativeG = (gScore.get(current.key) ?? 0) + tileCost * diagMult;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, current.key);
        gScore.set(nKey, tentativeG);
        const h = Math.hypot(goalX - nx, goalY - ny) * 0.75;
        open.push({ x: nx, y: ny, key: nKey, f: tentativeG + h });

        const dGoal = Math.hypot(goalX - nx, goalY - ny);
        if (dGoal < bestNode.dist) {
          bestNode = { x: nx, y: ny, key: nKey, dist: dGoal };
        }
      }
    }
  }

  return reconstructPath(cameFrom, bestNode.key, width);
}

function reconstructPath(cameFrom, currentKey, width) {
  const path = [];
  let curr = currentKey;
  while (cameFrom.has(curr)) {
    const x = curr % width;
    const y = Math.floor(curr / width);
    path.unshift([x, y]);
    curr = cameFrom.get(curr);
  }
  return path;
}
