/**
 * 四圈层交叉社交关系网的生成。
 *
 * 几何设计（决定"部分交集、部分独立"这条需求）：
 *   四个圈层圆心摆成正方形四角，半径 0.29 ——
 *     相邻圆心距 0.44 < 2r = 0.58  →  相邻两圈重叠，形成交集区（桥接节点住在这里）
 *     对角圆心距 0.65 > 2r = 0.58  →  对角两圈完全独立，没有交集区
 *   所以兴趣圈↔职场圈、家长圈↔校园圈之间没有天然通路，必须靠"破圈投放"或
 *   少量低权重的跨圈边才能触及 —— 这正是破圈战术的价值来源。
 *
 *   布局（归一化坐标）：
 *     兴趣圈(0.28,0.26) ── 家长圈(0.72,0.26)
 *          │                      │
 *     校园圈(0.28,0.74) ── 职场圈(0.72,0.74)
 */

import { makeRng } from './rng.js';

export const CIRCLES = [
  { id: 'interest', name: '兴趣圈', cx: 0.28, cy: 0.26, desc: '饭圈 / 游戏 / 动漫同好' },
  { id: 'parent', name: '家长圈', cx: 0.72, cy: 0.26, desc: '家长群 / 家委会 / 育儿社区' },
  { id: 'workplace', name: '职场圈', cx: 0.72, cy: 0.74, desc: '同事群 / 行业交流群' },
  { id: 'campus', name: '校园圈', cx: 0.28, cy: 0.74, desc: '班级群 / 社团 / 师生' },
];

export const CIRCLE_RADIUS = 0.29;

/** 相邻圈层对（有交集区，可放桥接节点） */
const ADJACENT_PAIRS = [
  ['interest', 'parent'],
  ['parent', 'workplace'],
  ['workplace', 'campus'],
  ['campus', 'interest'],
];

export const CIRCLE_MAP = Object.fromEntries(CIRCLES.map((c) => [c.id, c]));

