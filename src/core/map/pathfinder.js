/**
 * SPEC-01 (v1.1): 尖顶六边形蜂窝网格 (Pointy-Top Odd-R Hex Grid) 几何计算、
 * 6方向等距 A* 寻路与敌对六边形 ZOC 控制区计算器
 */

import { FORMATIONS, TERRAIN_DEFS, TERRAIN_ENUM } from '../../data/tacticsAndFormations.js';

/**
 * Odd-R 偏移坐标 (x, y) 转轴向坐标 (q, r)
 */
export function offsetToAxial(x, y) {
  const q = x - ((y - (y & 1)) >> 1);
  const r = y;
  return { q, r };
}

/**
 * 计算两个六边形格子之间的精确六边形步数距离 (Hex Distance)
 * 相邻 6 个方向的格距恒为 1
 */
export function getHexDistance(x1, y1, x2, y2) {
  const a = offsetToAxial(x1, y1);
  const b = offsetToAxial(x2, y2);
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/**
 * 获取 (x, y) 在 Pointy-Top Odd-R 六边形网格中的 6 个共边相邻格
 * 所有 6 个方向的移动基础距离恒为 1.0 (完美等距!)
 */
export function getHexNeighbors(x, y, width, height) {
  const isOddRow = (y & 1) === 1;
  const offsets = isOddRow
    ? [
        [+1, 0],  // 东 (E)
        [+1, -1], // 东北 (NE)
        [0, -1],  // 西北 (NW)
        [-1, 0],  // 西 (W)
        [0, +1],  // 西南 (SW)
        [+1, +1], // 东南 (SE)
      ]
    : [
        [+1, 0],  // 东 (E)
        [0, -1],  // 东北 (NE)
        [-1, -1], // 西北 (NW)
        [-1, 0],  // 西 (W)
        [-1, +1], // 西南 (SW)
        [0, +1],  // 东南 (SE)
      ];

  const neighbors = [];
  for (const [dx, dy] of offsets) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
      neighbors.push([nx, ny]);
    }
  }
  return neighbors;
}

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
 * 判定六边形坐标 (x, y) 是否处于敌方据点或敌方部队的 6 邻格 ZOC 控制区内
 */
export function isInEnemyZOC(state, x, y, factionId, hasFlyingGeneral = false) {
  if (hasFlyingGeneral) return false; // 【飞将】无视陆地 ZOC

  for (const s of Object.values(state.settlements)) {
    if (s.factionId && s.factionId !== factionId && s.troops > 0) {
      if (getHexDistance(s.x, s.y, x, y) <= 1) return true;
    }
  }

  for (const u of Object.values(state.units)) {
    if (u.factionId !== factionId && u.troops > 0) {
      if (getHexDistance(u.x, u.y, x, y) <= 1) return true;
    }
  }

  for (const f of Object.values(state.facilities || {})) {
    if (f.factionId !== factionId && f.durability > 0) {
      if (getHexDistance(f.x, f.y, x, y) <= 1) return true;
    }
  }

  return false;
}

/**
 * 6方向等距六边形 A* 寻路，返回从 (startX, startY) 到 (goalX, goalY) 的六边形坐标序列 [[x1,y1], ...]
 */
export function findPathAStar(state, startX, startY, goalX, goalY, formationId = 'FISH_SCALE', maxSteps = 1400) {
  const { width, height } = state.map;
  if (startX === goalX && startY === goalY) return [];

  const toKey = (x, y) => y * width + x;
  const startKey = toKey(startX, startY);
  const goalKey = toKey(goalX, goalY);

  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const closed = new Set();

  const startDist = getHexDistance(startX, startY, goalX, goalY);
  const open = [{ x: startX, y: startY, key: startKey, f: startDist }];

  let steps = 0;
  let bestNode = { x: startX, y: startY, key: startKey, dist: startDist };

  while (open.length > 0 && steps++ < maxSteps) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift();
    if (!current) break;

    if (current.key === goalKey) {
      return reconstructPath(cameFrom, current.key, width);
    }

    closed.add(current.key);

    const neighbors = getHexNeighbors(current.x, current.y, width, height);
    for (const [nx, ny] of neighbors) {
      const nKey = toKey(nx, ny);
      if (closed.has(nKey)) continue;

      const tileCost = getTileMoveCost(state, nx, ny, formationId);
      if (tileCost >= 99 && nKey !== goalKey) continue;

      // 六边形相邻 6 方向基础距离恒为 1.0
      const tentativeG = (gScore.get(current.key) ?? 0) + tileCost;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, current.key);
        gScore.set(nKey, tentativeG);
        const h = getHexDistance(nx, ny, goalX, goalY) * 0.72;
        open.push({ x: nx, y: ny, key: nKey, f: tentativeG + h });

        const dGoal = getHexDistance(nx, ny, goalX, goalY);
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
