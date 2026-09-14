/**
 * 确定性伪随机数发生器。
 *
 * 同一局游戏的种子必须能完整复现整张关系网 —— 服务端结算与前端布局都依赖
 * 节点的影响力、抗性等属性，两边必须完全一致，所以不能用 Math.random()。
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** [min, max] 闭区间浮点数 */
  rng.range = (min, max) => min + rng() * (max - min);
  /** [min, max] 闭区间整数 */
  rng.int = (min, max) => Math.floor(min + rng() * (max - min + 1));
  /** 从数组里等概率取一个 */
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  /** 按权重取一个，entries: [[值, 权重], ...] */
  rng.weighted = (entries) => {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = rng() * total;
    for (const [value, w] of entries) {
      r -= w;
      if (r <= 0) return value;
    }
    return entries[entries.length - 1][0];
  };
  return rng;
}

/** 字符串 -> 32 位整数种子，便于用房间号/主题名当种子 */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
