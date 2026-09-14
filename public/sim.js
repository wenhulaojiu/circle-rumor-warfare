/**
 * 力导向布局。
 *
 * 单独成文件是为了能在 Node 里直接跑数值验证（见 tools/check-layout.js），
 * 不用开浏览器靠肉眼判断有没有节点重叠、簇心有没有跑偏。
 *
 * 模拟在**像素空间**运行：节点半径、边的自然长度都直接以像素为单位，
 * 这样碰撞判定不需要在两套坐标系之间换算。归一化坐标只在初始化时用一次。
 *
 * ── 积分方式说明（踩过的坑）──────────────────────────────────────
 * 一开始把力直接当成"位置增量 × alpha"，alpha 衰减到接近 0 时**所有**力一起冻结，
 * 包括把节点拉回圈层的回复力。结果布局冻在一个力根本没平衡的位置上：
 * 簇心偏移 210px 而圈半径只有 170px，节点重叠、跑出画布。
 *
 * 正确做法是标准的带阻尼速度积分（d3-force 同款）：力先累加成加速度，
 * 速度每帧乘一个阻尼系数，再由速度推动位置。阻尼会让系统收敛到**力平衡点**，
 * 而不是收敛到"步长足够小"的任意点。静置阶段 alpha 恒为 1，
 * 收敛完全交给阻尼完成。
 *
 * 四种力：
 *   斥力      —— 所有节点两两相斥，避免糊成一团
 *   碰撞力    —— 距离小于两半径之和时强制推开，保证节点圆不重叠
 *   弹簧力    —— 沿边把相连节点拉到自然长度，圈内短、跨圈长
 *   向心力    —— 把节点拉回所属圈层的圆心，形成四个簇
 *   圈层约束  —— 超出圈半径后被拉回来，防止斥力把整个簇顶散
 */

export const NODE_RADIUS = (influence) => 6 + influence * 1.6;

// ---- 力的大小（都是"加速度"量纲）----
const REPULSION = 1500;      // 斥力系数，除以距离平方
const REPULSION_CAP = 42;    // 单节点受力上限，防止极近距离时炸开
const COLLISION_K = 0.55;    // 碰撞推开强度
const COLLISION_PASSES = 3;  // 每帧碰撞解算三遍，一遍压不干净密集区的重叠
const CENTER_K = 0.022;      // 向心力强度
const RING_K = 0.055;        // 圈层边界软约束强度
const RING_LIMIT = 0.78;     // 节点距圈心的软上限（占圈半径的比例）

// ---- 积分参数 ----
const VELOCITY_DECAY = 0.62; // 速度阻尼，越小收敛越快、越不容易震荡
const MAX_VELOCITY = 6;      // 单帧位移上限，兜底防止数值爆炸
const ALPHA_MIN = 0.02;

/**
 * 布局区域占视口的比例。
 * 四个圈层圆心在 0.28/0.72、半径 0.29，归一化后张成 [-0.01, 1.01] 略大于单位正方形，
 * 再算上节点半径，取 0.86 才能在四周留出安全边距，不让节点贴边或被裁掉。
 */
const VIEW_SCALE = 0.86;

/** 各类边的自然长度与弹簧刚度：圈内紧、桥接中、跨圈松 */
const LINK = {
  intra:  { rest: 54, k: 0.09 },
  bridge: { rest: 72, k: 0.06 },
  cross:  { rest: 150, k: 0.02 },
};

export class ForceSim {
  constructor(nodes, edges, circles, circleRadius) {
    this.nodes = nodes;
    this.edges = edges;
    this.circles = circles;
    this.circleRadius = circleRadius;
    this.nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
    this.alpha = 1;
    this._initialized = false;
    for (const n of nodes) {
      n.r = NODE_RADIUS(n.influence);
      n.px = 0;
      n.py = 0;
      n.vx = 0;
      n.vy = 0;
    }
  }

  /** 归一化坐标 → 像素坐标的映射：取一个居中的正方形区域，保证四个圈层不被拉扁 */
  transform(W, H) {
    const S = Math.min(W, H) * VIEW_SCALE;
    const ox = (W - S) / 2;
    const oy = (H - S) / 2;
    return {
      S,
      ox,
      oy,
      toPx: (n) => ({ x: ox + n.x * S, y: oy + n.y * S }),
      circleCenter: (id) => {
        const c = this.circles.find((k) => k.id === id);
        return { x: ox + c.cx * S, y: oy + c.cy * S };
      },
      radiusPx: this.circleRadius * S,
    };
  }

  ensureInit(W, H) {
    if (this._initialized) return;
    const t = this.transform(W, H);
    for (const n of this.nodes) {
      const p = t.toPx(n);
      n.px = p.x;
      n.py = p.y;
    }
    this._initialized = true;
  }

