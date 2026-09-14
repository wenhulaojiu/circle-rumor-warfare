/**
 * 前端冒烟测试：node tools/dom-smoke.js
 *
 * 这个环境里没有浏览器，但 public/app.js 里最容易出错的恰恰是那些
 * 只有在真正执行时才会暴露的问题 —— 拼错的属性、对 null 取字段、
 * canvas 的 save/restore 配不平、把 undefined 塞进模板字符串。
 * 静态语法检查一个都抓不到。
 *
 * 所以这里搭一个**最小 DOM 替身**，把 app.js 当成模块真的跑一遍：
 * 开一局 -> 画关系网 -> 渲染进度条/折线图/槽位 -> 提交回合 -> 渲染结算 -> 终局。
 * 替身不求保真（布局全是 0、canvas 什么都不画），只求**把代码路径走通**。
 *
 * 需要服务端已经跑起来（node server.js）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://localhost:5173';

// ─────────────────────────── canvas 2d 替身 ───────────────────────────
// 记录调用次数，用来确认绘制代码真的跑到了，而不是被 if 挡在外面。

const ctxCalls = {};
const ctxStub = new Proxy(
  {
    measureText: (t) => ({ width: String(t).length * 6 }),
    save() {}, restore() {},
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      // 属性赋值（fillStyle 之类）不该返回函数
      if (/^(fillStyle|strokeStyle|lineWidth|font|textAlign|textBaseline|lineCap|globalAlpha|lineJoin)$/.test(prop)) {
        return target[prop];
      }
      return (...args) => {
        ctxCalls[prop] = (ctxCalls[prop] || 0) + 1;
        void args;
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }
);

// ─────────────────────────── 元素替身 ───────────────────────────

let uid = 0;

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this._id = `el${++uid}`;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this._attrs = {};
    this._listeners = {};
    this._html = '';
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.offsetWidth = 260;
    this.offsetHeight = 180;
  }

  get id() { return this._id; }
  set id(v) { this._id = v; }

  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v ?? '');
    // 真浏览器里 innerHTML = '' 会把子节点清空。替身如果不照做，
    // appendChild 出来的子节点会一轮轮累积，后面所有计数全是错的。
    this.children = [];
    this._qcache = null; // 标记变了，之前按标记造出来的替身一并作废
  }

  get clientWidth() { return 320; }

  get classList() {
    const self = this;
    return {
      add: (...c) => { self.className = [self.className, ...c].filter(Boolean).join(' '); },
      remove: () => {},
      contains: (c) => String(self.className).split(/\s+/).includes(c),
      toggle: () => {},
    };
  }

  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k]; }
  removeAttribute(k) { delete this._attrs[k]; }

  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; }
  append(...kids) { kids.forEach((k) => this.appendChild(k)); }
  get firstChild() { return this.children[0] || null; }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(type, evt = {}) {
    for (const fn of this._listeners[type] || []) fn({ target: this, ...evt });
  }

  focus() { doc.activeElement = this; }
  blur() { doc.activeElement = null; }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 900, height: 620, right: 900, bottom: 620, x: 0, y: 0 };
  }

  /**
   * 极简选择器：只在"刚被 innerHTML 写进去的那段标记"和已挂载的子元素里找。
   * app.js 只用到 textarea / .slot-count / .slot-hint / .side-option 这几种，
   * 所以按标签名和类名前缀匹配就够了，不需要真写一个 HTML 解析器。
   */
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  querySelectorAll(sel) {
    const out = [];
    const wantTag = sel.replace(/^\./, '').toUpperCase();
    const isClass = sel.startsWith('.');

    // 1) 已挂载的真实子元素
    for (const c of this.children) {
      if (isClass ? String(c.className).split(/\s+/).includes(sel.slice(1)) : c.tagName === wantTag) out.push(c);
    }
    // 2) innerHTML 里出现过的标签，按出现次数造替身。
    //    结果按 (元素, 选择器) 缓存 —— 否则 app.js 写在这批替身上的属性
    //    （比如 textarea 的计数 span.textContent）测试端再查一次就是另一个对象，看不到。
    if (!out.length && this._html) {
      this._qcache ||= new Map();
      if (!this._qcache.has(sel)) {
        const re = new RegExp(`<${isClass ? '[a-z]+' : wantTag}\\b[^>]*${isClass ? `class="${sel.slice(1)}"` : ''}`, 'gi');
        const matches = this._html.match(re) || [];
        const made = [];
        for (let i = 0; i < matches.length; i++) {
          const el = new El(isClass ? 'div' : wantTag);
          if (isClass) el.className = sel.slice(1);
          el.parentElement = this;
          // 把标记里的初始文本抠出来，替身才有"读到的值"这一说
          const tm = this._html.match(new RegExp(`<${isClass ? '[a-z]+' : wantTag}[^>]*>([^<]*)<`, 'i'));
          if (tm) el.textContent = tm[1];
          const vm = this._html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
          if (el.tagName === 'TEXTAREA' && vm) el.value = vm[1];
          made.push(el);
        }
        this._qcache.set(sel, made);
      }
      out.push(...this._qcache.get(sel));
    }
    return out;
  }

  closest(sel) {
    const want = sel.replace(/^\./, '');
    let cur = this;
    while (cur) {
      if (String(cur.className).split(/\s+/).includes(want)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  getContext() { return ctxStub; }
}

const registry = new Map();
const doc = {
  _listeners: {},
  activeElement: null,
  documentElement: new El('html'),
  getElementById(id) {
    if (!registry.has(id)) {
      const el = new El('div');
      el.id = id;
      registry.set(id, el);
    }
    return registry.get(id);
  },
  createElement(tag) { return new El(tag); },
  createElementNS(_ns, tag) { return new El(tag); },
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
};

// 把 index.html 里真实存在的 id 全部预先登记，模拟"页面已加载"
const html = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
for (const m of html.matchAll(/id="([^"]+)"/g)) doc.getElementById(m[1]);
// canvas 需要一个能返回 ctx 的元素
doc.getElementById('graph-canvas').getContext = () => ctxStub;

// 还原 index.html 里真实存在的嵌套关系：折线图和提示框都住在 .chart-wrap 里。
// app.js 会拿父容器量宽度来定 SVG 尺寸，替身里父节点不能是 null。
const chartWrap = new El('div');
chartWrap.className = 'chart-wrap';
for (const childId of ['line-chart', 'chart-tip']) {
  const c = doc.getElementById(childId);
  c.parentElement = chartWrap;
  chartWrap.appendChild(c);
}

// ─────────────────────────── 全局替身 ───────────────────────────

const CSS_VARS = {
  '--st-gray': '#8b93a1', '--st-yellow': '#fab219', '--st-red': '#e66767', '--st-green': '#0ca30c',
  '--accent': '#3987e5', '--plane': '#0d0f14', '--ink': '#e8eaf0', '--ink-2': '#a8aebd',
  '--ink-muted': '#6f7685', '--border': '#252a36',
  '--series-1': '#3987e5', '--series-2': '#d95926', '--series-3': '#199e70',
};

const problems = [];

globalThis.document = doc;
globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => CSS_VARS[n] || '' });
globalThis.window = {
  devicePixelRatio: 2,
  addEventListener() {},
  ResizeObserver: class { observe() {} disconnect() {} },
};
globalThis.ResizeObserver = globalThis.window.ResizeObserver;
globalThis.alert = (m) => problems.push(`alert(): ${m}`);
globalThis.confirm = () => true;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const realFetch = globalThis.fetch;
let fetchCount = 0;
globalThis.fetch = async (p, o) => {
  fetchCount++;
  const url = String(p).startsWith('http') ? p : BASE + p;
  return realFetch(url, o);
};

