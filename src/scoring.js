/**
 * 话术识别与三维评分引擎（本地规则版）。
 *
 * 两条评分路径共用同一份输出结构，可以互换：
 *   - src/llm.js   调用大模型，语义理解更强
 *   - 本文件        纯规则，零延迟、离线可用，同时充当大模型失败时的降级方案
 *                  以及 AI 对手的行动评分器。
 *
 * 六种话术类型各自偏向一个维度：
 *   情绪化标题 → 即时影响深度
 *   伪造数据   → 即时影响 + 时间留存
 *   权威背书   → 时间留存长度
 *   诉诸恐惧   → 即时影响 + 破圈广度
 *   模糊信源   → 破圈传播广度
 *   破圈投放   → 破圈传播广度（纯渠道型话术，内容力弱）
 */

import { clamp } from './rng.js';

export const TACTICS = {
  emotional: {
    id: 'emotional',
    name: '情绪化标题',
    desc: '用惊叹、愤怒、猎奇把信息推到你眼前，抢占注意力',
    dims: { impact: 1.0, retention: 0.2, spread: 0.45 },
    counters: '内容空心，容易被后续信息覆盖，留存最差',
  },
  fake_data: {
    id: 'fake_data',
    name: '伪造数据',
    desc: '编造或移花接木的百分比、倍数、检测数值，让说法显得"有据可查"',
    dims: { impact: 0.7, retention: 0.85, spread: 0.3 },
    counters: '数字最经得起时间沉淀，但也最容易被核查推翻',
  },
  authority: {
    id: 'authority',
    name: '权威背书',
    desc: '假托专家、内部人士、红头文件，把说法挂到一个可信身份上',
    dims: { impact: 0.65, retention: 0.95, spread: 0.4 },
    counters: '一旦权威本人出面否认，整条信息链会连锁崩塌',
  },
  fear: {
    id: 'fear',
    name: '诉诸恐惧',
    desc: '直接指向健康、安全、前途的损失，逼人先转发再思考',
    dims: { impact: 1.0, retention: 0.4, spread: 0.7 },
    counters: '情绪峰值来得快去得也快，需要反复投放维持',
  },
  vague_source: {
    id: 'vague_source',
    name: '模糊信源',
    desc: '用"据说""疑似""某"把来源抹掉，让辟谣方无从证伪',
    dims: { impact: 0.4, retention: 0.5, spread: 0.9 },
    counters: '杀伤力弱，但几乎无法被直接反驳，扩散成本最低',
  },
  cross_circle: {
    id: 'cross_circle',
    name: '破圈投放',
    desc: '以"转给身边的人"为钩子，主动把内容投进其它圈层',
    dims: { impact: 0.35, retention: 0.5, spread: 1.0 },
    counters: '本身不含信息量，跨圈后容易因为语境丢失而失真',
  },
};

export const TACTIC_LIST = Object.values(TACTICS);

/** 辟谣方使用各类话术的天然适配度：编数据、吓唬人式辟谣会被反噬 */
const DEBUNK_SIDE_FIT = {
  authority: 1.15,
  vague_source: 0.92,
  cross_circle: 1.0,
  emotional: 0.85,
  fear: 0.7,
  fake_data: 0.6,
};

/** 会引发辟谣反噬的话术类型 */
const BACKFIRE_TACTICS = new Set(['fake_data', 'fear']);

