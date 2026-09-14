/**
 * 当期热点主题库。
 *
 * 注意：这里所有主题都是**虚构**的游戏设定，用于教学演示信息传播机制，
 * 不对应任何真实事件、真实企业或真实个人。主题只提供"传闻内核"，
 * 玩家实际投放的话术由玩家自己撰写，系统只对玩家的话术做类型识别与评分。
 */

export const TOPICS = [
  {
    id: 'milktea',
    title: '某连锁奶茶被曝"原料含工业级增稠剂"',
    brief: '一条短视频称某连锁奶茶品牌为压低成本，在原料里掺入工业级增稠剂，长期饮用会致癌。视频 24 小时内播放量破千万。',
    truth: '该品牌当季抽检报告显示各项指标均合格；所谓"爆料"实为三年前一则无关旧闻的截图拼接。',
    rumorSeed: '原料含工业级增稠剂，长期饮用致癌',
    debunkSeed: '抽检指标全项合格，爆料视频系旧闻截图拼接',
    // 各圈层对这条传闻的易感系数：>1 更易相信，<1 更易怀疑
    susceptibility: { interest: 0.85, parent: 1.45, workplace: 1.0, campus: 1.2 },
    topicRisk: 'health',
    sourceLabel: '虚构教学主题 · 健康信息',
    evidence: '示例证据：抽检报告、原始视频发布时间与图片反向核验。',
    riskLevel: '高',
  },
  {
    id: 'exam',
    title: '"本市中考将取消英语科目"传闻流出',
    brief: '一张据称来自教育部门的红头文件截图在家长群流传，称明年起中考取消英语、改为等级考查。多个公众号跟进解读。',
    truth: '文件中抬头单位名称有误，教育部门当日已发布声明：未出台相关政策，网传文件系伪造。',
    rumorSeed: '中考取消英语科目，改为等级考查',
    debunkSeed: '教育部门声明该红头文件系伪造，政策未变',
    susceptibility: { interest: 0.7, parent: 1.55, workplace: 0.85, campus: 1.35 },
    topicRisk: 'policy',
    sourceLabel: '虚构教学主题 · 公共政策',
    evidence: '示例证据：教育部门公告、文件抬头和发布日期。',
    riskLevel: '中',
  },
  {
    id: 'layoff',
    title: '"某互联网大厂将裁员 40%"的内部邮件截图外流',
    brief: '一张 HR 内部邮件截图在职场社交平台流传，称某大厂下季度裁员 40%，优先优化 35 岁以上员工。截图带有公司内网水印。',
    truth: '该公司回应称邮件系伪造，水印为往期截图复用；但业务线确实在收缩，导致回应说服力打折。',
    rumorSeed: '下季度裁员 40%，优先优化 35 岁以上员工',
    debunkSeed: '公司回应邮件系伪造，水印为往期截图复用',
    susceptibility: { interest: 0.9, parent: 0.9, workplace: 1.6, campus: 0.8 },
    topicRisk: 'economy',
    sourceLabel: '虚构教学主题 · 职场信息',
    evidence: '示例证据：公司公开回应、邮件元数据和业务公告。',
    riskLevel: '中',
  },
  {
    id: 'gameplagiarism',
    title: '"某新游被指抄袭独立游戏美术素材"',
    brief: '一名画师发长文比对某新游宣传图与自己两年前的作品，称存在多处"叠图级"重合，并放出对比动图。游戏官方尚未回应。',
    truth: '叠图争议真实存在，但被指抄袭的另一方美术此前已公开授权素材；信息在传播中被截掉了授权环节。',
    rumorSeed: '某新游美术素材直接叠图抄袭独立画师作品',
    debunkSeed: '争议素材其实已获画师公开授权，传播中截掉了授权环节',
    susceptibility: { interest: 1.6, parent: 0.55, workplace: 0.7, campus: 1.15 },
    topicRisk: 'entertainment',
    sourceLabel: '虚构教学主题 · 版权争议',
    evidence: '示例证据：授权记录、原始作品发布时间和完整上下文。',
    riskLevel: '中',
  },
  {
    id: 'dogban',
    title: '"本小区将全面禁止养犬，已有犬只限期迁出"',
    brief: '一份盖有物业公章的《养犬管理新规》在业主群流传，称下月起小区全面禁养犬只，现有犬只须 15 日内迁出，逾期强制处理。',
    truth: '物业随后澄清：新规只是要求遛狗牵绳与登记备案，公章文件被篡改了关键条款。',
    rumorSeed: '小区下月起全面禁养犬只，逾期强制处理',
    debunkSeed: '物业澄清新规仅要求牵绳与登记，文件条款被篡改',
    susceptibility: { interest: 1.25, parent: 1.3, workplace: 0.75, campus: 0.9 },
    topicRisk: 'community',
    sourceLabel: '虚构教学主题 · 社区治理',
    evidence: '示例证据：物业完整公告、登记要求和适用范围。',
    riskLevel: '低',
  },
  {
    id: 'subsidy',
    title: '"凭社保卡可申领 2000 元数字人民币补贴"',
    brief: '一条短信截图称凭社保卡在指定链接可申领 2000 元数字人民币补贴，名额有限先到先得，附有申请入口二维码。',
    truth: '人社部门从未发放此类补贴，二维码指向钓鱼网站，已有多人反馈银行卡被盗刷。',
    rumorSeed: '凭社保卡可申领 2000 元数字人民币补贴，先到先得',
    debunkSeed: '人社部门否认此类补贴，二维码实为钓鱼网站',
    susceptibility: { interest: 0.8, parent: 1.5, workplace: 1.05, campus: 0.9 },
    topicRisk: 'fraud',
    sourceLabel: '虚构教学主题 · 反诈提醒',
    evidence: '示例证据：官方反诈预警、链接域名和受害反馈。',
    riskLevel: '高',
  },
];