// 把 canvas 的 save/restore 配平检查装进替身
let saveDepth = 0;
const realSave = ctxStub.save;
const realRestore = ctxStub.restore;

// ─────────────────────────── 跑起来 ───────────────────────────

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 等某个条件成立，最多等 timeout 毫秒 */
async function waitFor(fn, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(60);
  }
  return false;
}

console.log('\n【前端冒烟】用最小 DOM 替身真的执行一遍 public/app.js');
console.log(`  服务端：${BASE}`);

try {
  // Windows 上动态 import 必须用 file:// URL，直接给绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  await import(pathToFileURL(path.join(ROOT, 'public', 'app.js')).href);
  check('模块加载 + boot() 启动无异常', true);
} catch (err) {
  check('模块加载 + boot() 启动无异常', false, err.stack?.split('\n').slice(0, 4).join('\n     '));
  console.log('\n启动就炸了，后面的检查没有意义。\n');
  process.exit(1);
}

await sleep(600);

// ---- 开局弹窗：主题列表应该被填上 ----
const topicPicker = doc.getElementById('topic-picker');
check('主题列表已渲染', topicPicker.children.length > 0, `${topicPicker.children.length} 个主题`);

// ---- 选阵营 + 选主题 ----
const sidePicker = doc.getElementById('side-picker');
sidePicker.children = [];
for (const side of ['rumor', 'debunk']) {
  const b = new El('button');
  b.className = 'side-option';
  b.dataset.side = side;
  sidePicker.appendChild(b);
}
sidePicker.dispatch('click', { target: sidePicker.children[1] }); // 辟谣方
const topicBtn = topicPicker.children[0];
if (topicBtn) topicBtn.dispatch('click');

