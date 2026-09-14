/**
 * 前端主程序。
 *
 * 职责边界很清楚：**所有数值都来自服务端**。这里只做三件事：
 *   1. 把服务端给的快照画出来（关系网 / 进度条 / 折线图 / 结算 / 日志）
 *   2. 收集玩家选的 3 个节点 + 3 段话术，提交回服务端
 *   3. 力导向布局的静态部分（位置、半径）—— 这部分与游戏规则无关，纯表现
 *
 * 话术的评分、传播、衰减、胜负判定一律不在这里算，前端算一遍只会和服务端
 * 产生第二套真相，改一个系数就得改两个地方。
 */

import { ForceSim, NODE_RADIUS } from './sim.js';

// ─────────────────────────── 常量 ───────────────────────────

const STATE_META = {
  gray:   { label: '未接触' },
  yellow: { label: '半信半疑' },
  red:    { label: '已相信' },
  green:  { label: '已辟谣免疫' },
};
const STATE_ORDER = ['red', 'yellow', 'green', 'gray'];

/** 三个态势维度：与 src/scoring.js 的三维一一对应 */
const SERIES = [
  { key: 'impact',    name: '即时影响深度', fallback: '#3987e5' },
  { key: 'retention', name: '时间留存长度', fallback: '#d95926' },
  { key: 'spread',    name: '破圈传播广度', fallback: '#199e70' },
];

/** 四个圈层的底色。刻意避开红/黄/绿/灰 —— 那四个色位被节点状态占用了，
 *  圈层壳再用相近色相会让人以为壳的颜色也在表达某种状态。 */
const CIRCLE_TINT = {
  interest:  '#3987e5',
  parent:    '#a855f7',
  workplace: '#14b8a6',
  campus:    '#ec4899',
};

const MAX_TEXT = 200;
const TEXT_SWEET_SPOT = [20, 70]; // 内容力评分的最佳长度区间，写提示用

// ─────────────────────────── 模糊档位（凭感觉） ───────────────────────────
//
// 设计目标：默认界面里**不出现裸数字**，把服务端的精密计算翻译成"人话"和图形。
// 每个数值都渲染成一对元素：<span class="fuzzy">档位词</span><span class="precise">精确数</span>，
// CSS 根据 body 上的 precise-on 类决定显示哪一半 —— 点顶栏「显示精确数值」即可切换，
// 不需要重跑任何渲染逻辑。服务端 math 原封不动，这里只是换个说法。

const FUZZY_LEVELS_100    = ['极低', '偏低', '一般', '偏高', '极高'];
const FUZZY_LEVELS_01     = ['很低', '偏低', '中等', '偏高', '很高'];
const FUZZY_LEVELS_SHARE  = ['稀少', '偏少', '近半', '偏多', '极多'];
const FUZZY_LEVELS_IMPACT = ['微弱', '一般', '较强', '极强'];

function fuzzyTier(value, min, max, labels) {
  const v = clamp01(((value ?? 0) - min) / (max - min));
  return labels[Math.round(v * (labels.length - 1))];
}

const level100    = (v) => fuzzyTier(v, 0, 100, FUZZY_LEVELS_100);
const level01     = (v) => fuzzyTier(v, 0, 1,   FUZZY_LEVELS_01);
const levelShare  = (v) => fuzzyTier(v, 0, 100, FUZZY_LEVELS_SHARE);
const levelImpact = (v) => fuzzyTier(v, 0, 10,  FUZZY_LEVELS_IMPACT);

/** 净变化：方向 + 幅度。例如 +14 → 「上扬·明显」；-3 → 「回落·极微」。 */
function levelDelta(v) {
  const mag = Math.abs(v ?? 0);
  const magLabel = fuzzyTier(mag, 0, 30, ['极微', '小幅', '明显', '剧烈']);
  return { text: `${(v ?? 0) >= 0 ? '上扬' : '回落'}·${magLabel}`, up: (v ?? 0) >= 0 };
}

/** 影响半径（像素）→ 直观大小 */
function levelRadius(influence) {
  const r = NODE_RADIUS(influence);
  return r <= 8 ? '很窄' : r <= 13 ? '一般' : r <= 17 ? '较远' : '很远';
}

/** 渲染一对：默认显示模糊词，precise 模式显示精确数。 */
function pair(fuzzyText, preciseText) {
  return `<span class="fuzzy">${fuzzyText}</span><span class="precise">${preciseText}</span>`;
}

/** 当前是否处于"显示精确数值"模式（由顶栏开关控制）。 */
function preciseOn() {
  return document.body.classList.contains('precise-on');
}

/** 顶栏开关：切换模糊档位 ⇄ 精确数值，并重绘依赖 JS 分支的图表。 */
function togglePrecise() {
  document.body.classList.toggle('precise-on');
  els.preciseBtn.setAttribute('aria-pressed', String(preciseOn()));
  els.preciseBtn.textContent = preciseOn() ? '已显示精确数值' : '显示精确数值';
  if (state) {
    renderChart(); // SVG 的文字不走 CSS，得靠 JS 重绘
    renderLog();   // 日志在 render 时按模式排版数字 / 档位词，也要重排
  }
}

/** 免疫剩余回合 → 直觉表达 */
function levelImmune(v) {
  return v <= 1 ? '即将失效' : v <= 3 ? '还能撑住' : '还能守很久';
}

/** 覆盖不全惩罚乘数 → 直觉表达（×0.7 这种冷冰冰的乘数换成程度词） */
function penaltyWord(v) {
  const n = Number(v);
  return n >= 0.85 ? '轻微' : n >= 0.7 ? '明显' : '很重';
}

/** 服务端 reason 里带数字的分句（契合度 xx / 三维表现 xx）在模糊视图下摘除，只留定性点评 */
function fuzzyReason(text) {
  const t = String(text || '');
  if (!/\d/.test(t)) return t;
  const kept = t.split('。').map((s) => s.trim()).filter((s) => s && !/\d/.test(s));
  return kept.length ? kept.join('。') : t;
}

/** 把服务端文案里混着的裸数字也翻成档位词（模糊模式下使用，精确模式仍显示原文）。 */
function fuzzifyText(text) {
  return String(text ?? '')
    .replace(/(\d{1,3})\s*%/g, (m, n) => level01(Number(n) / 100))
    .replace(/(\d{1,3})/g, (m, n) => level100(Number(n)));
}

// ─────────────────────────── 全局状态 ───────────────────────────

let state = null;        // 服务端快照
let sim = null;          // 力导向布局（跨回合复用，位置才不会跳）
let selected = [];       // 本回合选中的节点 id，最多 3 个
let activeTarget = null; // 当前准备接收下一张话术卡的节点
let hoverId = null;
let submissions = {};    // nodeId -> 玩家写的话术
let cardAssignments = {}; // nodeId -> 本回合内容卡 id
let toneAssignments = {}; // nodeId -> calm / normal / bold
let topics = [];
let pickedSide = null;
let pickedTopic = null;
let busy = false;
let chartData = [];
let propagationFx = null;

const $ = (id) => document.getElementById(id);

