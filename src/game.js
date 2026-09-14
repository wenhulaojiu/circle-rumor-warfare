/**
 * 游戏状态机：回合结算、传播扩散、最终计分。
 *
 * 服务端是唯一权威 —— 前端只提交"选了哪 3 个节点 + 写了什么话术"，
 * 所有数值计算都在这里完成，前端拿到的永远是一份算好的状态快照。
 *
 * 单个回合的结算顺序：
 *   1. 校验玩家提交
 *   2. 玩家话术送 LLM 评分（失败自动降级本地规则）
 *   3. AI 对手行动
 *   4. 双侧同时生效（同一回合内不分先后，保证公平）
 *   5. 按连接关系扩散一阶
 *   6. 自然衰减（留存度越高衰减越慢）
 *   7. 重算节点状态色、记录快照
 *   8. 触发中局事件 / 判定终局
 */

import { makeRng, clamp } from './rng.js';
import { buildNetwork, CIRCLES } from './network.js';
import { scoreTurn } from './llm.js';
import { analyzeLocally, pickAiTactic, AI_TEMPLATES, renderAiTemplate, TACTICS } from './scoring.js';
import { getTopic, MIDGAME_EVENTS } from './topics.js';

export const TOTAL_ROUNDS = 5;
export const NODES_PER_TURN = 3;

// ---- 结算系数（集中在这里，方便手感调优）----
export const K = {
  RUMOR_BASE: 96, // 五回合模式下适度降低滚雪球速度，给辟谣方留下回应窗口
  DEBUNK_BASE: 66, // 五回合模式下略微提高回应能力，但仍不会一张卡清空目标
  PROP_RATE: 0.32, // 每回合向外扩散的比例（量纲：相信度 100 的节点给每个邻居推多少点）
  IMMUNE_PUSH: 0.05, // 免疫节点向邻居施加的"免疫压力"
  BASE_DECAY: 3.5, // 每回合信念自然衰减基准
  RETENTION_SHELTER: 0.78, // 留存度能抵消多少衰减（0.78 = 最多抵消 78%）
  RETENTION_FADE: 0.85, // 节点留存度自身的每回合衰减
  IMMUNE_SPREAD_SHIELD: 0.12, // 免疫节点被再次造谣时的抵抗力（0.12 = 只剩 12% 效果）
  BACKFIRE_MUL: 0.68, // 反噬后该节点对辟谣话术的接受度折扣
  DEBUNK_EVIDENCE_RANGE: 0.05, // 证据可信度只允许在基础辟谣强度上下浮动 5%，避免改变既有平衡
  RED_THRESHOLD: 55, // 相信度达到多少算"已相信"
  YELLOW_THRESHOLD: 10, // 相信度达到多少算"半信半疑"

  /**
   * 免疫的持有回合数。
   *
   * 这是让两边真正势均力敌的关键：如果免疫是永久状态，绿色就是个吸收态 ——
   * 一旦某个节点变绿，它会免费地、每回合不停地向邻居施加免疫压力，
   * 而谣言方的信念却在自然衰减。实测下来绿色会稳定涨到 90%，造谣方必输。
   *
   * 所以免疫改成"有保质期"的：到期没被继续投入，节点会重新滑回半信半疑。
   * 辟谣方因此必须持续守住阵地，而不是一次性刷完就躺着赢。
   *
   * 持有时间 = 基础值 + 留存度加成。这条规则给了"时间留存"这个维度
   * 在辟谣侧的真实作用：权威背书这类高留存话术的即时冲击力弱（打不下来信念），
   * 但一旦把节点打下去了，能守住很久；情绪化这类高冲击话术打得快，守不住。
   * 否则辟谣方的最优解永远是刷高 impact 的话术，留存维度形同虚设。
   */
  IMMUNE_HOLD_DIRECT: 1, // 直接辟谣的基础持有回合
  IMMUNE_HOLD_RETENTION: 4, // 留存度 100 时额外增加的持有回合（合计最多 5 回合）
  IMMUNE_HOLD_SPREAD: 2, // 靠扩散被动变绿只有固定的短保质期
  IMMUNE_RELAPSE_BELIEF: 14, // 免疫失效后回落到的相信度（落在黄色区间）
};

export class Game {
  constructor({ seed, topicId, playerSide, mode = 'standard', aiStyle }) {
    this.id = seed;
    this.topic = getTopic(topicId);
    this.playerSide = playerSide === 'debunk' ? 'debunk' : 'rumor';
    this.aiSide = this.playerSide === 'rumor' ? 'debunk' : 'rumor';
    this.round = 1;
    this.mode = mode === 'quick' ? 'quick' : 'standard';
    this.totalRounds = this.mode === 'quick' ? 3 : TOTAL_ROUNDS;
    this.rng = makeRng(seed + ':' + this.topic.id + ':' + this.playerSide);
    this.net = buildNetwork(seed + ':' + this.topic.id, this.topic);

    // 易感系数是可变的：中局事件会改它
    this.susceptibility = { ...this.topic.susceptibility };

    this.log = [];
    this.history = [];
    this.usedThisTurn = [];
    this.finished = false;
    this.finalResult = null;
    this.llmNotes = [];
    this.actionCards = this.makeActionCards();
    this.goals = this.makeGoals();
    this.chainStreak = 0;
    this.lastAiIntent = '正在观察关系网';
    this.aiStyle = aiStyle || ['aggressive', 'steady', 'counter'][Math.floor(this.rng() * 3)];
    this.factQuiz = null;
    this.pendingEvent = null;

    for (const n of this.net.nodes) {
      n.playerMark = 0; // 玩家影响力是否触及过这个节点（含扩散）
      n.backfire = false;
      n.aiMark = 0;
      n.immuneHold = 0; // 免疫剩余可持有回合数，见 K.IMMUNE_HOLD_DIRECT 的说明
    }

    this.pushLog('system', `热点主题已锁定：${this.topic.title}`);
    this.pushLog(
      'system',
      this.playerSide === 'rumor'
        ? '你扮演【造谣方】。目标：让四个圈层尽可能多的人相信这条传闻。'
        : '你扮演【辟谣方】。目标：让四个圈层尽可能多的人对这条传闻免疫。'
    );
    this.snapshot();
  }