/** 每个圈层的人员名册：名字 + 身份标签 + 属性倾向 */
const ROSTERS = {
  interest: [
    { name: '超话主持人', tag: '意见领袖', inf: [8, 10], skp: [0.15, 0.4], cnf: [0.6, 0.9], aut: [0.3, 0.55], fear: [0.5, 0.75] },
    { name: '同人大手', tag: '内容生产者', inf: [6, 8], skp: [0.2, 0.45], cnf: [0.4, 0.7], aut: [0.25, 0.5], fear: [0.45, 0.7] },
    { name: '游戏区UP主', tag: '意见领袖', inf: [7, 9], skp: [0.3, 0.55], cnf: [0.35, 0.65], aut: [0.35, 0.6], fear: [0.4, 0.65] },
    { name: '站姐', tag: '传播节点', inf: [4, 6], skp: [0.2, 0.4], cnf: [0.65, 0.9], aut: [0.3, 0.5], fear: [0.5, 0.75] },
    { name: '资源组组长', tag: '工具人', inf: [3, 5], skp: [0.3, 0.5], cnf: [0.5, 0.75], aut: [0.4, 0.6], fear: [0.35, 0.6] },
    { name: '周边团长', tag: '组织者', inf: [4, 6], skp: [0.35, 0.55], cnf: [0.45, 0.7], aut: [0.4, 0.65], fear: [0.4, 0.6] },
    { name: '剪辑太太', tag: '内容生产者', inf: [5, 7], skp: [0.25, 0.5], cnf: [0.45, 0.7], aut: [0.3, 0.55], fear: [0.5, 0.75] },
    { name: '考据党', tag: '质疑者', inf: [5, 7], skp: [0.7, 0.9], cnf: [0.15, 0.35], aut: [0.55, 0.8], fear: [0.15, 0.35] },
    { name: '二创画手', tag: '潜伏者', inf: [2, 4], skp: [0.3, 0.55], cnf: [0.35, 0.6], aut: [0.3, 0.5], fear: [0.4, 0.65] },
    { name: '资讯搬运工', tag: '传播节点', inf: [4, 6], skp: [0.15, 0.35], cnf: [0.6, 0.85], aut: [0.35, 0.55], fear: [0.55, 0.8] },
    { name: '潜水路人粉', tag: '沉默大多数', inf: [1, 2], skp: [0.25, 0.5], cnf: [0.7, 0.95], aut: [0.4, 0.65], fear: [0.5, 0.8] },
  ],
  parent: [
    { name: '家委会主任', tag: '意见领袖', inf: [8, 10], skp: [0.2, 0.4], cnf: [0.5, 0.8], aut: [0.6, 0.85], fear: [0.65, 0.9] },
    { name: '鸡娃妈妈', tag: '高焦虑', inf: [6, 8], skp: [0.15, 0.35], cnf: [0.65, 0.9], aut: [0.6, 0.85], fear: [0.75, 0.95] },
    { name: '二孩爸', tag: '被动接收', inf: [3, 5], skp: [0.35, 0.55], cnf: [0.4, 0.65], aut: [0.5, 0.75], fear: [0.45, 0.7] },
    { name: '奥数群群主', tag: '组织者', inf: [6, 8], skp: [0.25, 0.45], cnf: [0.5, 0.75], aut: [0.55, 0.8], fear: [0.6, 0.85] },
    { name: '幼升小家长', tag: '高焦虑', inf: [4, 6], skp: [0.15, 0.35], cnf: [0.7, 0.95], aut: [0.6, 0.85], fear: [0.75, 0.95] },
    { name: '全职妈妈', tag: '传播节点', inf: [5, 7], skp: [0.2, 0.4], cnf: [0.6, 0.85], aut: [0.55, 0.8], fear: [0.7, 0.9] },
    { name: '学区房研究员', tag: '信息贩子', inf: [6, 8], skp: [0.4, 0.6], cnf: [0.35, 0.6], aut: [0.4, 0.65], fear: [0.55, 0.8] },
    { name: '留学中介顾问', tag: '信息贩子', inf: [5, 7], skp: [0.45, 0.65], cnf: [0.3, 0.55], aut: [0.35, 0.6], fear: [0.5, 0.75] },
    { name: '辅食达人', tag: '内容生产者', inf: [5, 7], skp: [0.2, 0.4], cnf: [0.55, 0.8], aut: [0.5, 0.75], fear: [0.7, 0.9] },
    { name: '沉默的爸爸', tag: '沉默大多数', inf: [1, 2], skp: [0.4, 0.65], cnf: [0.35, 0.6], aut: [0.45, 0.7], fear: [0.35, 0.6] },
    { name: '退休返聘奶奶', tag: '传播节点', inf: [4, 6], skp: [0.1, 0.3], cnf: [0.65, 0.9], aut: [0.7, 0.95], fear: [0.8, 0.95] },
  ],
  workplace: [
    { name: '部门主管', tag: '意见领袖', inf: [8, 10], skp: [0.45, 0.65], cnf: [0.35, 0.6], aut: [0.5, 0.75], fear: [0.4, 0.6] },
    { name: 'HRBP', tag: '信息枢纽', inf: [7, 9], skp: [0.5, 0.7], cnf: [0.4, 0.65], aut: [0.55, 0.8], fear: [0.5, 0.7] },
    { name: '技术大牛', tag: '质疑者', inf: [6, 8], skp: [0.7, 0.9], cnf: [0.15, 0.35], aut: [0.4, 0.65], fear: [0.15, 0.35] },
    { name: '实习生', tag: '高焦虑', inf: [2, 4], skp: [0.25, 0.45], cnf: [0.7, 0.95], aut: [0.6, 0.85], fear: [0.75, 0.95] },
    { name: '行业群群主', tag: '组织者', inf: [6, 8], skp: [0.35, 0.55], cnf: [0.45, 0.7], aut: [0.45, 0.7], fear: [0.5, 0.75] },
    { name: '刚离职的前同事', tag: '信息贩子', inf: [4, 6], skp: [0.3, 0.5], cnf: [0.5, 0.75], aut: [0.3, 0.5], fear: [0.6, 0.85] },
    { name: '猎头顾问', tag: '信息贩子', inf: [5, 7], skp: [0.4, 0.6], cnf: [0.35, 0.6], aut: [0.35, 0.55], fear: [0.5, 0.75] },
    { name: '35岁中层', tag: '高焦虑', inf: [5, 7], skp: [0.3, 0.5], cnf: [0.45, 0.7], aut: [0.5, 0.75], fear: [0.8, 0.95] },
    { name: '外包同事', tag: '沉默大多数', inf: [1, 3], skp: [0.35, 0.55], cnf: [0.55, 0.8], aut: [0.5, 0.75], fear: [0.6, 0.85] },
    { name: '创业合伙人', tag: '潜伏者', inf: [6, 8], skp: [0.55, 0.75], cnf: [0.25, 0.5], aut: [0.35, 0.6], fear: [0.35, 0.6] },
    { name: '茶水间常客', tag: '传播节点', inf: [3, 5], skp: [0.2, 0.4], cnf: [0.65, 0.9], aut: [0.4, 0.65], fear: [0.6, 0.85] },
  ],
  campus: [
    { name: '学生会主席', tag: '意见领袖', inf: [8, 10], skp: [0.25, 0.45], cnf: [0.55, 0.8], aut: [0.6, 0.85], fear: [0.5, 0.75] },
    { name: '班长', tag: '组织者', inf: [6, 8], skp: [0.3, 0.5], cnf: [0.5, 0.75], aut: [0.65, 0.9], fear: [0.5, 0.75] },
    { name: '社团团长', tag: '组织者', inf: [5, 7], skp: [0.3, 0.5], cnf: [0.5, 0.75], aut: [0.45, 0.7], fear: [0.5, 0.7] },
    { name: '年级第一', tag: '质疑者', inf: [5, 7], skp: [0.6, 0.8], cnf: [0.2, 0.45], aut: [0.6, 0.85], fear: [0.25, 0.5] },
    { name: '辅导员', tag: '权威角色', inf: [7, 9], skp: [0.45, 0.65], cnf: [0.3, 0.55], aut: [0.75, 0.95], fear: [0.35, 0.6] },
    { name: '宿管阿姨', tag: '传播节点', inf: [3, 5], skp: [0.15, 0.35], cnf: [0.7, 0.95], aut: [0.55, 0.8], fear: [0.7, 0.9] },
    { name: '考研党', tag: '高焦虑', inf: [4, 6], skp: [0.35, 0.55], cnf: [0.5, 0.75], aut: [0.55, 0.8], fear: [0.7, 0.9] },
    { name: '校媒记者', tag: '信息枢纽', inf: [5, 7], skp: [0.5, 0.7], cnf: [0.35, 0.6], aut: [0.45, 0.7], fear: [0.35, 0.6] },
    { name: '转专业边缘人', tag: '潜伏者', inf: [1, 3], skp: [0.4, 0.6], cnf: [0.4, 0.65], aut: [0.4, 0.65], fear: [0.45, 0.7] },
    { name: '实验室师兄', tag: '权威角色', inf: [5, 7], skp: [0.55, 0.75], cnf: [0.25, 0.5], aut: [0.65, 0.85], fear: [0.3, 0.55] },
    { name: '隔壁班吃瓜群众', tag: '沉默大多数', inf: [1, 2], skp: [0.2, 0.4], cnf: [0.75, 0.95], aut: [0.5, 0.75], fear: [0.6, 0.85] },
  ],
};