const els = {
  stage: $('graph-stage'),
  canvas: $('graph-canvas'),
  legend: $('legend'),
  nodeCard: $('node-card'),
  graphStatus: $('graph-status'),
  slots: $('slots'),
  contentCards: $('content-cards'),
  contentBankLead: $('content-bank-lead'),
  targetGuideList: $('target-guide-list'),
  goalGuide: $('goal-guide'),
  aiIntent: $('ai-intent'),
  eventBox: $('event-box'),
  actionSub: $('action-sub'),
  actionProgress: $('action-progress'),
  actionTip: $('action-tip'),
  btnSubmit: $('btn-submit'),
  roundChip: $('round-chip'),
  sideChip: $('side-chip'),
  topicChip: $('topic-chip'),
  aiIntent: $('ai-intent'),
  eventBox: $('event-box'),
  engineChip: $('engine-chip'),
  btnPrecise: $('btn-precise'),
  btnRestart: $('btn-restart'),
  meters: $('meters'),
  chartLegend: $('chart-legend'),
  chart: $('line-chart'),
  chartTip: $('chart-tip'),
  chartTable: $('chart-table'),
  settle: $('settle'),
  log: $('log'),
  startModal: $('start-modal'),
  sidePicker: $('side-picker'),
  sideNote: $('side-note'),
  topicPicker: $('topic-picker'),
  btnStart: $('btn-start'),
  resultModal: $('result-modal'),
  verdictBadge: $('verdict-badge'),
  verdictTitle: $('verdict-title'),
  verdictSub: $('verdict-sub'),
  resultBody: $('result-body'),
  truthLine: $('truth-line'),
  btnAgain: $('btn-again'),
};

const ctx = els.canvas.getContext('2d');

// ─────────────────────────── 主题色 ───────────────────────────

/** 从 CSS 变量读色值，保证 canvas 和样式表用的是同一份颜色，不会各写一遍 */
const cssVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const C = {
  get gray()   { return cssVar('--st-gray', '#8b93a1'); },
  get yellow() { return cssVar('--st-yellow', '#fab219'); },
  get red()    { return cssVar('--st-red', '#e66767'); },
  get green()  { return cssVar('--st-green', '#0ca30c'); },
  get accent() { return cssVar('--accent', '#3987e5'); },
  get plane()  { return cssVar('--plane', '#0d0f14'); },
  get ink()    { return cssVar('--ink', '#e8eaf0'); },
  get ink2()   { return cssVar('--ink-2', '#a8aebd'); },
  get inkMuted() { return cssVar('--ink-muted', '#6f7685'); },
  get border() { return cssVar('--border', '#252a36'); },
  get series() {
    return [
      cssVar('--series-1', SERIES[0].fallback),
      cssVar('--series-2', SERIES[1].fallback),
      cssVar('--series-3', SERIES[2].fallback),
    ];
  },
};

// 深色底上的文字色，用于压在实心节点圆上的符号
const ON_RED = '#16121a';
const ON_GREEN = '#04140a';

// ─────────────────────────── API ───────────────────────────

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

// ─────────────────────────── 启动流程 ───────────────────────────

async function boot() {
  bindEvents();
  try {
    const health = await api('/api/health');
    renderEngineChip(health.llm);
  } catch {
    els.engineChip.textContent = '引擎状态未知';
    els.engineChip.dataset.state = 'local';
  }
  try {
    const data = await api('/api/topics');
    topics = data.topics || [];
    renderTopicPicker();
  } catch (err) {
    els.topicPicker.innerHTML = `<p class="empty">主题加载失败：${escapeHtml(err.message)}</p>`;
  }
}

function renderEngineChip(llm) {
  if (llm?.configured) {
    els.engineChip.textContent = `大模型评分 · ${llm.model}`;
    els.engineChip.dataset.state = 'live';
    els.engineChip.title = `话术由大模型评分（${llm.baseUrl}）。调用失败会自动降级到本地规则引擎。`;
  } else {
    els.engineChip.textContent = '本地规则引擎';
    els.engineChip.dataset.state = 'local';
    els.engineChip.title = '未检测到大模型凭证，话术由本地规则引擎评分。配置 config.local.json 后可切换。';
  }
}

function renderTopicPicker() {
  els.topicPicker.innerHTML = '';
  for (const t of topics) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'topic-option';
    btn.dataset.topic = t.id;
    btn.setAttribute('aria-pressed', 'false');

    const susc = t.susceptibility || {};
    const hot = Object.entries(susc).sort((a, b) => b[1] - a[1]);
    const chip = ([k, v]) =>
      `<span class="${v >= 1.15 ? 'susc-hot' : v <= 0.85 ? 'susc-cold' : ''}">${circleName(k)} ${fmtMul(v)}</span>`;

    btn.innerHTML = `
      <span class="topic-name">${escapeHtml(t.title)}</span>
      <span class="topic-brief">${escapeHtml(t.brief)}</span>
      <span class="topic-source">${escapeHtml(t.sourceLabel || '虚构教学主题')} · 风险：${escapeHtml(t.riskLevel || '一般')}</span>
      <span class="topic-susc">${hot.map(chip).join('')}</span>`;
    btn.addEventListener('click', () => pickTopic(t.id));
    els.topicPicker.appendChild(btn);
  }
}

/** 主题易感系数：×1.15 / ×0.85 这类倍数翻成直觉判断 */
function suscWord(v) {
  const n = Number(v);
  if (n >= 1.15) return '极易感';
  if (n >= 1.05) return '较易感';
  if (n <= 0.85) return '较钝感';
  if (n < 1) return '略钝感';
  return '一般';
}
function fmtMul(v) {
  const n = Number(v);
  return pair(suscWord(n), `×${n.toFixed(2)}`);
}

function circleName(id) {
  return { interest: '兴趣', parent: '家长', workplace: '职场', campus: '校园' }[id] || id;
}

function pickTopic(id) {
  pickedTopic = id;
  for (const el of els.topicPicker.children) {
    el.setAttribute('aria-pressed', String(el.dataset.topic === id));
  }
  updateStartButton();
}

function pickSide(side) {
  pickedSide = side;
  for (const el of els.sidePicker.querySelectorAll('.side-option')) {
    el.setAttribute('aria-pressed', String(el.dataset.side === side));
  }
  els.sideNote.textContent =
    side === 'rumor'
      ? '你散布传闻，AI 扮演辟谣方 —— 它会优先扑向你影响力最大的节点。'
      : '你澄清传闻，AI 扮演造谣方 —— 它每回合也会挑 3 个节点投放。';
  updateStartButton();
}

function updateStartButton() {
  els.btnStart.disabled = !(pickedSide && pickedTopic);
}

async function startGame() {
  if (!pickedSide || !pickedTopic || busy) return;
  busy = true;
  els.btnStart.disabled = true;
  els.btnStart.textContent = '正在生成关系网…';
  try {
    const data = await api('/api/game', {
      method: 'POST',
      body: JSON.stringify({ playerSide: pickedSide, topicId: pickedTopic }),
    });
    els.startModal.hidden = true;
    els.resultModal.hidden = true;
    selected = [];
    activeTarget = null;
    submissions = {};
    cardAssignments = {};
    toneAssignments = {};
    hoverId = null;
    sim = null;
    applyState(data.state, { fresh: true });
  } catch (err) {
    els.btnStart.disabled = false;
    els.btnStart.textContent = '开始对抗';
    alert(`开局失败：${err.message}`);
  } finally {
    busy = false;
    els.btnStart.textContent = '开始对抗';
  }
}

// ─────────────────────────── 状态落地 ───────────────────────────

/**
 * 把服务端快照铺到界面上。
 * @param {object} next  新的快照
 * @param {{fresh?:boolean}} opts fresh=true 表示新开一局，需要重建布局
 */