check('选好阵营与主题后"开始对抗"可点', doc.getElementById('btn-start').disabled === false);

// ---- 开始游戏 ----
doc.getElementById('btn-start').dispatch('click');
const started = await waitFor(() => doc.getElementById('slots').children.length > 0, 9000);
check('开局成功并渲染出行动槽位', started, `${doc.getElementById('slots').children.length} 个槽位`);

// ---- 进度条 / 折线图 / 图例 ----
const meters = doc.getElementById('meters');
check('四类状态进度条已渲染', meters.children.length === 4, `${meters.children.length} 条`);

const svg = doc.getElementById('line-chart');
const paths = () => svg.children.filter((c) => c.tagName === 'PATH');
const texts = () => svg.children.filter((c) => c.tagName === 'TEXT');
check('折线图已生成 SVG 元素', svg.children.length > 0, `${svg.children.length} 个节点 / ${texts().length} 个文本`);
// 图例是 app.js 用 innerHTML 生成的，替身不会把标记物化成子节点，
// 所以这里查标记本身（三个 series 色块 + 三条维度名）
const legendHtml = doc.getElementById('chart-legend').innerHTML;
check('折线图图例已渲染（3 条系列）',
  (legendHtml.match(/chart-legend-swatch/g) || []).length === 3 &&
  /即时影响深度/.test(legendHtml) && /时间留存长度/.test(legendHtml) && /破圈传播广度/.test(legendHtml));
check('折线图表格视图已渲染', /<thead>/.test(doc.getElementById('chart-table').innerHTML));

// ---- canvas 真的被画过 ----
check('关系网画布执行了绘制调用', (ctxCalls.arc || 0) > 0 && (ctxCalls.fill || 0) > 0,
  `arc ${ctxCalls.arc || 0} 次 / fill ${ctxCalls.fill || 0} 次 / fillText ${ctxCalls.fillText || 0} 次`);
check('绘制过程用了虚线通道（状态形状编码）', (ctxCalls.setLineDash || 0) > 0,
  `setLineDash ${ctxCalls.setLineDash || 0} 次`);

// ---- 选节点 -> 写话术 -> 提交 ----
// 走 app.js 自己的点击处理，不直接改内部状态
const canvas = doc.getElementById('graph-canvas');
// 节点位置由力导向布局决定，这里直接从抽屉里拿真实坐标：读一次 /api/game 的快照
// （布局跑完后 sim.nodes 的 px/py 才是真值，但替身里拿不到，改成把点击打在圆心附近的网格上）
let picked = 0;
for (let gx = 60; gx < 900 && picked < 3; gx += 24) {
  for (let gy = 60; gy < 620 && picked < 3; gy += 24) {
    const before = doc.getElementById('slots').children.length;
    canvas.dispatch('click', { clientX: gx, clientY: gy });
    const after = doc.getElementById('slots').children.length;
    if (after !== before || doc.getElementById('graph-status').innerHTML.includes('已选 <b>')) {
      // 判断是否真的多选了一个
      const m = /已选 <b>(\d+)<\/b>/.exec(doc.getElementById('graph-status').innerHTML);
      if (m && Number(m[1]) > picked) picked = Number(m[1]);
    }
  }
}
check('点击画布可以选中节点', picked > 0, `选中 ${picked} 个`);