  /** 推进一帧：累加受力 → 阻尼积分 → 更新位置 */
  tick(W, H) {
    this.ensureInit(W, H);
    const t = this.transform(W, H);
    const nodes = this.nodes;
    const nodeById = this.nodeById;

    // ---- 0. 清零受力 ----
    for (const n of nodes) {
      n.fx = 0;
      n.fy = 0;
    }

    // ---- 1. 斥力 + 碰撞（跑多遍，单遍压不干净密集区的重叠）----
    for (let pass = 0; pass < COLLISION_PASSES; pass++) {
      for (let i = 0; i < nodes.length; i++) {
        const A = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const B = nodes[j];
          let dx = B.px - A.px;
          let dy = B.py - A.py;
          let d2 = dx * dx + dy * dy;

          // 完全重合时给一个确定性的小扰动，不要用随机数，否则布局每次都不一样
          if (d2 < 0.01) {
            const ang = ((i * 31 + j * 17) % 360) * (Math.PI / 180);
            dx = Math.cos(ang);
            dy = Math.sin(ang);
            d2 = 1;
          }

          const d = Math.sqrt(d2);
          const minD = A.r + B.r + 4;
          let mag;
          if (d < minD) {
            mag = (minD - d) * COLLISION_K;
          } else {
            mag = Math.min(REPULSION / d2, REPULSION_CAP);
          }

          const ux = dx / d;
          const uy = dy / d;
          A.fx -= ux * mag;
          A.fy -= uy * mag;
          B.fx += ux * mag;
          B.fy += uy * mag;
        }
      }
    }

    // ---- 2. 弹簧力（沿边） ----
    for (const e of this.edges) {
      const A = nodeById[e.source];
      const B = nodeById[e.target];
      if (!A || !B) continue;
      const spec = LINK[e.type] || LINK.intra;
      const dx = B.px - A.px;
      const dy = B.py - A.py;
      const d = Math.hypot(dx, dy) || 0.01;
      const mag = (d - spec.rest) * spec.k;
      const ux = dx / d;
      const uy = dy / d;
      A.fx += ux * mag;
      A.fy += uy * mag;
      B.fx -= ux * mag;
      B.fy -= uy * mag;
    }

    // ---- 3. 向心力 + 圈层边界软约束 ----
    // 桥接节点属于两个圈层，取两圆心的中点，半径上限放宽 —— 它们本来就住在交集区。
    const ringLimit = t.radiusPx * RING_LIMIT;
    for (const n of nodes) {
      const centers = n.circles.map((c) => t.circleCenter(c));
      const cx = centers.reduce((s, c) => s + c.x, 0) / centers.length;
      const cy = centers.reduce((s, c) => s + c.y, 0) / centers.length;

      n.fx += (cx - n.px) * CENTER_K;
      n.fy += (cy - n.py) * CENTER_K;

      const dx = n.px - cx;
      const dy = n.py - cy;
      const d = Math.hypot(dx, dy) || 0.01;
      const limit = n.circles.length > 1 ? ringLimit * 1.4 : ringLimit;
      if (d > limit) {
        const mag = (d - limit) * RING_K;
        n.fx -= (dx / d) * mag;
        n.fy -= (dy / d) * mag;
      }
    }

    // ---- 4. 阻尼积分 ----
    const pad = 8;
    const lo = t.ox + pad;
    const hi = t.ox + t.S - pad;
    const loY = t.oy + pad;
    const hiY = t.oy + t.S - pad;

    for (const n of nodes) {
      n.vx = clampMag((n.vx + n.fx * this.alpha) * VELOCITY_DECAY, MAX_VELOCITY);
      n.vy = clampMag((n.vy + n.fy * this.alpha) * VELOCITY_DECAY, MAX_VELOCITY);
      n.px += n.vx;
      n.py += n.vy;

      // 边界硬约束：撞墙时把法向速度也吃掉，否则会贴着墙持续抖动
      const minX = lo + n.r;
      const maxX = hi - n.r;
      const minY = loY + n.r;
      const maxY = hiY - n.r;
      if (n.px < minX) { n.px = minX; n.vx = 0; }
      if (n.px > maxX) { n.px = maxX; n.vx = 0; }
      if (n.py < minY) { n.py = minY; n.vy = 0; }
      if (n.py > maxY) { n.py = maxY; n.vy = 0; }
    }
  }

  /**
   * 静置到力平衡。
   * 收敛靠速度阻尼完成，所以 alpha 全程保持 1 —— 衰减 alpha 会让布局
   * 冻在"步长足够小"的位置，而不是"合力为零"的位置。
   */
  settle(W, H, iterations = 500) {
    this.alpha = 1;
    for (let i = 0; i < iterations; i++) this.tick(W, H);
    // 静置结束后留一点温度：窗口尺寸变化时布局能自己重新舒展，而不是硬邦邦地弹开
    for (const n of this.nodes) {
      n.vx = 0;
      n.vy = 0;
    }
    this.alpha = ALPHA_MIN;
    return this;
  }

  /** 布局质量自检：最小间距余量、各簇到圆心的平均偏移 */
  audit(W, H) {
    const t = this.transform(W, H);
    let minGap = Infinity;
    let worstPair = null;
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const A = this.nodes[i];
        const B = this.nodes[j];
        const gap = Math.hypot(B.px - A.px, B.py - A.py) - (A.r + B.r);
        if (gap < minGap) {
          minGap = gap;
          worstPair = [A.id, B.id];
        }
      }
    }
    const drift = {};
    for (const c of this.circles) {
      const cc = t.circleCenter(c.id);
      const members = this.nodes.filter((n) => n.primaryCircle === c.id);
      const avg =
        members.reduce((s, n) => s + Math.hypot(n.px - cc.x, n.py - cc.y), 0) /
        (members.length || 1);
      drift[c.id] = Math.round(avg);
    }
    return {
      minGap: Math.round(minGap * 10) / 10,
      worstPair,
      clusterDriftPx: drift,
      circleRadiusPx: Math.round(t.radiusPx),
      overlaps: minGap < 0,
    };
  }
}

function clampMag(v, max) {
  return v > max ? max : v < -max ? -max : v;
}