function applyState(next, opts = {}) {
  state = next;

  if (opts.fresh || !sim) {
    buildSim();
  } else {
    syncSimNodes();
  }
  resizeCanvas();
  draw();

  chartData = (state.history || []).map((h) => ({
    round: h.round,
    impact: h.impact,
    retention: h.retention,
    spread: h.spread,
    red: h.red, yellow: h.yellow, green: h.green, gray: h.gray,
  }));

  // 每个面板各自兜底：某一块渲染出问题不应该把其余部分一起带下水，
  // 更不该让"开局"整体失败 —— 玩家看到的应该是"图挂了，但游戏还能玩"。
  for (const [name, fn] of [
    ['顶栏', renderTopbar],
    ['行动槽位', renderSlots],
    ['内容卡', renderContentCards],
    ['关键目标', renderTargetGuide],
    ['AI与事件', renderAiAndEvent],
    ['目标与事件', renderGoalsAndEvent],
    ['进度条', renderMeters],
    ['折线图', renderChart],
    ['日志', renderLog],
  ]) {
    try {
      fn();
    } catch (err) {
      console.error(`[渲染失败] ${name}:`, err);
    }
  }

  if (state.finished && state.finalResult) {
    renderResult(state.finalResult);
    els.resultModal.hidden = false;
  }
}

/** 建立力导向布局。只在开局时做一次，之后位置一直复用，节点才不会每回合乱跳 */
function buildSim() {
  const nodes = state.nodes.map((n) => ({
    id: n.id,
    // 归一化坐标是布局的初值，sim 只读取它一次，之后由力平衡决定位置
    x: n.x,
    y: n.y,
    influence: n.influence,
    circles: n.circles,
    primaryCircle: n.primaryCircle,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    r: 0,
    // 以下是每回合会变的展示字段，由 syncSimNodes() 刷新
    state: n.state,
    belief: n.belief,
    touched: n.touched,
    immuneHold: n.immuneHold,
    playerMark: n.playerMark,
  }));
  sim = new ForceSim(nodes, state.edges, state.circles, state.circleRadius);
  sim.settle(stageSize().w, stageSize().h);
}

/** 把最新的展示字段同步到布局节点上（位置保持不动） */
function syncSimNodes() {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  for (const ln of sim.nodes) {
    const n = byId.get(ln.id);
    if (!n) continue;
    ln.state = n.state;
    ln.belief = n.belief;
    ln.touched = n.touched;
    ln.immuneHold = n.immuneHold;
    ln.playerMark = n.playerMark;
  }
}

function nodeState(id) {
  return state?.nodes.find((n) => n.id === id) || null;
}

// ─────────────────────────── 顶栏 ───────────────────────────

function renderTopbar() {
  els.roundChip.textContent = `第 ${state.round} / ${state.totalRounds} 回合`;
  els.sideChip.hidden = false;
  els.sideChip.dataset.side = state.playerSide;
  els.sideChip.textContent = state.playerSide === 'rumor' ? '你是造谣方' : '你是辟谣方';
  els.topicChip.textContent = state.topic.title;
  els.topicChip.title = state.topic.brief;

  const played = (state.history || []).length;
  els.actionSub.textContent = state.finished
    ? '本局已结束。'
    : `点击人物，再点击对应话术卡完成绑定（第 ${played + 1} / ${state.totalRounds} 回合）`;
}

// ─────────────────────────── 画布 ───────────────────────────

