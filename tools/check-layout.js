/**
 * 布局与结算的离线自检脚本：node tools/check-layout.js
 *
 * 检查四件事：
 *   1. 关系网结构是否合法（连通性、边类型分布、圈层归属、几何是否真的"部分交集、部分独立"）
 *   2. 力导向布局跑完后节点有没有重叠、各簇有没有散开、有没有跑出画布
 *   3. 话术识别的准确度与辟谣反噬机制
 *   4. 整局平衡性 —— 直接驱动真实的 Game 类跑 40 局，不复制一份结算数学
 */

import { buildNetwork, auditNetwork, CIRCLES } from '../src/network.js';
import { ForceSim } from '../public/sim.js';
import { TOPICS } from '../src/topics.js';
import { analyzeLocally, AI_TEMPLATES, renderAiTemplate, pickAiTactic } from '../src/scoring.js';
import { makeRng } from '../src/rng.js';
import { Game } from '../src/game.js';

const topic = TOPICS[0];
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
};

// ─────────────────────────── 1. 网络结构 ───────────────────────────
console.log('\n【1】关系网结构');
const net = buildNetwork('check-seed', topic);
const audit = auditNetwork(net);

const byCircle = {};
for (const n of net.nodes) for (const c of n.circles) (byCircle[c] ??= []).push(n);

console.log(`  节点 ${audit.nodes} 个 · 边 ${audit.edges} 条` +
  ` (圈内 ${audit.edgeTypes.intra} / 桥接 ${audit.edgeTypes.bridge} / 跨圈 ${audit.edgeTypes.cross})`);
for (const c of CIRCLES) console.log(`    ${c.name}: ${byCircle[c.id].length} 个节点`);

check('全部节点可达（图连通）', audit.connected,
  audit.unreachable.length ? `孤岛: ${audit.unreachable.join(',')}` : '');
check('四个圈层都有人', CIRCLES.every((c) => byCircle[c.id].length >= 8));
check('存在桥接节点（相邻圈层交集）', net.nodes.filter((n) => n.circles.length === 2).length >= 4,
  `${net.nodes.filter((n) => n.circles.length === 2).length} 个`);
check('存在跨圈弱连接（对角圈层之间）', net.edges.filter((e) => e.type === 'cross').length >= 2,
  `${net.edges.filter((e) => e.type === 'cross').length} 条`);
check('对角圈层之间没有桥接节点（交集区只存在于相邻圈）',
  !net.nodes.some((n) => n.circles.includes('interest') && n.circles.includes('workplace')));
check('影响力分布有梯度', new Set(net.nodes.map((n) => n.influence)).size >= 6,
  `范围 ${Math.min(...net.nodes.map((n) => n.influence))}~${Math.max(...net.nodes.map((n) => n.influence))}`);
check('节点画像有差异（话术契合度才有意义）',
  new Set(net.nodes.map((n) => n.skepticism)).size >= 8,
  `怀疑度 ${Math.min(...net.nodes.map((n) => n.skepticism))}~${Math.max(...net.nodes.map((n) => n.skepticism))}`);

// ─────────────────────────── 2. 力导向布局 ───────────────────────────
const W = 900;
const H = 680;
console.log(`\n【2】力导向布局（${W}×${H} 视口）`);

// 同一张网跑两次必须得到完全一样的布局 —— 布局里不能有 Math.random()
const simA = new ForceSim(
  buildNetwork('check-seed', topic).nodes, net.edges, net.circles, net.circleRadius).settle(W, H);
const simB = new ForceSim(
  buildNetwork('check-seed', topic).nodes, net.edges, net.circles, net.circleRadius).settle(W, H);
const deterministic = simA.nodes.every((n, i) =>
  Math.abs(n.px - simB.nodes[i].px) < 1e-9 && Math.abs(n.py - simB.nodes[i].py) < 1e-9);

const sim = new ForceSim(net.nodes, net.edges, net.circles, net.circleRadius).settle(W, H);
const la = sim.audit(W, H);

console.log(`  圈层半径 ${la.circleRadiusPx}px · 最小节点间距余量 ${la.minGap}px`);
console.log(`  各簇到圆心的平均偏移: ${Object.entries(la.clusterDriftPx).map(([k, v]) => `${k} ${v}px`).join(' · ')}`);

check('布局可复现（同样输入必得同样结果）', deterministic);
check('没有节点圆重叠', !la.overlaps, la.overlaps ? `最差一对 ${la.worstPair}` : `最紧余量 ${la.minGap}px`);
check('节点都落在画布内',
  net.nodes.every((n) => n.px - n.r >= 0 && n.px + n.r <= W && n.py - n.r >= 0 && n.py + n.r <= H));
check('各簇围绕自己的圆心（偏移 < 圈层半径）',
  Object.values(la.clusterDriftPx).every((d) => d < la.circleRadiusPx),
  `最大 ${Math.max(...Object.values(la.clusterDriftPx))}px vs 半径 ${la.circleRadiusPx}px`);

