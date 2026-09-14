/**
 * 参数扫描：找传播系数、自然衰减、辟谣力度的合适取值。
 * 用法：node tools/sweep.mjs [维度]
 *
 * 目标：
 *   1. 终局有效占比（红+黄+绿）落在 40%~70% —— 太低说明关系网推不动、
 *      玩起来没反馈；太高说明信息瞬间铺满、没有博弈空间。
 *   2. 红和绿两个"战果"都要能真的达成 —— 绿色长期只有 5% 的话，
 *      辟谣方会觉得自己在做无用功。
 *   3. 两个阵营的胜率大致均衡。
 */
import { Game, K } from '../src/game.js';
import { TOPICS } from '../src/topics.js';
import { analyzeLocally, AI_TEMPLATES, renderAiTemplate, pickAiTactic } from '../src/scoring.js';
import { makeRng } from '../src/rng.js';

const topic = TOPICS[0];

/**
 * 局数与种子前缀必须和 tools/check-layout.js 第 5 节完全一致。
 *
 * 早先这里用的是自己的一套种子，结果扫描出来的"均势点"搬到自检脚本里
 * 就变成一边倒 —— 两个工具测的根本不是同一批局。调参工具和验证工具
 * 必须喂同一份输入，否则调出来的数没有意义。
 */
const RUNS = 20;
const SEED_PREFIX = 'sim';

function run(seed, side) {
  const g = new Game({ seed, topicId: topic.id, playerSide: side });
  const rng = makeRng(seed);
  const key = (s) => (s === 'debunk' ? 'debunk' : 'rumor');
  for (let r = 1; r <= g.totalRounds; r++) {
    const picks = [...g.net.nodes]
      .filter((n) => !g.usedThisTurn.includes(n.id))
      .sort((a, b) => b.influence - a.influence)
      .slice(0, 3);
    for (const n of picks) {
      g.usedThisTurn.push(n.id);
      const t = pickAiTactic(n, side, rng);
      const res = analyzeLocally(renderAiTemplate(rng.pick(AI_TEMPLATES[key(side)][t]), topic), {
        topic, side, node: n,
      });
      g.applyAction({ ...res, tacticType: t, nodeId: n.id, side });
    }
    for (const a of g.aiAct()) g.applyAction(a);
    g.propagate();
    g.decay();
    g.refreshStates();
    g.maybeFireMidgameEvent();
    g.usedThisTurn = [];
    g.round = r + 1;
  }
  const s = g.computeStats().influencePct;
  return { ...s, cover: g.coverage().count };
}

function evaluate(label, patch) {
  Object.assign(K, patch);
  const out = {};
  for (const side of ['rumor', 'debunk']) {
    const acc = { red: 0, yellow: 0, green: 0, gray: 0 };
    let wins = 0;
    for (let i = 0; i < RUNS; i++) {
      const p = run(`${SEED_PREFIX}-${side}-${i}`, side);
      for (const k in acc) acc[k] += p[k];
      // 该阵营是否"赢"：造谣方看红，辟谣方看绿
      const mine = side === 'rumor' ? p.red : p.green;
      const theirs = side === 'rumor' ? p.green : p.red;
      if (mine > theirs + 3) wins++;
    }
    const a = (k) => Math.round(acc[k] / RUNS);
    out[side] = {
      红: a('red'), 黄: a('yellow'), 绿: a('green'), 灰: a('gray'),
      有效: a('red') + a('yellow') + a('green'),
      本方胜率: `${wins}/${RUNS}`,
    };
  }
  return {
    组: label,
    造谣方视角: `红${out.rumor.红} 黄${out.rumor.黄} 绿${out.rumor.绿} 灰${out.rumor.灰} · 有效${out.rumor.有效} · 胜${out.rumor.本方胜率}`,
    辟谣方视角: `红${out.debunk.红} 黄${out.debunk.黄} 绿${out.debunk.绿} 灰${out.debunk.灰} · 有效${out.debunk.有效} · 胜${out.debunk.本方胜率}`,
  };
}

const rows = [];
for (const prop of [0.25, 0.32, 0.4]) {
  for (const push of [0.065, 0.09]) {
    rows.push(evaluate(`传播${prop} 免疫压${push}`, {
      RUMOR_BASE: 105, DEBUNK_BASE: 70, PROP_RATE: prop,
      IMMUNE_PUSH: push, BASE_DECAY: 3.5,
    }));
  }
}
console.table(rows);