const BRIDGE_ROSTER = [
  { name: '跨圈活跃分子', tag: '桥接节点' },
  { name: '两头都混的老熟人', tag: '桥接节点' },
];

const TRAIT_POOL = {
  interest: ['追热点', '护短', '玩梗', '反感说教', '吃瓜第一线'],
  parent: ['护犊子', '怕孩子吃亏', '信熟人转发', '看权威表态', '怕错过消息'],
  workplace: ['怕被优化', '看风向站队', '不信官方口径', '爱传小道消息', '观望'],
  campus: ['怕影响前途', '跟风表态', '信老师的话', '爱在群里转', '怕被孤立'],
};

/**
 * 生成整张关系网。
 * @param {string} seedStr 任意字符串种子（同一 seed 必定生成同一张网）
 */
export function buildNetwork(seedStr, topic) {
  const rng = makeRng(hashStr(seedStr));
  const nodes = [];
  const edges = [];
  const byCircle = { interest: [], parent: [], workplace: [], campus: [] };

  // ---- 1. 各圈层的专属节点 ----
  for (const circle of CIRCLES) {
    const roster = ROSTERS[circle.id];
    roster.forEach((r, i) => {
      const angle = (i / roster.length) * Math.PI * 2 + rng.range(-0.15, 0.15);
      // 按影响力决定离圈心的距离：影响力越大越靠中心，视觉上自然形成"核心-边缘"
      const inf = rng.int(r.inf[0], r.inf[1]);
      const dist = (1 - (inf - 1) / 9) * CIRCLE_RADIUS * 0.78 + rng.range(0.01, 0.05);
      const node = {
        id: `n${nodes.length}`,
        name: r.name,
        tag: r.tag,
        circles: [circle.id],
        primaryCircle: circle.id,
        influence: inf,
        skepticism: round2(rng.range(r.skp[0], r.skp[1])),
        conformity: round2(rng.range(r.cnf[0], r.cnf[1])),
        authorityTrust: round2(rng.range(r.aut[0], r.aut[1])),
        fearSensitivity: round2(rng.range(r.fear[0], r.fear[1])),
        traits: pickTraits(rng, circle.id, 2),
        x: circle.cx + Math.cos(angle) * dist,
        y: circle.cy + Math.sin(angle) * dist,
        state: 'gray',
        belief: 0,
        touched: false,
        immune: false,
        retention: 0,
        lastTactic: null,
        lastDelta: 0,
      };
      nodes.push(node);
      byCircle[circle.id].push(node);
    });
  }

  // ---- 2. 桥接节点：住在相邻两圈的交集区 ----
  for (const [a, b] of ADJACENT_PAIRS) {
    const A = CIRCLE_MAP[a];
    const B = CIRCLE_MAP[b];
    // 交集区中点 = 两圆心中点，节点沿垂直方向错开，避免叠在一条线上
    const mx = (A.cx + B.cx) / 2;
    const my = (A.cy + B.cy) / 2;
    const nx = -(B.cy - A.cy);
    const ny = B.cx - A.cx;
    const nlen = Math.hypot(nx, ny) || 1;

    BRIDGE_ROSTER.forEach((r, i) => {
      const spread = (i === 0 ? -1 : 1) * rng.range(0.06, 0.11);
      const inf = rng.int(4, 7);
      const node = {
        id: `n${nodes.length}`,
        name: `${r.name}·${A.name.slice(0, 2)}${B.name.slice(0, 2)}`,
        tag: r.tag,
        circles: [a, b],
        primaryCircle: a,
        influence: inf,
        skepticism: round2(rng.range(0.3, 0.55)),
        conformity: round2(rng.range(0.45, 0.7)),
        authorityTrust: round2(rng.range(0.4, 0.65)),
        fearSensitivity: round2(rng.range(0.45, 0.7)),
        traits: ['两头传话', '圈子交叉'],
        x: mx + (nx / nlen) * spread,
        y: my + (ny / nlen) * spread,
        state: 'gray',
        belief: 0,
        touched: false,
        immune: false,
        retention: 0,
        lastTactic: null,
        lastDelta: 0,
      };
      nodes.push(node);
      byCircle[a].push(node);
      byCircle[b].push(node);
    });
  }

  /** 圈层对该主题的易感系数（桥接节点取两圈平均） */
  const suscOf = (node) => {
    const vals = node.circles.map((c) => topic.susceptibility[c] ?? 1);
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };

  // ---- 3. 圈内边：每个节点连到圈内 2~3 个最近邻 + 该圈影响力最高的枢纽 ----
  for (const circle of CIRCLES) {
    const members = byCircle[circle.id].filter((n) => n.circles.length === 1);
    const sorted = [...members].sort((p, q) => q.influence - p.influence);
    const hub = sorted[0];

    for (const node of members) {
      const others = members
        .filter((m) => m.id !== node.id)
        .sort((p, q) => dist2(node, p) - dist2(node, q));
      const k = rng.int(2, 3);
      for (let i = 0; i < Math.min(k, others.length); i++) {
        addEdge(edges, node.id, others[i].id, rng.range(0.55, 0.95), 'intra');
      }
      // 枢纽辐射：圈内核心天然触达更多人
      if (node.id !== hub.id && !hasEdge(edges, node.id, hub.id)) {
        addEdge(edges, node.id, hub.id, rng.range(0.5, 0.8), 'intra');
      }
    }
  }

  // ---- 4. 桥接边：桥接节点同时连向两个圈层内部 ----
  for (const node of nodes.filter((n) => n.circles.length === 2)) {
    for (const cid of node.circles) {
      const members = byCircle[cid]
        .filter((m) => m.id !== node.id)
        .sort((p, q) => dist2(node, p) - dist2(node, q));
      for (let i = 0; i < Math.min(3, members.length); i++) {
        addEdge(edges, node.id, members[i].id, rng.range(0.4, 0.7), 'bridge');
      }
    }
  }

  // ---- 5. 跨圈边：连接没有交集区的对角圈层，权重要低，代表"隔圈弱关系" ----
  const diagonals = [
    ['interest', 'workplace'],
    ['parent', 'campus'],
  ];
  for (const [a, b] of diagonals) {
    for (let i = 0; i < 2; i++) {
      const from = rng.pick(byCircle[a].filter((n) => n.circles.length === 1));
      const to = rng.pick(byCircle[b].filter((n) => n.circles.length === 1));
      addEdge(edges, from.id, to.id, rng.range(0.12, 0.22), 'cross');
    }
  }

  // ---- 6. 预计算邻接表，结算时高频使用 ----
  const adjacency = {};
  for (const n of nodes) adjacency[n.id] = [];
  for (const e of edges) {
    adjacency[e.source].push({ id: e.target, weight: e.weight, type: e.type });
    adjacency[e.target].push({ id: e.source, weight: e.weight, type: e.type });
  }

  return {
    nodes,
    edges,
    adjacency,
    circles: CIRCLES,
    circleRadius: CIRCLE_RADIUS,
    susceptibility: topic.susceptibility,
    suscOf,
    nodeById: Object.fromEntries(nodes.map((n) => [n.id, n])),
  };
}