/** 关键词模式表：命中越多、越分散，该类型得分越高 */
const PATTERNS = {
  emotional: [
    /震惊|惊天|炸锅|疯传|刷屏|细思极恐|太可怕|看哭|怒|气炸|离谱|竟然|居然/g,
    /速看|紧急|扩散|曝光|重磅|刚刚|注意|提醒|别错过/g,
    /不转不是|后悔|可惜|痛心|寒心|心凉/g,
  ],
  fake_data: [
    /\d+(\.\d+)?\s*%|百分之\s*\d+/g,
    /\d+\s*(倍|万|千人|万人|例|起|种|款)/g,
    /数据显示|研究表明|报告显示|实验证明|统计显示|据测算|抽样|抽检|检测出|超标|含量达|检出/g,
    /同比|环比|增长|下降\s*\d|翻了\s*\d/g,
  ],
  authority: [
    /专家|教授|博士|院士|主任|医生|研究员|律师|工程师/g,
    /官方|有关部门|相关部门|权威|红头文件|通报|声明|委员会|研究院|协会|总局|管理局/g,
    /内部人士|知情人|接近.{0,4}人士|高层|内部消息|据可靠消息/g,
    // 机构名本身就是背书 —— "在医院工作的朋友"和"医生"是同一种话术
    /医院|学校|院里|单位|局里|所里|公司高层|我们领导|上级部门/g,
    // 二手转述型背书："我朋友说的""内部已经下文了"
    /(朋友|亲戚|熟人|同学|同事|家人|邻居).{0,10}(说的|透露|讲的|通知|工作|内部)/g,
    /内部|下文|已经发文|接到通知|正式文件|有文件|开会说了/g,
  ],
  fear: [
    /致癌|致命|中毒|猝死|危及生命|死亡|不孕|绝症|白血病|畸变|毁掉|断送|中招/g,
    /千万别|不要再|后果自负|为家人|为了家人|为了孩子|替家人|来不及|最后机会|后悔一辈子|小心/g,
    /危险|风险极高|严重|威助|隐患|灭顶/g,
  ],
  vague_source: [
    /据说|听说|有人说|网传|据传|传|疑似|可能|也许|大概|不排除/g,
    /某(个|家|位|地|学校|公司|医院|品牌|部门)|相关人士|知情者|消息人士/g,
    /朋友圈|群里|群里看到|朋友的朋友|不完全统计/g,
  ],
  cross_circle: [
    /转给|转发|扩散|传下去|告诉身边|奔走相告|让更多人|大家都|所有人都/g,
    /家长们|同学们|同事们|邻居们|朋友们|各位|身边的朋友/g,
    /别只顾自己|为了家人|替家人|提醒一下/g,
  ],
};

// ---------------------------------------------------------------- 主入口

/**
 * 用本地规则引擎给一条话术打分。
 * @param {string} text     玩家或 AI 写的话术
 * @param {object} ctx      { topic, side, node }
 *   side: 'rumor' | 'debunk'
 *   node: 目标节点（用于计算契合度）
 */
export function analyzeLocally(text, ctx) {
  const raw = String(text || '').trim();
  const feats = extractFeatures(raw);
  const { type, confidence, secondary } = detectTactic(raw, feats);
  const spec = TACTICS[type];

  // ---- 内容力：这条话术本身写得好不好（与类型无关的通用质量）----
  // 太短说不清、太长没人看完；有具体信息、有钩子的质量最高。
  const lengthScore = pickByRange(feats.len, [
    [0, 0, 10],
    [1, 8, 25],
    [8, 20, 60],
    [20, 70, 100],
    [70, 120, 78],
    [120, 260, 55],
    [260, Infinity, 30],
  ]);
  const infoScore = clamp(feats.specificity * 22 + feats.numbers * 15, 0, 100);
  const hookScore = clamp(feats.callsToAction * 26 + feats.emotional * 16, 0, 100);
  const quality = clamp(lengthScore * 0.42 + infoScore * 0.3 + hookScore * 0.28, 0, 100);

  // ---- 三维基础分：类型倾向 × 内容力 ----
  const base = 0.32 + 0.68 * (quality / 100); // 内容力作为乘数，避免空话也拿高分
  let impact = spec.dims.impact * base * 100;
  let retention = spec.dims.retention * base * 100;
  let spread = spec.dims.spread * base * 100;

  // 同类关键词密集度带来小幅加成，鼓励把一条话术写透而不是堆砌
  const densityBonus = clamp(1 + (feats.matchedTypes[type] || 0) * 0.06, 1, 1.3);
  impact *= densityBonus;
  retention *= densityBonus;
  spread *= densityBonus;

  // ---- 目标契合度：话术类型是否打在这个节点的软肋上 ----
  const node = ctx.node;
  const tacticAffinity = {
    authority: node.authorityTrust,
    fear: node.fearSensitivity,
    emotional: node.conformity,
    fake_data: 0.45 + 0.55 * (1 - node.skepticism),
    vague_source: 0.5 + 0.5 * (1 - node.skepticism),
    cross_circle: 0.4 + 0.6 * node.conformity,
  }[type];

  const sideFit = ctx.side === 'debunk' ? DEBUNK_SIDE_FIT[type] ?? 1 : 1;
  const targetFit = clamp(tacticAffinity * sideFit * 100, 0, 100);

  // 契合度直接调制最终三维分：打错软肋的话术事倍功半
  const fitMul = 0.55 + 0.45 * (targetFit / 100);
  impact = clamp(impact * fitMul, 0, 100);
  retention = clamp(retention * fitMul, 0, 100);
  spread = clamp(spread * fitMul, 0, 100);

  const backfire = ctx.side === 'debunk' && BACKFIRE_TACTICS.has(type);

  return {
    tacticType: type,
    tacticName: spec.name,
    confidence: round2(confidence),
    secondary,
    impact: Math.round(impact),
    retention: Math.round(retention),
    spread: Math.round(spread),
    targetFit: Math.round(targetFit),
    quality: Math.round(quality),
    backfire,
    reason: buildReason(type, ctx, { impact, retention, spread, targetFit, backfire, feats }),
    source: 'local',
  };
}