/** 按 id 取主题；找不到时回退到第一条，保证接口永远有值可返回 */
export function getTopic(id) {
  return TOPICS.find((t) => t.id === id) || TOPICS[0];
}

/**
 * 中局事件。第 2 回合结束后触发，改变全局易感系数，避免三回合短局从头到尾一个手感。
 * 每个主题绑定一个事件，事件带一条面向玩家的"态势通报"。
 */
export const MIDGAME_EVENTS = {
  milktea: {
    round: 2,
    title: '第三方检测机构下场',
    brief: '一家第三方检测机构公布了同批次留样复检结果，数据与官方抽检一致。家长圈开始出现"是不是被公关了"的反向怀疑。',
    effect: { parent: -0.25, workplace: -0.1, campus: 0.1 },
  },
  exam: {
    round: 2,
    title: '教育部门召开新闻发布会',
    brief: '教育部门召开发布会正面回应，但未直接公布文件真伪鉴定结论，留下了解读空间。',
    effect: { parent: -0.2, campus: 0.15, workplace: 0.1 },
  },
  layoff: {
    round: 2,
    title: '竞品公司被曝同期扩招',
    brief: '有猎头放出消息称竞品公司正在同期扩招同岗位，职场圈的恐慌情绪出现松动。',
    effect: { workplace: -0.3, campus: 0.1, interest: 0.1 },
  },
  gameplagiarism: {
    round: 2,
    title: '被指抄袭的画师本人发声',
    brief: '画师本人发博澄清授权事宜，但博文措辞含糊，反而被解读为"被公关后的妥协"。',
    effect: { interest: -0.15, campus: 0.2, parent: 0.15 },
  },
  dogban: {
    round: 2,
    title: '物业公布完整版新规原文',
    brief: '物业在公告栏贴出完整版新规原文，但原文用词拗口，业主群里出现了三种截然不同的解读。',
    effect: { parent: -0.2, interest: 0.15, workplace: 0.1 },
  },
  subsidy: {
    round: 2,
    title: '反诈中心发布预警',
    brief: '反诈中心发布预警通报，但通报只描述了作案手法，没有点名本条传闻，部分家长认为"说的不是我收到的这个"。',
    effect: { parent: -0.25, campus: 0.1, workplace: 0.15 },
  },
};