  // ------------------------------------------------------------ 查询

  get nodeById() {
    return this.net.nodeById;
  }

  /** 当前回合可选的节点：排除本回合已用掉的 */
  selectableNodes() {
    return this.net.nodes.filter((n) => !this.usedThisTurn.includes(n.id));
  }

  /** 给前端的完整状态快照 */
  getState() {
    const stats = this.computeStats();
    return {
      gameId: this.id,
      round: this.round,
      totalRounds: this.totalRounds,
      mode: this.mode,
      aiStyle: this.aiStyle,
      nodesPerTurn: NODES_PER_TURN,
      playerSide: this.playerSide,
      aiSide: this.aiSide,
      topic: {
        id: this.topic.id,
        title: this.topic.title,
        brief: this.topic.brief,
        rumorSeed: this.topic.rumorSeed,
        truth: this.playerSide === 'rumor' || this.finished ? this.topic.truth : null,
        taskLead: this.playerSide === 'rumor'
          ? `已知事实：${this.topic.truth}`
          : `待辟谣传闻：${this.topic.rumorSeed}`,
        sourceLabel: this.topic.sourceLabel,
        evidence: this.topic.evidence,
        riskLevel: this.topic.riskLevel,
      },
      actionCards: this.actionCards,
      recommendedTargets: this.recommendedTargets(),
      goals: this.goals,
      chainStreak: this.chainStreak,
      aiIntent: this.lastAiIntent,
      pendingEvent: this.pendingEvent,
      factQuiz: this.factQuiz,
      circles: CIRCLES,
      circleRadius: this.net.circleRadius,
      susceptibility: this.susceptibility,
      nodes: this.net.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        tag: n.tag,
        circles: n.circles,
        primaryCircle: n.primaryCircle,
        influence: n.influence,
        skepticism: n.skepticism,
        conformity: n.conformity,
        authorityTrust: n.authorityTrust,
        fearSensitivity: n.fearSensitivity,
        traits: n.traits,
        x: n.x,
        y: n.y,
        state: n.state,
        belief: Math.round(n.belief),
        touched: n.touched,
        immune: n.immune,
        immuneHold: n.immuneHold,
        retention: Math.round(n.retention),
        lastTactic: n.lastTactic,
        lastDelta: Math.round(n.lastDelta),
        playerMark: Math.round(n.playerMark * 100) / 100,
      })),
      edges: this.net.edges,
      usedThisTurn: this.usedThisTurn,
      history: this.history,
      stats,
      log: this.log.slice(-40),
      finished: this.finished,
      finalResult: this.finalResult,
      llmNotes: this.llmNotes.slice(-3),
    };
  }

  // ------------------------------------------------------------ 回合

  /**
   * 结算一个回合。
   * @param {Array<{nodeId:string, text:string}>} submissions 恰好 3 条
   */
  async playTurn(submissions, cfg, eventChoice = null) {
    if (this.finished) throw new HttpError(400, '本局已结束，无法继续投放');

    const clean = this.validate(submissions);
    if (this.pendingEvent && eventChoice) this.resolveEvent(eventChoice);
    if (this.factQuiz && submissions.quizAnswer) this.resolveFactQuiz(submissions.quizAnswer);

    // ---- 1. 玩家话术评分（LLM，失败自动降级）----
    const scored = await scoreTurn(
      clean.map((s) => ({ ...s, node: this.nodeById[s.nodeId], side: this.playerSide })),
      { topic: this.topic, side: this.playerSide, cfg }
    );
    if (scored.fallbackReason) {
      this.llmNotes.push(scored.fallbackReason);
    } else {
      this.llmNotes.push(`本回合话术由大模型评分（${cfg.model}）`);
    }

    const playerActions = clean.map((s, i) => ({
      ...applyTone(scored.results[i], s.tone),
      nodeId: s.nodeId,
      text: s.text,
      tone: s.tone,
      side: this.playerSide,
    }));

    // ---- 2. AI 对手行动 ----
    const aiActions = this.aiAct();

    // ---- 3. 双侧同时生效 ----
    for (const a of [...playerActions, ...aiActions]) {
      a.appliedDelta = this.applyAction(a);
    }

    // ---- 4. 扩散 ----
    const spreadChanges = this.propagate();

    // ---- 5. 衰减 ----
    const decayChanges = this.decay();

    // ---- 6. 重算状态 + 快照 ----
    this.refreshStates();
    const roundLog = this.describeRound(playerActions, aiActions, spreadChanges, decayChanges);
    this.updateGoals(playerActions);

    this.usedThisTurn = [];
    this.snapshot();

    // ---- 7. 中局事件 / 终局判定 ----
    const evt = this.maybeFireMidgameEvent();
    if (this.playerSide === 'debunk' && this.round === 2 && !this.factQuiz && !this.finished) {
      this.factQuiz = { question: '核查这条传闻时，第一步最值得确认什么？', options: [
        { id: 'source', label: '原始来源和发布时间' },
        { id: 'count', label: '转发数量' },
        { id: 'emotion', label: '评论区情绪' },
      ], answer: 'source' };
    }
    if (this.round >= this.totalRounds) {
      this.finish();
    } else {
      this.round += 1;
      this.usedThisTurn = [];
      this.actionCards = this.makeActionCards();
    }

    return {
      playerActions,
      aiActions,
      roundLog,
      event: evt,
      scoringSource: scored.source,
      state: this.getState(),
    };
  }

  /** 校验玩家提交：数量、节点合法性、重复、话术非空 */
  validate(submissions) {
    if (!Array.isArray(submissions) || submissions.length !== NODES_PER_TURN) {
      throw new HttpError(400, `每回合必须选择 ${NODES_PER_TURN} 个节点`);
    }
    const seen = new Set();
    const seenCards = new Set();
    return submissions.map((s) => {
      const node = this.nodeById[s?.nodeId];
      if (!node) throw new HttpError(400, `节点不存在：${s?.nodeId}`);
      if (this.usedThisTurn.includes(s.nodeId)) {
        throw new HttpError(400, `节点「${node.name}」本回合已经投放过`);
      }
      if (seen.has(s.nodeId)) throw new HttpError(400, `节点「${node.name}」被重复选择`);
      seen.add(s.nodeId);
      const card = this.actionCards.find((c) => c.id === s?.cardId);
      if (!card) throw new HttpError(400, '行动内容不存在或已经过期');
      if (seenCards.has(card.id)) throw new HttpError(400, '每张行动卡每回合只能使用一次');
      seenCards.add(card.id);
      const text = String(s.text ?? '').trim();
      if (!text) throw new HttpError(400, `节点「${node.name}」还没有写话术`);
      if (text !== card.text) throw new HttpError(400, '请使用本回合提供的行动内容');
      if (text.length > 400) throw new HttpError(400, `节点「${node.name}」的话术超过 400 字`);
      this.usedThisTurn.push(s.nodeId);
      const tone = ['calm', 'normal', 'bold'].includes(s?.tone) ? s.tone : 'normal';
      return { nodeId: s.nodeId, text, cardId: card.id, tone };
    });
  }

  makeGoals() {
    const debunk = this.playerSide === 'debunk';
    return [
      { id: 'coverage', label: debunk ? '守住 3 个圈层' : '触达 3 个圈层', target: 3, done: false },
      { id: 'bridge', label: debunk ? '保护 2 个桥接节点' : '控制 2 个桥接节点', target: 2, done: false },
    ];
  }

  updateGoals(actions = []) {
    const cov = this.coverage();
    const bridges = this.net.nodes.filter((n) => n.playerMark > 0 && n.circles.length > 1).length;
    this.goals[0].value = cov.count;
    this.goals[1].value = bridges;
    this.goals[0].done = cov.count >= this.goals[0].target;
    this.goals[1].done = bridges >= this.goals[1].target;
    const strong = actions.filter((a) => (a.targetFit || 0) >= 70).length;
    this.chainStreak = strong >= 2 ? this.chainStreak + 1 : 0;
  }

  /** 每个小回合给玩家三张阵营内容卡；编号带回合，旧卡不能跨回合复用。 */
  makeActionCards() {
    const rumor = [
      `有人爆料：${this.topic.rumorSeed}，这件事正在被压热度，提醒身边的人留意。`,
      `网传消息称${this.topic.rumorSeed}，相关截图已经在多个群里出现，大家怎么看？`,
      `如果${this.topic.rumorSeed}是真的，影响可能比想象中更大，建议转给可能受影响的人。`,
    ];
    const debunk = [
      `先别急着转发。已知事实是：${this.topic.truth} 原传闻缺少能够相互印证的证据。`,
      `核查这条传闻时应对照原始材料、发布时间和完整上下文。目前可确认：${this.topic.debunkSeed}。`,
      `仅引用“权威消息”并不足以完成辟谣。可验证的事实是：${this.topic.truth} 请同时查看证据是否直接对应原说法。`,
    ];
    const source = this.playerSide === 'rumor' ? rumor : debunk;
    const offset = (this.round - 1) % source.length;
    return source.map((_, i) => {
      const n = (i + offset) % source.length;
      const kinds = this.playerSide === 'rumor'
        ? ['情绪刺激', '模糊来源', '恐惧扩散']
        : ['事实核查', '上下文补充', '证据对照'];
      return { id: `r${this.round}c${i + 1}`, label: kinds[i], kind: kinds[i], text: source[n] };
    });
  }

  /** 把一条已评分的话术作用到目标节点上 */
  applyAction(action) {
    const node = this.nodeById[action.nodeId];
    if (!node) return 0;
    const before = node.belief;

    const susc = this.suscOf(node);
    const fitMul = 0.6 + 0.4 * (action.targetFit / 100);

    if (action.side === 'rumor') {
      // 造谣：怀疑度抵抗，但免疫节点几乎打不动
      const shield = node.immune ? K.IMMUNE_SPREAD_SHIELD : 1;
      const power = (action.impact / 100) * K.RUMOR_BASE * susc * fitMul * (1 - 0.55 * node.skepticism) * shield;
      node.belief = clamp(node.belief + power, 0, 100);
      node.touched = true;
      node.lastDelta = power;
      // 免疫只挡得住"推不动"的谣言。硬砸到阈值以上，这层免疫就被打穿了 ——
      // 和 propagate() 里对弱传播的判定用同一个门槛，规则保持一致。
      if (node.immune && node.belief >= K.YELLOW_THRESHOLD) {
        node.immune = false;
        node.immuneHold = 0;
      }
    } else {
      // 辟谣：反噬过的节点会明显更抗拒辟谣话术
      const backfireMul = node.backfire ? K.BACKFIRE_MUL : 1;
      const power = calculateDebunkPower(action, node, susc, fitMul, backfireMul);
      node.belief = clamp(node.belief - power, 0, 100);
      node.touched = true;
      node.lastDelta = -power;
      if (node.belief <= 0) node.immune = true;
      // 直接辟谣是"强免疫"：基础保质期 + 按留存度加成，守已经绿了的节点同样能续期。
      // 这就是"时间留存"维度在辟谣方的兑现方式 —— 权威背书打得慢，但守得久。
      if (node.immune) {
        node.immuneHold =
          K.IMMUNE_HOLD_DIRECT +
          Math.round(K.IMMUNE_HOLD_RETENTION * (action.retention / 100));
      }
      if (action.backfire) {
        node.backfire = true;
        node.belief = clamp(node.belief + 6, 0, 100); // 反噬：越描越黑
        node.immune = false;
      }
    }

    // 留存度取历史最高值，然后随时间自己衰减 —— 高留存需要持续投入维持
    node.retention = Math.max(node.retention, action.retention);
    node.lastTactic = action.tacticType;

    // 归因：谁的影响力触达了这个节点
    if (action.side === this.playerSide) {
      node.playerMark = Math.max(node.playerMark, 1);
    } else {
      node.aiMark = Math.max(node.aiMark, 1);
    }
    return node.belief - before;
  }

  /**
   * 传播扩散：每个"有信念"或"已免疫"的节点向邻居施加一次影响。
   * 一轮结算里所有节点同时计算增量、最后统一应用，避免先算的占便宜。
   */
  propagate() {
    const deltas = new Map(this.net.nodes.map((n) => [n.id, 0]));

    for (const src of this.net.nodes) {
      const neighbors = this.net.adjacency[src.id];
      if (!neighbors || (!src.belief && !src.immune)) continue;

      const influenceFactor = src.influence / 10;
      const spreadFactor = 0.5 + 0.5 * (src.retention / 100);

      if (src.belief > 0) {
        // 谣言外溢。outflow 是"这个节点往外推的总强度"，再按每条边的性质分配给各个邻居。
        //
        // 这里的量纲要盯紧：早先版本在末尾多乘了一个 0.35 的"手感系数"，
        // 结果一个相信度 80 的节点每回合只能给邻居推 2 点 —— 邻居要暴露 25 个回合
        // 才可能变红，而一局只有 6 回合。棋盘因此常年六到八成是灰的，
        // "向相邻节点扩散"这条核心机制在数值上根本没发生。
        // 现在直接以"每回合给邻居推多少点信念"为量纲来调 PROP_RATE。
        const outflow = (src.belief / 100) * K.PROP_RATE * influenceFactor * spreadFactor;
        for (const nb of neighbors) {
          const target = this.nodeById[nb.id];
          const edgeMul = nb.type === 'cross' ? 0.62 : nb.type === 'bridge' ? 0.86 : 0.72 + nb.weight * 0.62;
          const crossBoost = src.lastTactic === 'cross_circle' && nb.type !== 'intra' ? 1.5 : 1;
          const shield = target.immune ? K.IMMUNE_SPREAD_SHIELD : 1;
          const gain =
            outflow *
            nb.weight *
            edgeMul *
            crossBoost *
            (1 - 0.6 * target.skepticism) *
            this.suscOf(target) *
            shield *
            100;
          deltas.set(nb.id, deltas.get(nb.id) + gain);
        }
      }

      if (src.immune) {
        // 免疫外溢：辟谣结论顺着关系网往外压
        const push = K.IMMUNE_PUSH * influenceFactor * 100;
        for (const nb of neighbors) {
          const target = this.nodeById[nb.id];
          const edgeMul = nb.type === 'cross' ? 0.42 : nb.type === 'bridge' ? 0.78 : 0.68 + nb.weight * 0.42; // 跨圈澄清更难
          deltas.set(nb.id, deltas.get(nb.id) - push * nb.weight * edgeMul);
        }
      }
    }

    const changes = {};
    for (const node of this.net.nodes) {
      const d = deltas.get(node.id) || 0;
      if (d === 0) continue;
      const before = node.belief;
      node.belief = clamp(node.belief + d, 0, 100);
      if (d > 0 || before > 0) node.touched = true;

      if (node.immune) {
        // 免疫节点能把弱传播直接顶回去 —— 只有谣言强到突破阈值才会被重新感染。
        //
        // 早期版本这里是"只要 belief > 0 就掉免疫"，后果很严重：邻居推来 0.2 点
        // 信念就能把刚辟谣成功的节点打回原形，绿色永远存不住，
        // 辟谣方怎么打都是 0 胜。免疫必须对"弱噪声"有免疫力，否则不叫免疫。
        if (node.belief < K.YELLOW_THRESHOLD) {
          node.belief = 0;
        } else {
          node.immune = false;
          node.immuneHold = 0;
        }
      } else if (node.belief <= 0 && node.touched && d < 0) {
        // 只在这里"新授予"传播型免疫；已经绿了的节点不会被邻居免费续期，
        // 续期只能靠辟谣方下回合继续往这个节点投入 —— 否则绿色会滚雪球。
        node.immune = true;
        node.immuneHold = K.IMMUNE_HOLD_SPREAD;
      }

      // 传播归因：来源里只要有玩家标记过的，就算玩家的影响力到达
      const srcs = this.net.adjacency[node.id] || [];
      if (srcs.some((nb) => this.nodeById[nb.id].playerMark > 0)) {
        node.playerMark = Math.max(node.playerMark, 0.4);
      }
      if (srcs.some((nb) => this.nodeById[nb.id].aiMark > 0)) {
        node.aiMark = Math.max(node.aiMark, 0.4);
      }
      changes[node.id] = node.belief - before;
    }
    return changes;
  }

  /** 自然衰减：留存度越高，这条信息在这个节点心里存得越久 */
  decay() {
    const changes = {};
    for (const node of this.net.nodes) {
      const before = node.belief;
      if (node.immune) {
        // 免疫不是永久状态：每回合消耗一点持有时间，到期且没人续投就失效，
        // 节点回落到半信半疑 —— 辟谣方必须持续守阵地，不能一刷了之。
        node.immuneHold -= 1;
        if (node.immuneHold <= 0) {
          node.immune = false;
          node.immuneHold = 0;
          node.belief = K.IMMUNE_RELAPSE_BELIEF;
        }
        changes[node.id] = node.belief - before;
        continue;
      }
      if (node.belief <= 0) continue;
      const shelter = 1 - K.RETENTION_SHELTER * (node.retention / 100);
      node.belief = clamp(node.belief - K.BASE_DECAY * shelter, 0, 100);
      node.retention = node.retention * K.RETENTION_FADE;
      if (node.retention < 0.5) node.retention = 0;
      changes[node.id] = node.belief - before;
    }
    return changes;
  }

  /** 给新玩家一个短名单，不替玩家做决定，只解释为什么这些人值得看。 */
  recommendedTargets() {
    const side = this.playerSide;
    return [...this.net.nodes]
      .map((node) => {
        let score = node.influence * 2;
        const reasons = [];
        if (node.circles.length > 1) { score += 7; reasons.push('连接两个圈层'); }
        if (node.influence >= 8) { score += 5; reasons.push('影响力高'); }
        if (side === 'rumor') {
          if (node.state === 'yellow') { score += 7; reasons.push('接近相信'); }
          if (node.state === 'gray') score += 2;
          score += (1 - node.skepticism) * 4;
        } else {
          if (node.state === 'red') { score += 10; reasons.push('急需澄清'); }
          if (node.state === 'yellow') { score += 6; reasons.push('仍可争取'); }
          score += node.skepticism * 3;
        }
        if (!reasons.length) reasons.push('适合本回合争取');
        return { id: node.id, name: node.name, score, reason: reasons.slice(0, 2).join(' · ') };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ id, name, reason }) => ({ id, name, reason }));
  }

  refreshStates() {
    for (const node of this.net.nodes) {
      node.state = stateOf(node);
    }
  }

  // ------------------------------------------------------------ AI 对手

  aiAct() {
    const side = this.aiSide;
    const picked = [];

    // AI 的选点策略：优先影响力大的、状态还没被自己拿下的节点，
    // 并刻意往自己覆盖率最低的圈层补 —— 因为评分首要看四圈覆盖。
    const covered = this.aiCoveredCircles();
    const candidates = [...this.net.nodes].sort((a, b) => {
      const sa = this.aiNodeScore(a, side, covered);
      const sb = this.aiNodeScore(b, side, covered);
      return sb - sa;
    });

    for (const node of candidates) {
      if (picked.length >= NODES_PER_TURN) break;
      if (picked.some((p) => p.id === node.id)) continue;
      // 留一点随机性，避免每局 AI 走法完全一致
      if (this.rng() < 0.18 && picked.length < NODES_PER_TURN - 1) continue;
      picked.push(node);
    }
    // 兜底：上面有 18% 的概率随机跳过，理论上可能选不满 3 个，
    // 这里按分数顺序把剩下的名额补齐（不再从全量节点里乱抽）
    for (const node of candidates) {
      if (picked.length >= NODES_PER_TURN) break;
      if (!picked.some((p) => p.id === node.id)) picked.push(node);
    }

    const styleName = { aggressive: '激进型', steady: '稳健型', counter: '反制型' }[this.aiStyle];
    this.lastAiIntent = `${styleName} AI：` + (side === 'rumor'
      ? (picked.some((n) => n.state === 'gray') ? 'AI 正在扩大传播范围' : 'AI 正在争夺高影响力节点')
      : (picked.some((n) => n.state === 'red') ? 'AI 正在抢救已相信节点' : 'AI 正在寻找新的辟谣入口'));
    return picked.map((node) => {
      const type = pickAiTactic(node, side, this.rng);
      const pool = AI_TEMPLATES[side === 'debunk' ? 'debunk' : 'rumor'][type];
      const text = renderAiTemplate(this.rng.pick(pool), this.topic);
      const result = analyzeLocally(text, { topic: this.topic, side, node });
      return { ...result, tacticType: type, nodeId: node.id, text, side, isAi: true };
    });
  }

  aiNodeScore(node, side, covered) {
    let score = node.influence; // 影响力是基础权重
    const unseenCircle = node.circles.some((c) => !covered.includes(c)) ? 1.8 : 1;
    score *= unseenCircle;

    if (side === 'rumor') {
      // 造谣方：挑还没被拿下的高价值节点
      if (node.state === 'green') score *= 0.25;
      else if (node.state === 'red') score *= 0.45;
      else score *= 1.25;
      score *= 1 - 0.3 * node.skepticism;
    } else {
      // 辟谣方：优先抢救已经红了的高影响力节点
      if (node.state === 'red') score *= 2.2;
      else if (node.state === 'yellow') score *= 1.5;
      else if (node.state === 'green') score *= 0.3;
      else score *= 0.7;
    }
    if (this.aiStyle === 'aggressive') score *= node.state === 'gray' ? 1.3 : 0.9;
    if (this.aiStyle === 'steady') score *= node.influence >= 7 ? 1.25 : 0.9;
    if (this.aiStyle === 'counter') score *= node.playerMark > 0 ? 1.35 : 0.8;
    return score;
  }

  aiCoveredCircles() {
    const out = new Set();
    for (const n of this.net.nodes) {
      if (n.aiMark > 0) n.circles.forEach((c) => out.add(c));
    }
    return [...out];
  }

  // ------------------------------------------------------------ 事件与终局

  maybeFireMidgameEvent() {
    const evt = MIDGAME_EVENTS[this.topic.id];
    if (!evt || evt.round !== this.round) return null;

    this.pendingEvent = { title: evt.title, brief: evt.brief, options: evt.options || [
      { id: 'fast', label: '立即扩大传播', effect: evt.effect },
      { id: 'careful', label: '只影响关键节点', effect: Object.fromEntries(Object.entries(evt.effect).map(([k, v]) => [k, v * 0.6])) },
    ]};
    this.pushLog('event', `【中局事件】${evt.title} —— ${evt.brief}`);
    return this.pendingEvent;
  }

  resolveEvent(choice) {
    const option = this.pendingEvent?.options?.find((o) => o.id === choice) || this.pendingEvent?.options?.[0];
    if (!option) return;
    for (const [circle, delta] of Object.entries(option.effect || {})) this.susceptibility[circle] = clamp((this.susceptibility[circle] ?? 1) + delta, 0.3, 2.2);
    this.pushLog('event', `你选择：${option.label}`);
    this.pendingEvent = null;
  }

  resolveFactQuiz(answer) {
    if (!this.factQuiz) return;
    if (answer === this.factQuiz.answer) {
      this.susceptibility = Object.fromEntries(Object.entries(this.susceptibility).map(([k, v]) => [k, clamp(v - 0.08, 0.3, 2.2)]));
      this.pushLog('event', '事实核验答对：本局辟谣可信度小幅提升');
    } else this.pushLog('event', '事实核验答错：这次核查没有带来额外帮助');
    this.factQuiz = null;
  }

  finish() {
    this.finished = true;
    this.finalResult = this.computeFinal();
    this.pushLog(
      'system',
      `本局结束 —— ${this.finalResult.verdict}（终局得分 ${this.finalResult.totalScore}）`
    );
  }

  suscOf(node) {
    const vals = node.circles.map((c) => this.susceptibility[c] ?? 1);
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  pushLog(kind, text) {
    this.log.push({ round: this.round, kind, text, at: Date.now() });
  }

  // ------------------------------------------------------------ 统计与计分

  computeStats() {
    const totalInf = this.net.nodes.reduce((s, n) => s + n.influence, 0);
    const shares = { red: 0, yellow: 0, green: 0, gray: 0 };
    const counts = { red: 0, yellow: 0, green: 0, gray: 0 };
    for (const n of this.net.nodes) {
      shares[n.state] += n.influence;
      counts[n.state] += 1;
    }
    const pct = {};
    for (const k of Object.keys(shares)) {
      pct[k] = totalInf ? Math.round((shares[k] / totalInf) * 1000) / 10 : 0;
      // 影响力口径和节点数口径都给出来，前端进度条用影响力口径、明细里用节点数
    }
    const cntPct = {};
    const n = this.net.nodes.length;
    for (const k of Object.keys(counts)) {
      cntPct[k] = n ? Math.round((counts[k] / n) * 1000) / 10 : 0;
    }
    return { influenceShares: shares, influencePct: pct, counts, countPct: cntPct, totalInfluence: totalInf };
  }

  /** 玩家一方的四圈覆盖情况 */
  coverage() {
    const covered = new Map();
    for (const node of this.net.nodes) {
      if (node.playerMark <= 0) continue;
      for (const c of node.circles) {
        if (!covered.has(c)) covered.set(c, []);
        covered.get(c).push(node.name);
      }
    }
    return {
      count: covered.size,
      covered: [...covered.keys()],
      missing: CIRCLES.filter((c) => !covered.has(c.id)).map((c) => c.id),
      detail: Object.fromEntries(covered),
    };
  }

  computeFinal() {
    const s = this.playerSide === 'rumor' ? 'red' : 'green';
    const opp = this.playerSide === 'rumor' ? 'green' : 'red';
    const stats = this.computeStats();
    const cov = this.coverage();

    // ---- 第一优先级：四圈覆盖 ----
    const coverageScore = cov.count >= 4 ? 100 : cov.count * 22;

    // ---- 叠加项：影响力 / 留存 / 广度 ----
    const marked = this.net.nodes.filter((n) => n.playerMark > 0);
    const markedInf = marked.reduce((sum, n) => sum + n.influence, 0);
    const powerScore = stats.totalInfluence ? (markedInf / stats.totalInfluence) * 100 : 0;

    const withRetention = marked.filter((n) => n.retention > 0);
    const retentionScore = withRetention.length
      ? withRetention.reduce((sum, n) => sum + n.retention, 0) / withRetention.length
      : 0;

    // 广度：玩家触及过多少个"圈层对"（共 C(4,2)=6 对）
    const reachedCircles = new Set();
    for (const n of marked) n.circles.forEach((c) => reachedCircles.add(c));
    const rc = [...reachedCircles];
    let pairsReached = 0;
    for (let i = 0; i < rc.length; i++) {
      for (let j = i + 1; j < rc.length; j++) pairsReached += 1;
    }
    const breadthScore = (pairsReached / 6) * 100;

    const raw =
      coverageScore * 0.5 + powerScore * 0.2 + retentionScore * 0.15 + breadthScore * 0.15;
    // 覆盖不全时追加惩罚乘数，确保"优先看覆盖"这条规则在数学上真的成立
    const penalty = cov.count >= 4 ? 1 : 0.55 + 0.15 * cov.count;
    const totalScore = Math.round(raw * penalty);

    // ---- 胜负判定：按红黄绿灰占比 ----
    const red = stats.influencePct.red;
    const green = stats.influencePct.green;
    const yellow = stats.influencePct.yellow;
    const gray = stats.influencePct.gray;
    const MARGIN = 3;
    let winner;
    if (red > green + MARGIN) winner = 'rumor';
    else if (green > red + MARGIN) winner = 'debunk';
    else winner = 'draw';

    const winnerName = { rumor: '造谣方', debunk: '辟谣方', draw: '双方' }[winner];
    const playerWon = winner === 'draw' ? null : winner === this.playerSide;

    let verdict;
    if (winner === 'draw') verdict = '势均力敌，双方平局';
    else verdict = `${winnerName}获胜`;

    return {
      winner,
      verdict,
      playerWon,
      totalScore,
      breakdown: {
        coverageScore,
        powerScore: Math.round(powerScore),
        retentionScore: Math.round(retentionScore),
        breadthScore: Math.round(breadthScore),
        rawScore: Math.round(raw),
        penalty: Math.round(penalty * 100) / 100,
        weights: { coverage: 0.5, power: 0.2, retention: 0.15, breadth: 0.15 },
      },
      coverage: cov,
      shares: { red, yellow, green, gray },
      stats,
      truth: this.topic.truth,
      sideLabel: this.playerSide === 'rumor' ? '造谣方' : '辟谣方',
      opposingLabel: opp === 'red' ? '造谣方' : '辟谣方',
      ownLabel: s === 'red' ? '造谣方' : '辟谣方',
      goals: this.goals,
      recapTitle: this.recapTitle(stats, cov),
      recap: this.recapText(stats, cov),
    };
  }

  recapTitle(stats, cov) {
    if (this.chainStreak >= 2) return '连锁推进者';
    if (cov.count >= 4) return '全圈覆盖专家';
    if (stats.influencePct.green > stats.influencePct.red) return '稳定辟谣者';
    return '关键节点争夺者';
  }

  recapText(stats, cov) {
    if (cov.count < 3) return '本局覆盖圈层不足，下一局优先争夺桥接节点。';
    if (this.chainStreak >= 2) return '你连续命中高契合目标，形成了有效的传播连锁。';
    return '你已经建立了基本传播路径，可以尝试用不同语气制造更大的反差。';
  }

  /** 每回合存一条快照，三条态势折线图直接吃这个数组 */
  snapshot() {
    const stats = this.computeStats();
    this.history.push({
      round: this.round,
      red: stats.influencePct.red,
      yellow: stats.influencePct.yellow,
      green: stats.influencePct.green,
      gray: stats.influencePct.gray,
      counts: stats.counts,
      coverage: this.coverage().count,
      // 本回合玩家三维表现的均值，没有投放则沿用上一回合
      ...this.roundDims(),
    });
  }

  roundDims() {
    const prev = this.history[this.history.length - 1];
    const actions = this.lastPlayerActions || [];
    if (!actions.length) {
      return prev
        ? { impact: prev.impact, retention: prev.retention, spread: prev.spread }
        : { impact: 0, retention: 0, spread: 0 };
    }
    const avg = (k) => Math.round(actions.reduce((s, a) => s + a[k], 0) / actions.length);
    // 用累计口径更能反映"态势"走向，而不是单回合抖动
    const prevImpact = prev?.impact ?? 0;
    return {
      impact: Math.round((prevImpact * (this.round - 1) + avg('impact')) / this.round),
      retention: Math.round(((prev?.retention ?? 0) * (this.round - 1) + avg('retention')) / this.round),
      spread: Math.round(((prev?.spread ?? 0) * (this.round - 1) + avg('spread')) / this.round),
    };
  }

  describeRound(playerActions, aiActions, spreadChanges = {}, decayChanges = {}) {
    this.lastPlayerActions = playerActions;
    const lines = [];
    for (const a of playerActions) {
      const node = this.nodeById[a.nodeId];
      lines.push({
        who: 'player',
        nodeId: a.nodeId,
        nodeName: node.name,
        circles: node.circles,
        tacticType: a.tacticType,
        tacticName: a.tacticName,
        confidence: a.confidence,
        impact: a.impact,
        retention: a.retention,
        spread: a.spread,
        targetFit: a.targetFit,
        quality: a.quality,
        backfire: a.backfire,
        reason: a.reason,
        text: a.text,
        source: a.source,
        tone: a.tone || 'normal',
        directDelta: Math.round(a.appliedDelta || 0),
        spreadDelta: Math.round(spreadChanges[a.nodeId] || 0),
        decayDelta: Math.round(decayChanges[a.nodeId] || 0),
        delta: Math.round((a.appliedDelta || 0) + (spreadChanges[a.nodeId] || 0) + (decayChanges[a.nodeId] || 0)),
      });
    }
    for (const a of aiActions) {
      const node = this.nodeById[a.nodeId];
      lines.push({
        who: 'ai',
        nodeId: a.nodeId,
        nodeName: node.name,
        circles: node.circles,
        tacticType: a.tacticType,
        tacticName: a.tacticName,
        // AI 的行动也走同一套规则引擎评分，三维和契合度一样有值 ——
        // 结算卡上两边字段对称，玩家才能拿 AI 的选择跟自己对比
        confidence: a.confidence,
        impact: a.impact,
        retention: a.retention,
        spread: a.spread,
        targetFit: a.targetFit,
        quality: a.quality,
        backfire: a.backfire,
        reason: a.reason,
        text: a.text,
        source: a.source,
        directDelta: Math.round(a.appliedDelta || 0),
        spreadDelta: Math.round(spreadChanges[a.nodeId] || 0),
        decayDelta: Math.round(decayChanges[a.nodeId] || 0),
        delta: Math.round((a.appliedDelta || 0) + (spreadChanges[a.nodeId] || 0) + (decayChanges[a.nodeId] || 0)),
      });
    }
    return lines;
  }
}