// ---------------------------------------------------------------- 类型识别

/** 逐类型跑正则，取命中最强的一类作为主类型 */
function detectTactic(text, feats) {
  const scores = {};
  for (const [type, group] of Object.entries(PATTERNS)) {
    let hits = 0;
    let groups = 0;
    for (const re of group) {
      const m = text.match(re);
      if (m && m.length) {
        hits += m.length;
        groups += 1;
      }
    }
    // 命中多个不同的模式组，比在同一组里刷很多次的信号更强
    scores[type] = hits > 0 ? hits * 1.0 + groups * 1.6 : 0;
  }

  // 纯渠道型话术（破圈投放）需要真有号召动作，否则不成立
  if (feats.callsToAction === 0) scores.cross_circle *= 0.25;
  // 没有任何数字就不要判定为"伪造数据"
  if (feats.numbers === 0) scores.fake_data *= 0.2;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;

  // 一个特征都没命中 —— 归为最弱的信息型话术，并如实标注低置信度
  if (topScore <= 0) {
    return { type: 'vague_source', confidence: 0.25, secondary: [] };
  }

  const confidence = clamp(0.4 + (topScore - secondScore) / (topScore + 3), 0.35, 0.97);
  const secondary = ranked
    .slice(1, 3)
    .filter(([, s]) => s > 0 && s >= topScore * 0.6)
    .map(([t]) => ({ type: t, name: TACTICS[t].name }));

  return { type: topType, confidence: round2(confidence), secondary };
}

/** 通用文本特征：长度、数字、具体性、号召动作、情绪浓度 */
function extractFeatures(text) {
  const len = [...text].length;
  const countMatches = (res) =>
    res.reduce((sum, re) => sum + ((text.match(re) || []).length), 0);

  const matchedTypes = {};
  let hits = {};
  for (const [type, group] of Object.entries(PATTERNS)) {
    hits[type] = countMatches(group);
  }
  matchedTypes.emotional = hits.emotional;

  return {
    len,
    numbers: (text.match(/\d+(\.\d+)?/g) || []).length,
    specificity: (text.match(/[市区县镇街]|大学|中学|小学|医院|公司|集团|部门|品牌|小区|平台|协会|研究院/g) || []).length,
    callsToAction: countMatches([/转给|转发|扩散|传下去|告诉|提醒|让更多人|奔走相告/g]),
    emotional: hits.emotional,
    matchedTypes: hits,
  };
}

// ---------------------------------------------------------------- 文案生成

function buildReason(type, ctx, r) {
  const spec = TACTICS[type];
  const node = ctx.node;
  const side = ctx.side === 'debunk' ? '辟谣' : '造谣';
  const parts = [`识别为「${spec.name}」：${spec.desc}。`];

  if (r.targetFit >= 70) {
    parts.push(`正好打在「${node.name}」的软肋上（该节点对这类话术的接受度高），契合度 ${r.targetFit}。`);
  } else if (r.targetFit < 40) {
    parts.push(`但「${node.name}」对这类话术不敏感（怀疑度 ${(node.skepticism * 100) | 0}%、权威信任 ${(node.authorityTrust * 100) | 0}%），契合度只有 ${r.targetFit}，效果打了折扣。`);
  } else {
    parts.push(`与「${node.name}」的画像基本匹配，契合度 ${r.targetFit}。`);
  }

  // 指出这条话术最强的维度，帮玩家建立"类型→维度"的直觉
  const dims = [
    ['即时影响', r.impact],
    ['时间留存', r.retention],
    ['传播广度', r.spread],
  ].sort((a, b) => b[1] - a[1]);
  parts.push(`三维表现：${dims.map(([n, v]) => `${n} ${v}`).join(' / ')}，最强项是${dims[0][0]}。`);

  if (r.backfire) {
    parts.push(`⚠️ 辟谣方使用「${spec.name}」会引发反噬 —— 用编数据或吓唬人的方式辟谣，一旦被识破，这个节点对你的后续话术会更警惕。`);
  }
  if (r.feats && r.feats.len < 8) {
    parts.push('话术过短，信息量不足，三维分被内容力拖累。');
  }

  return parts.join(' ');
}

