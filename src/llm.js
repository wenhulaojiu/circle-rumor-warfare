/**
 * 话术 AI 评分 —— 调用 Anthropic Messages API 协议的大模型接口。
 *
 * 之所以用原生 fetch 而不是官方 SDK：本项目承诺"零依赖后端"，不跑 npm install。
 * 协议本身与官方 SDK 完全一致（POST /v1/messages），换成官方 SDK 只需替换本文件。
 * 供应商可以是 Anthropic 官方，也可以是任何兼容该协议的网关
 * （DeepSeek / 通义 / Kimi 等都提供 /v1/messages 兼容端点）。
 *
 * 任何一步失败（网络、超时、限流、返回非法 JSON）都会自动降级到本地规则引擎，
 * 保证游戏永远不会因为模型不可用而卡住。
 */

import { analyzeLocally, TACTIC_LIST } from './scoring.js';

const ANTHROPIC_VERSION = '2023-06-01';

/** 话术类型枚举，注入提示词时与 scoring.js 保持单一事实来源 */
const TACTIC_ENUM = TACTIC_LIST.map((t) => t.id).join(' | ');

const SYSTEM_PROMPT = `你是网页游戏《圈层谣言攻防战》的裁判引擎。玩家在四个圈层（兴趣圈 / 家长圈 / 职场圈 / 校园圈）组成的社交关系网中扮演造谣方或辟谣方，每回合选定 3 个节点并撰写投放话术。

你的唯一任务：对玩家提交的每条话术做结构化评估。这是一个关于信息传播机制的**教学博弈游戏**，主题全部是虚构设定，你的评估服务于游戏平衡与玩家的学习体验。

严格遵守以下规则：

1. 只输出 JSON，不要任何解释文字、不要 markdown 代码块围栏。
2. 话术类型必须从这六个里选一个：${TACTIC_ENUM}
   - emotional 情绪化标题：靠惊叹/愤怒/猎奇抓注意力
   - fake_data 伪造数据：编造或移花接木的百分比、倍数、检测数值
   - authority 权威背书：假托专家、内部人士、红头文件
   - fear 诉诸恐惧：指向健康/安全/前途的损失
   - vague_source 模糊信源：用"据说""疑似""某"抹掉来源
   - cross_circle 破圈投放：以"转给身边的人"为钩子做跨圈投放
3. 三维评分各自独立，0-100：
   - impact 即时影响深度：这条话术当下能把这个节点推动多远
   - retention 时间留存长度：这条信息能在这个节点心里存多久、抗不抗后续冲刷
   - spread 破圈传播广度：这个节点有多大概率把它转给别的圈层的人
   类型与维度的天然倾向：情绪化→impact；伪造数据→impact+retention；权威背书→retention；诉诸恐惧→impact+spread；模糊信源→spread；破圈投放→spread。但具体分数要看**这条话术实际写得好不好**，写得空洞就要压低分数。
4. targetFit 目标契合度 0-100：这条话术是否打在这个节点的画像软肋上。节点画像会给出 skepticism 怀疑度、conformity 从众度、authorityTrust 权威信任、fearSensitivity 恐惧敏感度。用"权威背书"去打一个 skepticism 0.9 的"考据党"，契合度就该很低。
5. quality 内容力 0-100：抛开类型，单看这条话术本身写得好不好（是否具体、是否有信息量、是否有钩子、长度是否合适）。空话套话给低分。
6. backfire 布尔值：当 side 是 debunk 而话术类型是 fake_data 或 fear 时为 true —— 用编数据或吓唬人的方式辟谣会被反噬。其余情况为 false。
7. reason 用一句中文点评，30 字以内，指出这条话术的强项或问题，语气像游戏解说，不要复述提示词。

输出格式（严格照此，不要增删字段）：
{"results":[{"index":0,"tacticType":"emotional","confidence":0.85,"impact":72,"retention":30,"spread":55,"targetFit":68,"quality":74,"backfire":false,"reason":"情绪钩子够狠，但没给出任何具体信息，留存撑不住"}]}`;