function applyTone(result, tone) {
  const mul = {
    calm: { impact: 0.86, retention: 1.18, spread: 0.9 },
    normal: { impact: 1, retention: 1, spread: 1 },
    bold: { impact: 1.16, retention: 0.82, spread: 1.14 },
  }[tone] || { impact: 1, retention: 1, spread: 1 };
  return {
    ...result,
    impact: Math.round(clamp(result.impact * mul.impact, 0, 100)),
    retention: Math.round(clamp(result.retention * mul.retention, 0, 100)),
    spread: Math.round(clamp(result.spread * mul.spread, 0, 100)),
  };
}

// ---------------------------------------------------------------- 工具

/**
 * 辟谣效果 = 基础强度 × 即时冲击 × 触达 × 目标契合 × 证据可信度 × 反噬折扣。
 *
 * 证据可信度由话术留存、内容质量以及目标的权威信任/怀疑能力共同决定。
 * 修正以 1 为中心并严格限制在 ±5%，因此保留原公式的量级和既有平衡。
 */
export function calculateDebunkPower(action, node, susceptibility, fitMul, backfireMul) {
  const reach = 0.75 + 0.25 * susceptibility;
  const evidenceQuality = ((action.retention ?? 0) + (action.quality ?? 0)) / 200;
  const evidenceTrust = 0.55 * node.authorityTrust + 0.45 * node.skepticism;
  const centeredEvidence = 2 * evidenceQuality * evidenceTrust - 0.5;
  const evidenceMul = clamp(
    1 + centeredEvidence * K.DEBUNK_EVIDENCE_RANGE,
    1 - K.DEBUNK_EVIDENCE_RANGE,
    1 + K.DEBUNK_EVIDENCE_RANGE
  );

  return (
    (action.impact / 100) *
    K.DEBUNK_BASE *
    reach *
    fitMul *
    evidenceMul *
    backfireMul
  );
}

export function stateOf(node) {
  if (node.immune) return 'green';
  if (node.belief >= K.RED_THRESHOLD) return 'red';
  if (node.belief >= K.YELLOW_THRESHOLD) return 'yellow';
  return 'gray';
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 一局的会话容器：内存里保存进行中的对局 */
export class GameStore {
  constructor() {
    this.games = new Map();
  }

  create({ seed, topicId, playerSide, mode, aiStyle }) {
    const id = seed || `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const game = new Game({ seed: id, topicId, playerSide, mode, aiStyle });
    this.games.set(id, game);
    // 简单上限，防止长时间运行内存无限增长
    if (this.games.size > 200) {
      const oldest = this.games.keys().next().value;
      this.games.delete(oldest);
    }
    return game;
  }

  get(id) {
    const g = this.games.get(id);
    if (!g) throw new HttpError(404, '对局不存在或已过期，请重新开局');
    return g;
  }
}

export { TACTICS };