// 相邻圈层要有交集区、对角圈层要留白 —— 这是"部分交集、部分独立"的几何保证
const S = Math.min(W, H) * 0.86;
const ox = (W - S) / 2;
const oy = (H - S) / 2;
const centers = Object.fromEntries(CIRCLES.map((c) => [c.id, { x: ox + c.cx * S, y: oy + c.cy * S }]));
const dist = (a, b) => Math.hypot(centers[a].x - centers[b].x, centers[a].y - centers[b].y);
const R = net.circleRadius * S;
console.log(`  相邻圈心距 ${Math.round(dist('interest', 'parent'))}px vs 2R=${Math.round(2 * R)}px → 重叠`);
console.log(`  对角圈心距 ${Math.round(dist('interest', 'workplace'))}px vs 2R=${Math.round(2 * R)}px → 分离`);
check('相邻圈层重叠（有交集区）', dist('interest', 'parent') < 2 * R);
check('对角圈层分离（相互独立）', dist('interest', 'workplace') > 2 * R);

// ─────────────────────────── 3. 话术识别 ───────────────────────────
console.log('\n【3】话术类型识别（本地规则引擎）');
const samples = [
  ['震惊！某品牌奶茶检出致癌物，速看，晚了就删！', 'emotional'],
  ['有数据显示，超标的比例高达 73.6%，抽检 120 份中 89 份不合格', 'fake_data'],
  ['我一个在医院工作的朋友说的，内部已经下文了', 'authority'],
  ['官方通报已经出来了，以正式发布为准', 'authority'],
  ['千万别不当回事，已经有孩子中招了，为了家人一定要看', 'fear'],
  ['据说好像是有这么回事，网传某地已经开始了，不确定真假', 'vague_source'],
  ['转给身边的家长朋友，让更多人知道，扩散出去', 'cross_circle'],
];
const probeNode = net.nodes.find((n) => n.influence >= 7);
let typeHits = 0;
for (const [text, expect] of samples) {
  const r = analyzeLocally(text, { topic, side: 'rumor', node: probeNode });
  const ok = r.tacticType === expect;
  if (ok) typeHits++;
  check(`「${text.slice(0, 16)}…」→ ${r.tacticName}`, ok,
    ok ? `影响 ${r.impact} / 留存 ${r.retention} / 广度 ${r.spread} / 契合 ${r.targetFit}`
       : `期望 ${expect}，实得 ${r.tacticType}`);
}
check('类型识别准确率 ≥ 85%', typeHits / samples.length >= 0.85, `${typeHits}/${samples.length}`);

// 六种类型与三维的对应关系必须真的体现出来 —— 否则玩家建立不起直觉
const dimProbe = {};
for (const [text, expect] of samples) {
  const r = analyzeLocally(text, { topic, side: 'rumor', node: probeNode });
  dimProbe[expect] = r;
}
check('情绪化标题的即时影响 > 模糊信源的即时影响',
  dimProbe.emotional.impact > dimProbe.vague_source.impact,
  `${dimProbe.emotional.impact} vs ${dimProbe.vague_source.impact}`);
check('权威背书的时间留存 > 情绪化标题的时间留存',
  dimProbe.authority.retention > dimProbe.emotional.retention,
  `${dimProbe.authority.retention} vs ${dimProbe.emotional.retention}`);
check('破圈投放的传播广度 > 伪造数据的传播广度',
  dimProbe.cross_circle.spread > dimProbe.fake_data.spread,
  `${dimProbe.cross_circle.spread} vs ${dimProbe.fake_data.spread}`);

// ─────────────────────────── 4. 辟谣反噬 ───────────────────────────
console.log('\n【4】辟谣方反噬机制');
const backfireCases = [
  ['官方通报已经出来了，以正式发布为准', 'authority', false],
  ['有数据显示，这个说法的不合格率高达 92.3%', 'fake_data', true],
  ['千万别信，不转出去后果自负，为了家人一定要看', 'fear', true],
  ['转给群里的家长，麻烦帮忙扩散一下澄清', 'cross_circle', false],
];
for (const [text, expectType, shouldBackfire] of backfireCases) {
  const r = analyzeLocally(text, { topic, side: 'debunk', node: probeNode });
  check(`辟谣方用「${r.tacticName}」${shouldBackfire ? '触发' : '不触发'}反噬`,
    r.backfire === shouldBackfire && r.tacticType === expectType,
    `识别为 ${r.tacticType} · targetFit ${r.targetFit}`);
}

// ─────────────────────────── 5. 整局平衡性 ───────────────────────────
console.log('\n【5】整局平衡性（直接驱动真实 Game 类，每边 20 局）');

/**
 * 用一个"中等水平玩家"的策略跑完整局：
 * 每回合挑影响力最大的 3 个未用节点，按目标画像挑话术类型。
 * 刻意不调用 playTurn() —— 那条路径会打大模型接口，离线自检不应该依赖网络。
 * 但 applyAction / propagate / decay / aiAct 用的都是生产代码，不是复制品。
 */