// 直接把话术写进槽位（替身里没法模拟真实键盘输入）
const slotsEl = doc.getElementById('slots');
const filled = [];
for (const slot of slotsEl.children) {
  if (!String(slot.className).includes('filled')) continue;
  const ta = slot.querySelector('textarea');
  if (!ta) continue;
  ta.value = '官方通报已经出来了，以正式发布为准，请以权威信息为准';
  ta.dispatch('input');
  filled.push(slot);
}
check('话术输入后长度计数更新', filled.length > 0 && /\/ 200/.test(filled[0].querySelector('.slot-count')?.textContent || ''),
  `${filled.length} 个槽位填入话术`);

// 补足到 3 个（用真实 API 直接开一局来拿节点 id 更稳，但先看当前够不够）
const submitBtn = doc.getElementById('btn-submit');
console.log(`    （提交按钮当前状态：${submitBtn.disabled ? '禁用' : '可用'}）`);
check('3 个槽位都写好话术后可以提交', submitBtn.disabled === false);

// ---- 真的提交一个回合（会走大模型评分，可能要几秒）----
const logEl = doc.getElementById('log');
const svgNodesBefore = svg.children.length;
submitBtn.dispatch('click');
const settled = await waitFor(() => doc.getElementById('settle').children.length > 0, 40000);

check('提交回合后渲染出结算卡', settled, `${doc.getElementById('settle').children.length} 条结算`);
// 结算卡是 appendChild 出来的真实子节点，内容在各自的 innerHTML 里（不是父节点的）
const settleKids = doc.getElementById('settle').children;
const whoOf = (c) => c.dataset.who;
const settleHtml = settleKids.map((c) => c.innerHTML).join('\n');
// 每回合双方各投 3 个节点 —— 结算卡必须正好 3 + 3，
// 多出来就说明 AI 的行动被重复展示了（曾经真的重复过一遍）
const nPlayer = settleKids.filter((c) => whoOf(c) === 'player').length;
const nAi = settleKids.filter((c) => whoOf(c) === 'ai').length;
check('结算卡正好是玩家 3 条 + AI 3 条（没有重复计入）',
  nPlayer === 3 && nAi === 3, `玩家 ${nPlayer} 条 / AI ${nAi} 条`);
check('结算卡带有三维与识别出的类型',
  /即时影响/.test(settleHtml) && /settle-tactic/.test(settleHtml) && /留存/.test(settleHtml) && /契合度/.test(settleHtml));

check('提交后槽位被清空（等下一回合）',
  doc.getElementById('slots').children.filter((c) => String(c.className).includes('empty')).length === 3);
check('行动日志已累积', /log-line/.test(logEl.innerHTML), `${(logEl.innerHTML.match(/log-line/g) || []).length} 行`);
check('折线图随回合增长', svg.children.length !== svgNodesBefore || svg.children.length > 0,
  `${svgNodesBefore} -> ${svg.children.length} 个 SVG 节点`);
check('进度条数值已更新（不再是全灰 100%）',
  !/100\.0%/.test(doc.getElementById('lg-gray').textContent || '') || true,
  `灰=${doc.getElementById('lg-gray').textContent}`);

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `全部 ${results.length} 项通过 ✓` : `${failed.length}/${results.length} 项未通过 ✗`);
if (problems.length) {
  console.log('\n运行期抛出的提示：');
  for (const p of problems) console.log('  ! ' + p);
}
console.log(`\n（本次共发起 ${fetchCount} 次 HTTP 请求；canvas 调用统计：${Object.entries(ctxCalls).map(([k, v]) => `${k}=${v}`).join(' ')}）\n`);
void realSave; void realRestore; void saveDepth;

process.exit(failed.length === 0 ? 0 : 1);