// ------------------------------------------------------------------ 工具

function addEdge(edges, source, target, weight, type) {
  if (source === target || hasEdge(edges, source, target)) return;
  const relation = type === 'cross'
    ? '跨圈弱关系'
    : type === 'bridge'
      ? '桥接关系'
      : weight >= 0.78 ? '亲密关系' : weight >= 0.58 ? '普通关系' : '松散关系';
  edges.push({ source, target, weight: round2(weight), type, relation });
}

function hasEdge(edges, a, b) {
  return edges.some(
    (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a)
  );
}

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function pickTraits(rng, circleId, k) {
  const pool = [...TRAIT_POOL[circleId]];
  const out = [];
  for (let i = 0; i < k && pool.length; i++) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return out;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 网络结构自检：连通性、圈层覆盖、边的合法性 */
export function auditNetwork(net) {
  const seen = new Set([net.nodes[0].id]);
  const queue = [net.nodes[0].id];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of net.adjacency[cur]) {
      if (!seen.has(nb.id)) {
        seen.add(nb.id);
        queue.push(nb.id);
      }
    }
  }
  const counts = { intra: 0, bridge: 0, cross: 0 };
  for (const e of net.edges) counts[e.type]++;
  return {
    nodes: net.nodes.length,
    edges: net.edges.length,
    edgeTypes: counts,
    connected: seen.size === net.nodes.length,
    unreachable: net.nodes.filter((n) => !seen.has(n.id)).map((n) => n.name),
  };
}