function stageSize() {
  const rect = els.stage.getBoundingClientRect();
  return { w: Math.max(320, Math.round(rect.width)), h: Math.max(280, Math.round(rect.height)) };
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = stageSize();
  els.canvas.width = Math.round(w * dpr);
  els.canvas.height = Math.round(h * dpr);
  els.canvas.style.width = `${w}px`;
  els.canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw() {
  if (!sim || !state) return;
  const { w, h } = stageSize();
  const t = sim.transform(w, h);

  ctx.clearRect(0, 0, w, h);

  drawCircleShells(t);
  drawEdges(t);
  drawNodes(t);
  drawPropagationFx(t);
  updateStatusBar();
}

function startPropagationFx(result) {
  const ids = [...new Set((result.roundLog || []).map((x) => x.nodeId).filter(Boolean))];
  if (!ids.length) return;
  propagationFx = { ids, started: performance.now(), duration: 1250 };
  const tick = () => {
    if (!propagationFx) return;
    draw();
    if (performance.now() - propagationFx.started < propagationFx.duration) requestAnimationFrame(tick);
    else propagationFx = null;
  };
  requestAnimationFrame(tick);
}

function drawPropagationFx(t) {
  if (!propagationFx || !sim) return;
  const elapsed = performance.now() - propagationFx.started;
  const p = Math.min(1, elapsed / propagationFx.duration);
  const byId = new Map(sim.nodes.map((n) => [n.id, n]));
  const active = new Set(propagationFx.ids);
  for (const id of propagationFx.ids) {
    const n = byId.get(id);
    if (!n) continue;
    const radius = n.r + 8 + p * 34;
    ctx.beginPath();
    ctx.arc(n.px, n.py, radius, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(state.playerSide === 'debunk' ? C.green : C.red, (1 - p) * 0.75);
    ctx.lineWidth = 2.5 - p * 1.3;
    ctx.stroke();
  }
  // 沿关系边做一条短暂的亮带，表现影响从目标向周边扩散。
  for (const e of state.edges) {
    const A = byId.get(e.source); const B = byId.get(e.target);
    if (!A || !B) continue;
    const from = active.has(A.id) ? A : active.has(B.id) ? B : null;
    if (!from) continue;
    const to = from === A ? B : A;
    const q = Math.min(1, p * 1.35);
    ctx.beginPath();
    ctx.moveTo(from.px, from.py);
    ctx.lineTo(from.px + (to.px - from.px) * q, from.py + (to.py - from.py) * q);
    ctx.strokeStyle = hexA(state.playerSide === 'debunk' ? C.green : C.red, (1 - p) * 0.72);
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }
}

/** 四个圈层的底壳：低透明度色块 + 圆心标签，让"部分重叠、部分独立"看得见 */
function drawCircleShells(t) {
  for (const c of state.circles) {
    const p = t.circleCenter(c.id);
    const r = t.radiusPx;
    const tint = CIRCLE_TINT[c.id] || C.accent;

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hexA(tint, 0.055);
    ctx.fill();
    ctx.strokeStyle = hexA(tint, 0.36);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 圈名贴在圆的左上方外沿，避开圆心的节点密集区
    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lx = p.x;
    const ly = p.y - r - 2;
    const label = c.name;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = hexA(C.plane, 0.85);
    roundRect(lx - tw / 2 - 7, ly - 10, tw + 14, 20, 10);
    ctx.fill();
    ctx.strokeStyle = hexA(tint, 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = hexA(tint, 1);
    ctx.fillText(label, lx, ly + 0.5);
  }
}

/** 边：圈内实线、桥接稍亮、跨圈虚线且最淡 —— 弱连接要看起来就弱 */
function drawEdges(t) {
  ctx.lineCap = 'round';
  // 悬停会高频重绘，先把节点索引建好，别在 132 条边的循环里反复线性查找
  const byId = new Map(sim.nodes.map((n) => [n.id, n]));
  for (const e of state.edges) {
    const A = byId.get(e.source);
    const B = byId.get(e.target);
    if (!A || !B) continue;

    const active = (A.state === 'red' || B.state === 'red');
    const greenish = (A.state === 'green' || B.state === 'green');

    let stroke = hexA(C.border, e.type === 'intra' ? 0.85 : 0.6);
    if (e.type === 'cross') stroke = hexA(C.inkMuted, 0.22);
    // 谣言/免疫正沿着这条边流动时给一点颜色，让"扩散"这件事在画面上发生
    if (active && A.state !== 'green' && B.state !== 'green') stroke = hexA(C.red, 0.3);
    else if (greenish && (A.state === 'green' || B.state === 'green')) stroke = hexA(C.green, 0.24);

    ctx.beginPath();
    ctx.moveTo(A.px, A.py);
    ctx.lineTo(B.px, B.py);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = e.type === 'intra' ? 1 : e.type === 'bridge' ? 1.1 : 0.9;
    if (e.type === 'cross') ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/**
 * 节点。
 *
 * 状态不只靠颜色区分：红和绿在红绿色盲下几乎无法分辨（ΔE 只有个位数），
 * 所以每种状态都额外带一个形状通道 —— 虚线空心 / 半填充 / 实心加符号，
 * 和左下角图例里的画法完全一致。
 */
function drawNodes(t) {
  const labeled = new Set();
  const recommended = new Set((state.recommendedTargets || []).map((n) => n.id));
  for (const n of sim.nodes) {
    if (n.influence >= 8) labeled.add(n.id);
  }
  if (hoverId) labeled.add(hoverId);
  for (const id of selected) labeled.add(id);

  for (const n of sim.nodes) {
    const isSel = selected.includes(n.id);
    const isHover = hoverId === n.id;
    const r = n.r + (isHover ? 2 : 0);

    if (recommended.has(n.id) && !isSel) {
      ctx.beginPath();
      ctx.arc(n.px, n.py, r + 7, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(C.yellow, 0.8);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 玩家影响力触达过的节点，外面套一圈虚线环
    if (n.playerMark > 0) {
      ctx.beginPath();
      ctx.arc(n.px, n.py, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(C.accent, Math.min(0.85, 0.35 + n.playerMark * 0.5));
      ctx.lineWidth = 1.1;
      ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (isSel) {
      ctx.beginPath();
      ctx.arc(n.px, n.py, r + 9, 0, Math.PI * 2);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }

    switch (n.state) {
      case 'gray': {
        ctx.beginPath();
        ctx.arc(n.px, n.py, r, 0, Math.PI * 2);
        ctx.fillStyle = hexA(C.plane, 0.5);
        ctx.fill();
        ctx.strokeStyle = hexA(C.gray, 0.9);
        ctx.lineWidth = 1.6;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case 'yellow': {
        // 左半边填充 —— 和图例里的 linear-gradient 半填充是同一个意思
        ctx.save();
        ctx.beginPath();
        ctx.arc(n.px, n.py, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = hexA(C.plane, 0.55);
        ctx.fillRect(n.px - r, n.py - r, r * 2, r * 2);
        ctx.fillStyle = hexA(C.yellow, 0.92);
        ctx.fillRect(n.px - r, n.py - r, r, r * 2);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(n.px, n.py, r, 0, Math.PI * 2);
        ctx.strokeStyle = C.yellow;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        break;
      }
      case 'red':
      case 'green': {
        const fill = n.state === 'red' ? C.red : C.green;
        ctx.beginPath();
        ctx.arc(n.px, n.py, r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        // 实心圆之间留一圈底色描边，重叠时边界仍然清楚
        ctx.strokeStyle = hexA(C.plane, 0.9);
        ctx.lineWidth = 1.6;
        ctx.stroke();

        if (r >= 9) {
          ctx.fillStyle = n.state === 'red' ? ON_RED : ON_GREEN;
          ctx.font = `800 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.state === 'red' ? '!' : '✓', n.px, n.py + 0.5);
        }
        break;
      }
    }

    if (labeled.has(n.id)) {
      const label = nodeState(n.id)?.name || '';
      ctx.font = '500 10.5px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(label).width;
      const ly = n.py + r + 4;
      ctx.fillStyle = hexA(C.plane, 0.82);
      roundRect(n.px - tw / 2 - 3, ly - 1, tw + 6, 13, 4);
      ctx.fill();
      ctx.fillStyle = isSel || isHover ? C.ink : hexA(C.ink2, 0.95);
      ctx.fillText(label, n.px, ly + 1);
    }
  }
}

/** 画布底部那一条引导文案 —— 始终告诉玩家"下一步该做什么" */
function updateStatusBar() {
  if (!state) return;
  const need = state.nodesPerTurn;
  let html;
  if (state.finished) {
    html = '本局已结束，可以重新开局';
  } else if (selected.length === 0) {
    html = `先点击一个人物，再点击对应的<b>话术卡</b>（共 ${need} 次）`;
  } else if (activeTarget) {
    html = `已选中人物，点击一张<b>话术卡</b>完成绑定`;
  } else if (selected.length < need) {
    html = `已完成 <b>${selected.length}</b> / ${need} 次，请选择下一个人物`;
  } else if (selected.some((id) => !(submissions[id] || '').trim())) {
    html = `${need} 个节点已选好，把上方的<b>三张内容卡</b>分配到行动框`;
  } else {
    html = '话术就绪，可以<b>提交本回合</b>';
  }
  els.graphStatus.hidden = false;
  els.graphStatus.innerHTML = html;
}

// ─────────────────────────── 交互 ───────────────────────────

function canvasPoint(evt) {
  const rect = els.canvas.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}

function pickNodeAt(pt) {
  if (!sim) return null;
  // 从后往前找：后画的节点在上层
  for (let i = sim.nodes.length - 1; i >= 0; i--) {
    const n = sim.nodes[i];
    if (Math.hypot(n.px - pt.x, n.py - pt.y) <= n.r + 5) return n;
  }
  return null;
}

function onMove(evt) {
  if (!sim) return;
  const hit = pickNodeAt(canvasPoint(evt));
  const id = hit?.id || null;
  if (id !== hoverId) {
    hoverId = id;
    els.canvas.style.cursor = id ? 'pointer' : 'default';
    draw();
  }
  if (id) showNodeCard(id, canvasPoint(evt));
  else els.nodeCard.hidden = true;
}

function onLeave() {
  hoverId = null;
  els.nodeCard.hidden = true;
  if (sim) draw();
}

function onClick(evt) {
  if (busy || !sim || state?.finished) return;
  const hit = pickNodeAt(canvasPoint(evt));
  if (!hit) return;

  if (selected.length >= state.nodesPerTurn && !selected.includes(hit.id)) {
    flashStatus(`本回合已完成 ${state.nodesPerTurn} 次行动`);
    return;
  }
  // 点击人物后立即显示选中状态；如果上一个人物还没有绑定话术，换点时替换它。
  if (activeTarget && activeTarget !== hit.id && !submissions[activeTarget]) {
    const pendingIndex = selected.indexOf(activeTarget);
    if (pendingIndex >= 0) selected.splice(pendingIndex, 1);
    delete cardAssignments[activeTarget];
  }
  if (!selected.includes(hit.id)) selected.push(hit.id);
  activeTarget = hit.id;
  renderSlots();
  renderContentCards();
  draw();
}

function showNodeCard(id, pt) {
  const n = nodeState(id);
  if (!n) return;
  els.nodeCard.hidden = false;
  els.nodeCard.innerHTML = `
    <div class="nc-name">${escapeHtml(n.name)}<span class="nc-tag">${escapeHtml(n.tag || '')}</span></div>
    <div class="nc-state"><span class="lg-mark lg-${n.state}"></span>${STATE_META[n.state].label}
      <b style="margin-left:auto">${pair(level100(n.belief), String(n.belief))}</b></div>
    <div class="nc-rows">
      <span>影响力</span><b>${pair(levelImpact(n.influence), n.influence.toFixed(1))}</b>
      <span>影响半径</span><b>${pair(levelRadius(n.influence), `${Math.round(NODE_RADIUS(n.influence))}px`)}</b>
      <span>所属圈层</span><b>${n.circles.map(circleName).join(' + ')}</b>
      <span>怀疑度</span><b>${pair(level01(n.skepticism), pct(n.skepticism))}</b>
      <span>从众度</span><b>${pair(level01(n.conformity), pct(n.conformity))}</b>
      <span>权威信任</span><b>${pair(level01(n.authorityTrust), pct(n.authorityTrust))}</b>
      <span>恐惧敏感</span><b>${pair(level01(n.fearSensitivity), pct(n.fearSensitivity))}</b>
    </div>
    ${n.traits?.length ? `<div class="nc-traits">${n.traits.map((t) => `<span class="nc-trait">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    <div class="nc-hint">${escapeHtml(bestTacticHint(n))}</div>`;

  // 跟着鼠标走，但不能溢出舞台
  const rect = els.stage.getBoundingClientRect();
  const cardW = els.nodeCard.offsetWidth;
  const cardH = els.nodeCard.offsetHeight;
  let x = pt.x + 16;
  let y = pt.y + 14;
  if (x + cardW > rect.width - 8) x = pt.x - cardW - 16;
  if (y + cardH > rect.height - 8) y = Math.max(8, rect.height - cardH - 8);
  els.nodeCard.style.left = `${Math.max(8, x)}px`;
  els.nodeCard.style.top = `${y}px`;
}

/** 根据节点画像推荐话术类型 —— 这是"契合度"机制的唯一可见提示，不给的话玩家只能瞎猜 */
function bestTacticHint(n) {
  const rumorRank = [
    ['authority', n.authorityTrust, '权威背书'],
    ['fear', n.fearSensitivity, '诉诸恐惧'],
    ['emotional', n.conformity, '情绪化标题'],
    ['fake_data', 1 - n.skepticism, '伪造数据'],
    ['vague_source', 1 - n.skepticism, '模糊信源'],
    ['cross_circle', n.conformity, '破圈投放'],
  ].sort((a, b) => b[1] - a[1]);

  const top = rumorRank[0];
  const weak = rumorRank[rumorRank.length - 1];
  return `对「${top[2]}」最没有抵抗力（契合度偏高）；对「${weak[2]}」最不敏感，别浪费在这上面。`;
}

function pct(v) {
  return `${Math.round((v ?? 0) * 100)}%`;
}

function flashStatus(text) {
  els.graphStatus.hidden = false;
  els.graphStatus.innerHTML = `<b style="color:var(--st-yellow)">${escapeHtml(text)}</b>`;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(updateStatusBar, 2200);
}

// ─────────────────────────── 行动槽位 ───────────────────────────

function renderSlots() {
  els.slots.innerHTML = '';

  if (!state) return;
  for (let i = 0; i < state.nodesPerTurn; i++) {
    const id = selected[i];
    if (!id) {
      const empty = document.createElement('div');
      empty.className = 'slot-empty';
      empty.dataset.slot = String(i);
      empty.innerHTML = `点击关系网中的节点<br>放入第 ${i + 1} 个投放目标`;
      els.slots.appendChild(empty);
      continue;
    }

    const n = nodeState(id);
    const el = document.createElement('div');
    el.className = 'slot filled';
    el.dataset.nodeId = id;
    if (id === activeTarget) el.classList.add('active-target');
    el.innerHTML = `
      <div class="slot-head">
        <span class="slot-idx">${i + 1}</span>
        <span class="slot-name">${escapeHtml(n.name)}</span>
        <span class="slot-circle">${n.circles.map(circleName).join(' + ')}</span>
      </div>
      <textarea maxlength="${MAX_TEXT}" readonly placeholder="点击上方内容卡，或把内容卡拖到这里…"></textarea>
      <div class="slot-meta">
        <span class="slot-count">0 / ${MAX_TEXT}</span>
        <span class="slot-hint"></span>
      </div>`;

    const ta = el.querySelector('textarea');
    const count = el.querySelector('.slot-count');
    const hint = el.querySelector('.slot-hint');
    ta.value = submissions[id] || '';
    hint.innerHTML = nodeHint(n);
    count.textContent = `${ta.value.length} / ${MAX_TEXT}`;

    const tone = toneAssignments[id] || 'normal';
    const toneRow = document.createElement('div');
    toneRow.className = 'tone-row';
    toneRow.innerHTML = `<span>语气</span><button type="button" data-tone="calm">克制</button><button type="button" data-tone="normal">普通</button><button type="button" data-tone="bold">激进</button><em>${escapeHtml(previewFor(n, cardAssignments[id], tone))}</em>`;
    for (const btn of toneRow.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.tone === tone);
      btn.addEventListener('click', () => { toneAssignments[id] = btn.dataset.tone; renderSlots(); });
    }
    el.appendChild(toneRow);

    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      assignCardToNode(e.dataTransfer.getData('text/plain'), id);
    });

    els.slots.appendChild(el);
  }

  els.actionProgress.innerHTML = `已选 <b>${selected.length}</b> / ${state.nodesPerTurn}`;
  updateSubmitState();
}

function renderContentCards() {
  if (!state) return;
  els.contentBankLead.textContent = [
    state.topic.taskLead,
    state.topic.sourceLabel,
    state.topic.evidence,
  ].filter(Boolean).join(' · ');
  els.contentCards.innerHTML = '';
  for (const card of state.actionCards || []) {
    const usedBy = Object.keys(cardAssignments).find((id) => cardAssignments[id] === card.id);
    const usedName = usedBy ? nodeState(usedBy)?.name : '';
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'content-card';
    el.draggable = !usedBy;
    el.disabled = Boolean(usedBy);
    el.dataset.cardId = card.id;
    el.innerHTML = `<b>${escapeHtml(card.label || card.kind || '行动内容')}</b><span>${escapeHtml(card.text)}</span>${usedBy ? `<em>已绑定人物：${escapeHtml(usedName || '当前目标')}</em>` : '<em class="card-hint">点击人物后绑定</em>'}`;
    el.addEventListener('click', () => assignCardToNext(card.id));
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', card.id));
    els.contentCards.appendChild(el);
  }
}

function renderTargetGuide() {
  if (!state || !els.targetGuideList) return;
  els.targetGuideList.innerHTML = (state.recommendedTargets || []).map((t, i) => `<button type="button" class="target-guide-item" data-node-id="${escapeHtml(t.id)}"><b>${i + 1}. ${escapeHtml(t.name)}</b><span>${escapeHtml(t.reason)}</span></button>`).join('');
  for (const btn of els.targetGuideList.querySelectorAll('button')) btn.addEventListener('click', () => selectNodeById(btn.dataset.nodeId));
}

function renderAiAndEvent() {
  if (els.aiIntent) els.aiIntent.textContent = state.aiIntent ? `AI：${state.aiIntent}` : '';
  if (!els.eventBox) return;
  const e = state.pendingEvent;
  els.eventBox.hidden = !e;
  if (!e) return;
  els.eventBox.innerHTML = `<b>${escapeHtml(e.title)}</b><span>${escapeHtml(e.brief)}</span>${e.options.map((o) => `<button type="button" data-event-choice="${o.id}">${escapeHtml(o.label)}</button>`).join('')}`;
  for (const b of els.eventBox.querySelectorAll('button')) b.addEventListener('click', () => { state._eventChoice = b.dataset.eventChoice; flashStatus('已选择事件策略，提交下一回合时生效'); });
}

function renderGoalsAndEvent() {
  if (els.goalGuide) els.goalGuide.innerHTML = (state.goals || []).map((g) => `<span class="goal-pill" data-done="${g.done}">${g.done ? '✓' : '○'} ${escapeHtml(g.label)}${g.value != null ? ` (${g.value}/${g.target})` : ''}</span>`).join('');
  if (els.aiIntent) els.aiIntent.textContent = state.aiIntent ? `AI：${state.aiIntent}` : '';
  if (els.eventBox) {
    const e = state.pendingEvent;
    els.eventBox.hidden = !e;
    if (e) els.eventBox.innerHTML = `<b>${escapeHtml(e.title)}</b><span>${escapeHtml(e.brief)}</span>${e.options.map((o) => `<button type="button" data-event-choice="${o.id}">${escapeHtml(o.label)}</button>`).join('')}`;
    if (e) for (const b of els.eventBox.querySelectorAll('button')) b.addEventListener('click', () => { state._eventChoice = b.dataset.eventChoice; flashStatus('已选择事件策略，提交本回合后生效'); });
  }
}

function selectNodeById(id) {
  if (busy || state?.finished) return;
  if (selected.length >= state.nodesPerTurn && !selected.includes(id)) { flashStatus(`本回合已选满 ${state.nodesPerTurn} 人`); return; }
  if (!selected.includes(id)) selected.push(id);
  activeTarget = id;
  toneAssignments[id] ||= 'normal';
  renderSlots(); renderContentCards(); draw();
}

function previewFor(n, cardId, tone) {
  if (!cardId) return '选择内容后显示预估';
  const toneText = { calm: '较稳，留存更久', normal: '效果均衡', bold: '冲击更强，留存较短' }[tone];
  return `预估：${toneText} · ${bestTacticHint(n).split('；')[0]}`;
}

function assignCardToNext(cardId) {
  const target = activeTarget;
  if (!target) {
    flashStatus('请先在关系网上点击一个具体人物');
    return;
  }
  assignCardToNode(cardId, target);
}

function assignCardToNode(cardId, nodeId) {
  const card = state?.actionCards?.find((c) => c.id === cardId);
  if (!card || !selected.includes(nodeId)) return;
  const previousOwner = Object.keys(cardAssignments).find((id) => cardAssignments[id] === cardId);
  if (previousOwner && previousOwner !== nodeId) {
    delete cardAssignments[previousOwner];
    delete submissions[previousOwner];
  }
  cardAssignments[nodeId] = cardId;
  submissions[nodeId] = card.text;
  toneAssignments[nodeId] ||= 'normal';
  if (!selected.includes(nodeId)) selected.push(nodeId);
  activeTarget = null;
  renderSlots();
  renderContentCards();
}

/** 槽位里的提示：这条话术该往哪个方向写 */
function nodeHint(n) {
  const s = [];
  if (n.retention > 0) s.push(`当前留存${level100(n.retention)}`);
  if (n.immuneHold > 0) s.push(`免疫剩 ${pair(levelImmune(n.immuneHold), `${n.immuneHold} 回合`)}`);
  if (n.state === 'green') s.push('已免疫 · 需要高冲击才打得穿');
  else if (n.state === 'red') s.push('已相信 · 打下来就能转绿');
  else if (n.state === 'gray') s.push('未接触 · 首次触达');
  return s.join(' · ') || '未接触 · 首次触达';
}

function updateSubmitState() {
  if (!state || state.finished) {
    els.btnSubmit.disabled = true;
    els.btnSubmit.textContent = '本局已结束';
    return;
  }
  const ready =
    selected.length === state.nodesPerTurn &&
    selected.every((id) => (submissions[id] || '').trim().length > 0);
  els.btnSubmit.disabled = !ready || busy;
  els.btnSubmit.textContent = busy ? '结算中…' : '提交本回合';
}

// ─────────────────────────── 提交回合 ───────────────────────────

async function submitTurn() {
  if (busy || !state || state.finished) return;
  const subs = selected.map((id) => ({
    nodeId: id,
    text: (submissions[id] || '').trim(),
    cardId: cardAssignments[id],
    tone: toneAssignments[id] || 'normal',
  }));
  if (subs.length !== state.nodesPerTurn || subs.some((s) => !s.text)) return;

  busy = true;
  updateSubmitState();
  els.btnSubmit.textContent = '结算中…';

  try {
    const result = await api(`/api/game/${encodeURIComponent(state.gameId)}/turn`, {
      method: 'POST',
      body: JSON.stringify({ submissions: subs, eventChoice: state._eventChoice || null }),
    });
    startPropagationFx(result);
    renderSettle(result);
    if (result.event) {
      // 中局事件是黄色的系统提示，不放进结算卡里，单独闪一下状态条
      flashStatus(`【中局事件】${result.event.title} —— ${result.event.effect}`);
    }
    selected = [];
    submissions = {};
    cardAssignments = {};
    toneAssignments = {};
    activeTarget = null;
    applyState(result.state);
  } catch (err) {
    alert(`结算失败：${err.message}`);
  } finally {
    busy = false;
    if (state && !state.finished) updateSubmitState();
  }
}

// ─────────────────────────── 结算卡 ───────────────────────────

function renderSettle(result) {
  // roundLog 里**已经**同时包含玩家和 AI 的行动，并且各自带好了 who 字段。
  // 之前这里把整个 roundLog 一律标成 player、又另外追加了一遍 aiActions，
  // 结果是 AI 的三条行动被显示了两遍，而且第一遍还被挂在了"你"名下。
  const items = result.roundLog || [];
  if (!items.length) return;

  els.settle.innerHTML = '';
  for (const it of items) {
    const node = nodeState(it.nodeId);
    const el = document.createElement('div');
    el.className = 'settle-item';
    el.dataset.who = it.who;

    const delta = it.delta ?? 0;
    const deltaCls = delta >= 0 ? 'up' : 'down';
    const deltaTxt = `${delta >= 0 ? '+' : ''}${delta}`;
    const deltaTier = levelDelta(delta);

    const badges = [];
    if (it.backfire) badges.push('<span class="badge badge-warn">辟谣反噬</span>');
    if (it.source === 'llm') badges.push('<span class="badge badge-llm">大模型评分</span>');
    if (it.targetFit >= 70) badges.push('<span class="badge badge-ok">契合度高</span>');

    // 服务端 reason 里夹着精确数字（契合度 68 / 三维表现 72）——模糊模式下摘掉数字分句，只留定性点评
    const reason = it.reason ? fuzzyReason(it.reason) : '';

    el.innerHTML = `
      <div class="settle-head">
        <span class="settle-who" data-who="${it.who}">${it.who === 'player' ? '你' : 'AI'}</span>
        <span class="settle-node">${escapeHtml(it.nodeName || node?.name || '')}</span>
        <span class="settle-tactic">${escapeHtml(it.tacticName || '')}</span>
        <span class="settle-delta ${deltaCls}">${pair(deltaTier.text, deltaTxt)}</span>
      </div>
      <div class="settle-dims">
        <span>即时影响 <b>${pair(level100(it.impact), it.impact ?? '—')}</b></span>
        <span>时间留存 <b>${pair(level100(it.retention), it.retention ?? '—')}</b></span>
        <span>传播广度 <b>${pair(level100(it.spread), it.spread ?? '—')}</b></span>
        <span>契合度 <b>${pair(level100(it.targetFit), it.targetFit ?? '—')}</b></span>
      </div>
      <div class="settle-cause">直接行动 ${signed(it.directDelta)} · 邻居传播 ${signed(it.spreadDelta)} · 自然变化 ${signed(it.decayDelta)}</div>
      ${reason ? `<div class="settle-reason pair-wrap">${pair(escapeHtml(reason), escapeHtml(it.reason))}</div>` : ''}
      ${it.text && it.who === 'player' ? `<div class="settle-quote">${escapeHtml(it.text)}</div>` : ''}
      ${badges.length ? `<div class="settle-badges">${badges.join('')}</div>` : ''}`;
    els.settle.appendChild(el);
  }
}

// ─────────────────────────── 进度条 ───────────────────────────

function renderMeters() {
  const stats = state.stats;
  els.meters.innerHTML = '';

  for (const key of STATE_ORDER) {
    const pctVal = stats.influencePct[key] ?? 0;
    const cnt = stats.counts[key] ?? 0;
    const pctTxt = `${pctVal.toFixed(1)}%`;
    const el = document.createElement('div');
    el.className = 'meter';
    el.dataset.state = key;
    el.innerHTML = `
      <div class="meter-head">
        <span class="lg-mark lg-${key}"></span>
        <span class="meter-label">${STATE_META[key].label}</span>
        <span class="meter-value">${pair(levelShare(pctVal), pctTxt)}</span>
      </div>
      <div class="meter-track"><div class="meter-fill" style="width:${pctVal}%"></div></div>
      <div class="meter-foot">${cnt} 个节点 · 占影响力 ${pair(levelShare(pctVal), pctTxt)}</div>`;
    els.meters.appendChild(el);
  }

  for (const key of STATE_ORDER) {
    const el = $(`lg-${key}`);
    if (el) {
      const p = stats.influencePct[key] ?? 0;
      el.innerHTML = pair(levelShare(p), `${p.toFixed(1)}%`);
    }
  }

  els.legend.dataset.side = state.playerSide;
}

// ─────────────────────────── 折线图 ───────────────────────────

/**
 * 三条态势折线（即时影响 / 时间留存 / 传播广度），手写 SVG。
 * 不用图表库是有意为之：整站零依赖，而且这里只需要折线 + 十字准线。
 */
function renderChart() {
  const svg = els.chart;
  // 夹取父容器宽度来定 SVG 尺寸。父元素理论上一定在，但这里取不到值必须是可降级的 ——
  // 早先这行直接 .clientWidth 解引用，一旦为 null 就会把整个 applyState 掀翻，
  // 表现成"开局失败"，而真正的原因只是折线图没地方量宽度。
  const wrap = svg.parentElement;
  const wrapW = (wrap && wrap.clientWidth) || 320;
  const W = Math.max(240, wrapW);
  const H = 172;
  const pad = { t: 12, r: 40, b: 22, l: 30 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = '';

  const series = C.series;
  const n = chartData.length;

  // ---- 图例（两个以上系列必须有图例，颜色不能是唯一的身份线索）----
  els.chartLegend.innerHTML = SERIES.map((s, i) => `
    <span class="chart-legend-item">
      <span class="chart-legend-swatch" style="background:${series[i]}"></span>${s.name}
    </span>`).join('');

  // 横轴按**数据点序号**而不是回合号来排。
  //
  // history 的第一条是开局前的初始快照，它和"第 1 回合打完之后"那条同号 ——
  // 于是会出现两个 round=1 的点（实测序号是 1,1,2,3,4,5,6）。
  // 若按回合号定位，这两个点会叠在同一个 x 上，开头那一段就白画了。
  // 用序号排则每个点各占一格，首点单独标成"开局"。
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.t + ih - (clamp01(v / 100) * ih);

  const add = (tag, attrs, text) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  // ---- 网格与刻度：压得很淡，不和数据抢注意力 ----
  for (const v of [0, 25, 50, 75, 100]) {
    add('line', { x1: pad.l, y1: y(v), x2: pad.l + iw, y2: y(v), stroke: C.border, 'stroke-width': 1, opacity: v === 0 ? 0.9 : 0.45 });
    add('text', { x: pad.l - 6, y: y(v) + 3.5, 'text-anchor': 'end', fill: C.inkMuted, 'font-size': 9.5 },
      preciseOn() ? String(v) : level100(v));
  }

  if (!chartData.length) {
    add('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: C.inkMuted, 'font-size': 11.5 }, '提交第一个回合后开始记录');
  } else {
    // ---- 三条线 ----
    for (let i = 0; i < SERIES.length; i++) {
      const s = SERIES[i];
      const pts = chartData.map((d, k) => [x(k), y(d[s.key] ?? 0)]);
      add('path', {
        d: pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: series[i],
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      });
    }

    // ---- 只在最后一个点上做直接标注，不是每个点都写数字 ----
    for (let i = 0; i < SERIES.length; i++) {
      const s = SERIES[i];
      const last = chartData[chartData.length - 1];
      const lx = x(chartData.length - 1);
      const ly = y(last[s.key] ?? 0);
      add('circle', { cx: lx, cy: ly, r: 3, fill: series[i], stroke: C.plane, 'stroke-width': 1.5 });
      add('text', {
        x: lx + 6, y: ly + 3.5, fill: C.ink2, 'font-size': 10,
        'font-weight': 600, 'font-variant-numeric': 'tabular-nums',
      }, preciseOn() ? String(last[s.key] ?? 0) : level100(last[s.key] ?? 0));
    }

    // ---- 悬停层：十字准线 + 提示框 ----
    const cross = add('line', {
      x1: 0, y1: pad.t, x2: 0, y2: pad.t + ih,
      stroke: C.inkMuted, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0,
    });
    const dots = SERIES.map((_, i) =>
      add('circle', { cx: 0, cy: 0, r: 4, fill: series[i], stroke: C.plane, 'stroke-width': 2, opacity: 0 })
    );

    const overlay = add('rect', {
      x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair',
    });

    const showAt = (evt) => {
      const rect = svg.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * W;
      let idx = 0;
      let best = Infinity;
      chartData.forEach((_, i) => {
        const dist = Math.abs(x(i) - px);
        if (dist < best) { best = dist; idx = i; }
      });
      const d = chartData[idx];
      const cx = x(idx);

      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('opacity', 0.7);

      SERIES.forEach((s, i) => {
        dots[i].setAttribute('cx', cx);
        dots[i].setAttribute('cy', y(d[s.key] ?? 0));
        dots[i].setAttribute('opacity', 1);
      });

      els.chartTip.hidden = false;
      const tipVal = (v) => (preciseOn() ? String(v) : level100(v));
      const tipShare = (v) => (preciseOn() ? String(v) : levelShare(v));
      els.chartTip.innerHTML = `
        <div class="chart-tip-title">${idx === 0 ? '开局状态' : `第 ${d.round} 回合后`}</div>
        ${SERIES.map((s, i) => `
          <div class="chart-tip-row">
            <span class="chart-legend-swatch" style="background:${series[i]}"></span>
            <span class="chart-tip-name">${s.name}</span>
            <span class="chart-tip-val">${tipVal(d[s.key] ?? 0)}</span>
          </div>`).join('')}
        <div class="chart-tip-title" style="margin:7px 0 3px">终局状态占比</div>
        <div class="chart-tip-row"><span class="chart-tip-name">红 / 黄 / 绿 / 灰</span>
          <span class="chart-tip-val">${tipShare(d.red)} / ${tipShare(d.yellow)} / ${tipShare(d.green)} / ${tipShare(d.gray)}</span></div>`;

      const tipW = els.chartTip.offsetWidth;
      const wrapRect = wrap ? wrap.getBoundingClientRect() : { width: W };
      const localX = (cx / W) * wrapRect.width;
      let left = localX + 14;
      if (left + tipW > wrapRect.width - 4) left = localX - tipW - 14;
      els.chartTip.style.left = `${Math.max(4, left)}px`;
      els.chartTip.style.top = '8px';
    };

    const hide = () => {
      cross.setAttribute('opacity', 0);
      dots.forEach((d) => d.setAttribute('opacity', 0));
      els.chartTip.hidden = true;
    };

    overlay.addEventListener('mousemove', showAt);
    overlay.addEventListener('mouseleave', hide);
  }

  // ---- 横轴刻度：开局 + 各回合结算后的状态 ----
  chartData.forEach((d, i) => {
    add('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', fill: C.inkMuted, 'font-size': 9.5 },
      i === 0 ? '开局' : String(d.round));
  });

  renderChartTable();
}

/** 表格视图：颜色之外的第二条通路，也方便直接看数值 */
function renderChartTable() {
  const head = ['回合', ...SERIES.map((s) => s.name), '红', '黄', '绿', '灰'];
  const rows = chartData.map((d) => [
    String(d.round),
    ...SERIES.map((s) => String(d[s.key] ?? 0)),
    d.red, d.yellow, d.green, d.gray,
  ]);
  els.chartTable.innerHTML = `
    <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

// ─────────────────────────── 日志 ───────────────────────────

function renderLog() {
  const lines = state.log || [];
  els.log.innerHTML = lines
    .map((l) => `<div class="log-line" data-kind="${l.kind}"><span class="log-round">R${l.round}</span><span>${preciseOn() ? escapeHtml(l.text) : escapeHtml(fuzzifyText(l.text))}</span></div>`)
    .join('');
  els.log.scrollTop = els.log.scrollHeight;
}

// ─────────────────────────── 结果弹窗 ───────────────────────────

function renderResult(final) {
  const won = final.playerWon;
  els.verdictBadge.dataset.win = won === null ? 'draw' : String(won);
  els.verdictBadge.textContent = won === null ? '=' : won ? '✓' : '✗';

  els.verdictTitle.textContent = final.verdict;
  const scoreTxt = pair(level100(final.totalScore), String(final.totalScore));
  els.verdictSub.innerHTML =
    (won === null
      ? `你作为${escapeHtml(final.sideLabel)}，与对手打成平手 —— 红绿占比差距在 3 个百分点以内。`
      : won
        ? `你作为${escapeHtml(final.sideLabel)}取得了优势，终局得分 ${scoreTxt}。`
        : `你作为${escapeHtml(final.sideLabel)}落了下风，终局得分 ${scoreTxt}。对手是${escapeHtml(final.opposingLabel)}。`);

  const b = final.breakdown;
  const shares = final.shares;

  els.resultBody.innerHTML = `
    <div class="result-grid">
      ${['red', 'yellow', 'green', 'gray'].map((k) => `
        <div class="result-cell">
          <div class="result-cell-label">${STATE_META[k].label}</div>
          <div class="result-cell-value">${pair(levelShare(shares[k] ?? 0), `${(shares[k] ?? 0).toFixed(1)}%`)}</div>
          <div class="result-cell-note">${final.stats.counts[k]} 个节点</div>
        </div>`).join('')}
    </div>

    <div class="coverage-strip">
      ${state.circles.map((c) => `
        <span class="cov-pill" data-hit="${final.coverage.covered.includes(c.id)}">
          ${final.coverage.covered.includes(c.id) ? '✓' : '○'} ${c.name}
        </span>`).join('')}
    </div>

    <div class="score-bar">
      ${scoreRow('四圈覆盖', b.coverageScore, b.weights.coverage)}
      ${scoreRow('影响力占比', b.powerScore, b.weights.power)}
      ${scoreRow('时间留存', b.retentionScore, b.weights.retention)}
      ${scoreRow('破圈广度', b.breadthScore, b.weights.breadth)}
      ${b.penalty < 1 ? `<div class="score-row"><span class="score-name" style="color:var(--st-yellow)">覆盖不全惩罚</span><span class="score-track"></span><span class="score-val" style="color:var(--st-yellow)">${pair(penaltyWord(b.penalty), `×${b.penalty}`)}</span><span class="score-weight"></span></div>` : ''}
      <div class="score-row" style="margin-top:11px;padding-top:10px;border-top:1px solid var(--border)">
        <span class="score-name"><strong>终局得分</strong></span>
        <span class="score-track"></span>
        <span class="score-val" style="font-size:15px">${pair(level100(final.totalScore), final.totalScore)}</span>
        <span class="score-weight"></span>
      </div>
    </div>`;

  els.truthLine.textContent = `本局传闻的真相：${final.truth}`;
  const recap = document.createElement('p');
  recap.className = 'result-recap';
  recap.textContent = `${final.recapTitle || '本局复盘'}：${final.recap || ''}`;
  els.resultBody.appendChild(recap);
}

function scoreRow(name, value, weight) {
  return `
    <div class="score-row">
      <span class="score-name">${name}</span>
      <span class="score-track"><span class="score-fill" style="width:${Math.min(100, value)}%"></span></span>
      <span class="score-val">${pair(level100(value), value)}</span>
      <span class="score-weight">${pair(level100(weight * 100), `×${weight}`)}</span>
    </div>`;
}

// ─────────────────────────── 事件绑定 ───────────────────────────

function bindEvents() {
  els.sidePicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.side-option');
    if (btn) pickSide(btn.dataset.side);
  });

  els.btnStart.addEventListener('click', startGame);
  els.btnSubmit.addEventListener('click', submitTurn);
  els.btnPrecise.addEventListener('click', togglePrecise);
  els.btnAgain.addEventListener('click', () => {
    els.resultModal.hidden = true;
    els.startModal.hidden = false;
    sim = null;
    state = null;
    selected = [];
    submissions = {};
    cardAssignments = {};
    toneAssignments = {};
    activeTarget = null;
    els.settle.innerHTML = '<p class="empty">还没有提交过回合。</p>';
    els.log.innerHTML = '';
  });
  els.btnRestart.addEventListener('click', () => {
    if (state && !state.finished && !confirm('本局还没结束，确定要重新开局吗？')) return;
    els.resultModal.hidden = true;
    els.startModal.hidden = false;
  });

  els.canvas.addEventListener('mousemove', onMove);
  els.canvas.addEventListener('mouseleave', onLeave);
  els.canvas.addEventListener('click', onClick);

  // 空格键快速提交，方便连续操作
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !els.btnSubmit.disabled) {
      e.preventDefault();
      submitTurn();
    }
  });

  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!sim) return;
      resizeCanvas();
      sim.settle(stageSize().w, stageSize().h, 220);
      draw();
      renderChart();
    }, 140);
  };
  window.addEventListener('resize', onResize);
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(els.stage);
}

// ─────────────────────────── 小工具 ───────────────────────────

function hexA(hex, alpha) {
  const h = String(hex).trim();
  // 支持 #rgb / #rrggbb；CSS 变量里偶尔会带空格
  const m = h.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return h;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const num = parseInt(s, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function signed(v) {
  const n = Number(v || 0);
  return `${n > 0 ? '+' : ''}${n}`;
}

// ─────────────────────────── 启动 ───────────────────────────

boot();