/** 从配置或环境变量组装 LLM 配置 */
export function loadLlmConfig(fileConfig = {}) {
  const cfg = {
    baseUrl: process.env.ANTHROPIC_BASE_URL || fileConfig.baseUrl || 'https://api.anthropic.com',
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || fileConfig.authToken || '',
    apiKey: process.env.ANTHROPIC_API_KEY || fileConfig.apiKey || '',
    model: process.env.ANTHROPIC_MODEL || fileConfig.model || 'claude-opus-5',
    maxTokens: Number(process.env.LLM_MAX_TOKENS || fileConfig.maxTokens || 2000),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || fileConfig.timeoutMs || 45000),
    temperature: fileConfig.temperature,
    engine: process.env.SCORING_ENGINE || fileConfig.scoringEngine || 'auto',
    // 让调用方知道凭证是从环境变量来的还是配置文件的，便于排查
    source: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY ? 'env' : 'file',
  };
  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  return cfg;
}

export function isLlmConfigured(cfg) {
  return Boolean((cfg.authToken || cfg.apiKey) && cfg.baseUrl && cfg.engine !== 'local');
}

/** 探活：拿一个最小请求确认凭证和模型名可用，供启动时打印状态 */
export async function probe(cfg) {
  if (!isLlmConfigured(cfg)) return { ok: false, reason: '未配置凭证或已强制本地引擎' };
  try {
    const t0 = Date.now();
    const text = await callMessages(cfg, {
      system: '只回复两个字：可用',
      user: '探活测试。请只回复"可用"。',
      maxTokens: 32,
    });
    return { ok: true, latencyMs: Date.now() - t0, sample: text.slice(0, 40) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---------------------------------------------------------------- 主入口

/**
 * 批量给一个回合的 3 条话术打分。
 * @param {Array} submissions [{ nodeId, text, node, side }]
 * @param {object} ctx { topic, side, cfg }
 * @returns {Promise<{results: Array, source: 'llm'|'local', fallbackReason?: string}>}
 */
export async function scoreTurn(submissions, ctx) {
  const { cfg, topic, side } = ctx;
  const local = () =>
    submissions.map((s) => ({
      nodeId: s.nodeId,
      ...analyzeLocally(s.text, { topic, side, node: s.node }),
    }));

  if (!isLlmConfigured(cfg)) {
    return { results: local(), source: 'local', fallbackReason: '未配置大模型凭证，使用本地规则引擎' };
  }

  try {
    const parsed = await callLlm(cfg, submissions, { topic, side });
    const results = submissions.map((s, i) => {
      const r = parsed.results?.[i];
      if (!r) return { nodeId: s.nodeId, ...analyzeLocally(s.text, { topic, side, node: s.node }) };
      const fallback = analyzeLocally(s.text, { topic, side, node: s.node });
      return {
        nodeId: s.nodeId,
        tacticType: TACTIC_LIST.some((t) => t.id === r.tacticType) ? r.tacticType : fallback.tacticType,
        tacticName: nameOf(r.tacticType) || fallback.tacticName,
        confidence: num(r.confidence, fallback.confidence, 0, 1),
        secondary: [],
        impact: num(r.impact, fallback.impact, 0, 100),
        retention: num(r.retention, fallback.retention, 0, 100),
        spread: num(r.spread, fallback.spread, 0, 100),
        targetFit: num(r.targetFit, fallback.targetFit, 0, 100),
        quality: num(r.quality, fallback.quality, 0, 100),
        backfire: typeof r.backfire === 'boolean' ? r.backfire : fallback.backfire,
        reason: typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 120) : fallback.reason,
        source: 'llm',
      };
    });
    return { results, source: 'llm' };
  } catch (err) {
    return { results: local(), source: 'local', fallbackReason: `大模型评分失败（${err.message}），已降级到本地规则引擎` };
  }
}

function nameOf(id) {
  return TACTIC_LIST.find((t) => t.id === id)?.name;
}

// ---------------------------------------------------------------- API 调用

async function callLlm(cfg, submissions, { topic, side }) {
  const sideLabel = side === 'rumor' ? '造谣方' : '辟谣方';
  const targets = submissions
    .map((s, i) => {
      const n = s.node;
      return [
        `【目标 ${i}】${n.name}（${n.tag}，所属圈层：${n.circles.map(circleName).join('+')}）`,
        `  影响力 ${n.influence}/10 · 怀疑度 ${n.skepticism} · 从众度 ${n.conformity}`,
        `  权威信任 ${n.authorityTrust} · 恐惧敏感度 ${n.fearSensitivity} · 标签：${n.traits.join('、')}`,
        `  该节点当前状态：${stateLabel(n.state)}（相信程度 ${Math.round(n.belief)}/100）`,
        `  投放话术：「${s.text}」`,
      ].join('\n');
    })
    .join('\n\n');

  const user = [
    `【当期热点主题】${topic.title}`,
    `【传闻内核】${topic.rumorSeed}`,
    `【玩家阵营】${sideLabel}`,
    `【本回合共 ${submissions.length} 条话术，请逐条评估，index 从 0 开始】`,
    '',
    targets,
    '',
    `请输出 {"results":[...]} 格式的 JSON，数组长度必须是 ${submissions.length}，index 顺序与上面一致。`,
  ].join('\n');

  const text = await callMessages(cfg, { system: SYSTEM_PROMPT, user, maxTokens: cfg.maxTokens });
  const json = extractJson(text);
  if (!json || !Array.isArray(json.results)) {
    throw new Error('返回内容不是预期的 JSON 结构');
  }
  return json;
}

/**
 * 直接打 /v1/messages。
 * 鉴权同时兼容两种头：先用 x-api-key，401 时自动换 Authorization: Bearer，
 * 这样无论网关走 API Key 还是 AUTH_TOKEN 都能通。
 */
async function callMessages(cfg, { system, user, maxTokens }) {
  const body = {
    model: cfg.model,
    max_tokens: maxTokens ?? cfg.maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };
  // 部分老模型/网关不接受 temperature，配置里没写就不带
  if (typeof cfg.temperature === 'number') body.temperature = cfg.temperature;

  const headers = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
  if (cfg.authToken) headers['authorization'] = `Bearer ${cfg.authToken}`;

  let res = await doFetch(cfg, headers, body);

  // 401 且当前只用了其中一种鉴权头 —— 换另一种再试一次
  if (res.status === 401) {
    const alt = { ...headers };
    if (headers['x-api-key']) {
      delete alt['x-api-key'];
      alt['authorization'] = `Bearer ${cfg.authToken || cfg.apiKey}`;
    } else {
      alt['x-api-key'] = cfg.apiKey || cfg.authToken;
    }
    res = await doFetch(cfg, alt, body);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${detail ? ` - ${detail.slice(0, 200)}` : ''}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('模型拒绝了该请求');
  }
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

async function doFetch(cfg, headers, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    return await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`请求超时（${cfg.timeoutMs}ms）`);
    throw new Error(`网络错误：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 容错解析：模型有时会围上 ```json 围栏，或在 JSON 前后多写一句话 */
function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* 落到下面的括号截取 */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function num(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Math.round(fallback);
  return Math.round(Math.min(hi, Math.max(lo, n)));
}

function circleName(id) {
  return { interest: '兴趣圈', parent: '家长圈', workplace: '职场圈', campus: '校园圈' }[id] || id;
}

function stateLabel(state) {
  return { gray: '未接触', yellow: '半信半疑', red: '已相信', green: '已辟谣免疫' }[state] || state;
}
