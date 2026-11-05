/**
 * SPEC-00: 确定性伪随机数生成器 (Mulberry32) 与核心数学辅助工具
 * 给定相同的 Seed，在任意平台上产生 100% 相同的推演序列。
 */

export class SeededPRNG {
  /** @param {number} seed */
  constructor(seed = 1900101) {
    this.state = seed >>> 0;
  }

  /** 返回 [0, 1) 之间的确定性浮点数 */
  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 返回 [min, max] 之间的随机浮点数 */
  rangeFloat(min, max) {
    return min + this.next() * (max - min);
  }

  /** 返回 [min, max] 之间的随机整数 (闭区间) */
  rangeInt(min, max) {
    return Math.floor(min + this.next() * (max - min + 1));
  }

  /** 以概率 p (0 ~ 1) 返回 true */
  chance(p) {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }
}

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 计算《三国志9》1~150 环形相性距离 (SPEC-01 4.2)
 * @param {number} a
 * @param {number} b
 */
export function getCompatibilityDistance(a, b) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 150 - diff);
}

/**
 * 格式化旬期文字，如 "194年 3月 上旬 (第4日)"
 */
export function formatGameDate(date, includeDay = false) {
  const xunNames = ['上旬', '中旬', '下旬'];
  const base = `${date.year}年 ${date.month}月 ${xunNames[date.xun] || '上旬'}`;
  return includeDay ? `${base} · 第${date.dayInXun}日` : base;
}