function pickByRange(v, table) {
  for (const [lo, hi, score] of table) {
    if (v >= lo && v < hi) return score;
  }
  return 0;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * AI 对手的行动评分。AI 不调用大模型（成本与延迟考虑），
 * 而是从模板库里针对目标节点画像选一条最合适的话术，再走同一套规则引擎。
 */
export function pickAiTactic(node, side, rng) {
  const affinity = {
    authority: node.authorityTrust,
    fear: node.fearSensitivity,
    emotional: node.conformity,
    fake_data: 1 - node.skepticism,
    vague_source: 1 - node.skepticism,
    cross_circle: node.conformity,
  };
  // AI 也不傻：辟谣方会主动避开会反噬的类型
  const candidates = TACTIC_LIST.filter(
    (t) => !(side === 'debunk' && BACKFIRE_TACTICS.has(t.id))
  );
  const weighted = candidates.map((t) => {
    let w = affinity[t.id] ** 2;
    if (side === 'debunk') w *= DEBUNK_SIDE_FIT[t.id] ?? 1;
    return [t.id, w + 0.05];
  });
  const type = rng.weighted(weighted);
  return type;
}

/** AI 话术模板库：按类型 × 阵营组织，用主题里的传闻内核填空 */
export const AI_TEMPLATES = {
  rumor: {
    emotional: [
      '{seed}！我人傻了，速看，晚了就删',
      '刚看到就炸了：{seed}，太离谱了吧',
      '不转不是本地人！{seed}，真的假的啊',
    ],
    fake_data: [
      '有数据显示，{seed}，超标的比例高达 73.6%',
      '第三方抽检了 120 份样本，其中 89 份检出问题 —— {seed}',
      '统计显示相关投诉同比上涨 3.8 倍，{seed}',
    ],
    authority: [
      '我一个在医院工作的朋友说的，{seed}，内部已经下文了',
      '据接近有关部门的人士透露：{seed}',
      '专家在会上明确提过，{seed}，只是没对外发',
    ],
    fear: [
      '千万别不当回事，{seed}，真出事了后悔一辈子',
      '已经有孩子中招了，{seed}，为了家人一定要看',
      '{seed}，后果自负，我不敢说得太明白',
    ],
    vague_source: [
      '据说{seed}，不知道真假，但我先转一下',
      '网传{seed}，我朋友的朋友就在那边，应该八九不离十',
      '疑似{seed}，不排除范围还会扩大',
    ],
    cross_circle: [
      '转给身边的家长朋友，{seed}，让更多人知道',
      '别只顾自己，{seed}，扩散出去',
      '{seed}，奔走相告，尤其是家里有老人小孩的',
    ],
  },
  debunk: {
    emotional: [
      '离谱！{seed}这种说法居然还有人信，看一眼就笑出声',
      '又被带节奏了，{seed}，稍微查一下就知道',
    ],
    authority: [
      '官方通报已经出来了：{seed}，以正式发布为准',
      '权威机构复核结论：{seed}，相关说法不成立',
      '学校已经发通知澄清，{seed}，请以书面通知为准',
    ],
    vague_source: [
      '这个说法目前没有可靠来源，{seed}，先别急着转',
      '据我了解{seed}这个说法站不住脚，但我也没法百分百确认，建议等权威信息',
    ],
    cross_circle: [
      '转给群里的家长，{seed}，别让假消息继续传',
      '麻烦帮忙扩散一下澄清，{seed}',
    ],
  },
};

export function renderAiTemplate(text, topic) {
  return text.replace('{seed}', topic.rumorSeed);
}