function simulateGame(seed, playerSide) {
  const game = new Game({ seed, topicId: topic.id, playerSide });
  const rng = makeRng(seed);
  const tplKey = (side) => (side === 'debunk' ? 'debunk' : 'rumor');

  for (let round = 1; round <= game.totalRounds; round++) {
    const picks = [...game.net.nodes]
      .filter((n) => !game.usedThisTurn.includes(n.id))
      .sort((a, b) => b.influence - a.influence)
      .slice(0, 3);

    for (const node of picks) {
      game.usedThisTurn.push(node.id);
      const type = pickAiTactic(node, playerSide, rng);
      const text = renderAiTemplate(rng.pick(AI_TEMPLATES[tplKey(playerSide)][type]), topic);
      const r = analyzeLocally(text, { topic, side: playerSide, node });
      game.applyAction({ ...r, tacticType: type, nodeId: node.id, side: playerSide });
    }

    for (const a of game.aiAct()) game.applyAction(a);

    game.propagate();
    game.decay();
    game.refreshStates();
    game.maybeFireMidgameEvent();
    game.usedThisTurn = [];
    game.round = round + 1;
  }

  const stats = game.computeStats();
  return {
    red: stats.influencePct.red,
    green: stats.influencePct.green,
    yellow: stats.influencePct.yellow,
    gray: stats.influencePct.gray,
    coverage: game.coverage().count,
    // 被"任何方式"波及过的节点数。整局里玩家只有 3×6 = 18 次直接投放，
    // 双方合计 36 次；如果最终被波及的节点数明显超过这个数，
    // 多出来的部分只可能是顺着连接关系扩散过去的 —— 这是对"传播"机制的实测，
    // 而不是对某个拍脑袋的灰色占比阈值的实测。
    reached: game.net.nodes.filter((n) => n.touched).length,
    totalNodes: game.net.nodes.length,
    directSlots: game.totalRounds * 3 * 2,
  };
}

const RUNS = 20;
const summary = {};
for (const side of ['rumor', 'debunk']) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(simulateGame(`sim-${side}-${i}`, side));

  const avg = (k) => Math.round(runs.reduce((s, r) => s + r[k], 0) / runs.length);
  const avgCov = (runs.reduce((s, r) => s + r.coverage, 0) / runs.length).toFixed(1);
  const reds = runs.filter((r) => r.red > r.green + 3).length;
  const greens = runs.filter((r) => r.green > r.red + 3).length;
  const draws = RUNS - reds - greens;
  summary[side] = { reds, greens, draws, red: avg('red'), green: avg('green') };

  const reached = Math.round(runs.reduce((s, r) => s + r.reached, 0) / runs.length);
  const total = runs[0].totalNodes;
  const slots = runs[0].directSlots;

  console.log(`  ${side === 'rumor' ? '玩家造谣' : '玩家辟谣'}方: ` +
    `红 ${avg('red')}% / 黄 ${avg('yellow')}% / 绿 ${avg('green')}% / 灰 ${avg('gray')}% · ` +
    `平均覆盖 ${avgCov}/4 圈`);
  console.log(`    终局分布 → 造谣胜 ${reds} 局 / 辟谣胜 ${greens} 局 / 平局 ${draws} 局`);
  console.log(`    扩散实测 → 被波及 ${reached}/${total} 个节点（双方直接投放合计仅 ${slots} 次）`);

  check(`[${side}] 不是一边倒（两种结果都出现过）`, reds > 0 && greens > 0,
    `造谣胜 ${reds} / 辟谣胜 ${greens}`);
  check(`[${side}] 玩家能覆盖到多个圈层（≥ 2.5 圈）`, Number(avgCov) >= 2.5, `${avgCov} 圈`);
  check(`[${side}] 传播真的在扩散（被波及节点数 > 直接投放次数）`, reached > slots,
    `${reached} 个节点被波及 vs ${slots} 次直接投放`);
  check(`[${side}] 大部分节点都参与进来了（被波及 ≥ 60%）`, reached / total >= 0.6,
    `${reached}/${total} = ${Math.round((reached / total) * 100)}%`);
  check(`[${side}] 局面被真正推动（灰色 < 50%）`, avg('gray') < 50, `灰 ${avg('gray')}%`);
}

const allRed = summary.rumor.red + summary.debunk.red;
const allGreen = summary.rumor.green + summary.debunk.green;
check('双方胜率大致均衡（红绿总量接近）', Math.abs(allRed - allGreen) < 40,
  `红合计 ${allRed}% vs 绿合计 ${allGreen}%`);

console.log(`\n${failures === 0 ? '全部检查通过 ✓' : `${failures} 项检查未通过 ✗`}\n`);
process.exit(failures === 0 ? 0 : 1);
