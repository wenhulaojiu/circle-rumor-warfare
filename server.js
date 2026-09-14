/**
 * 《圈层谣言攻防战》服务端。
 *
 * 只用 Node 内置模块（http / fs / path / url），不依赖任何 npm 包，
 * 首次运行不需要联网安装，断网也能完整游玩（话术评分会自动降级到本地规则引擎）。
 *
 *   node server.js            默认 http://localhost:5173
 *   PORT=8080 node server.js  换端口
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameStore, HttpError, TOTAL_ROUNDS, NODES_PER_TURN } from './src/game.js';
import { TOPICS } from './src/topics.js';
import { loadLlmConfig, isLlmConfigured, probe } from './src/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 5173);

// ---------------------------------------------------------------- 配置

function readLocalConfig() {
  const p = path.join(__dirname, 'config.local.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`[warn] config.local.json 解析失败，已忽略：${err.message}`);
    return {};
  }
}

const llmConfig = loadLlmConfig(readLocalConfig());
const store = new GameStore();

// ---------------------------------------------------------------- 工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[error]', err);
  sendJson(res, status, { error: err.message || '服务器内部错误' });
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 静态文件服务，带路径穿越防护 */
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  // 解析后必须仍在 public 目录内，挡住 ../../etc/passwd 这类请求
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- 路由

async function handleApi(req, res, pathname) {
  const method = req.method.toUpperCase();

  // 健康检查 / 模型状态
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      llm: {
        configured: isLlmConfigured(llmConfig),
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl,
        credentialSource: llmConfig.source,
        engine: llmConfig.engine,
      },
      rules: { totalRounds: TOTAL_ROUNDS, nodesPerTurn: NODES_PER_TURN },
    });
  }

  // 主题列表（开局前选热点）
  if (pathname === '/api/topics' && method === 'GET') {
    return sendJson(res, 200, {
      topics: TOPICS.map((t) => ({
        id: t.id,
        title: t.title,
        brief: t.brief,
        sourceLabel: t.sourceLabel,
        evidence: t.evidence,
        riskLevel: t.riskLevel,
        susceptibility: t.susceptibility,
      })),
    });
  }

  // 开新局
  if (pathname === '/api/game' && method === 'POST') {
    const body = await readBody(req);
    const side = body.playerSide === 'debunk' ? 'debunk' : 'rumor';
    const mode = body.mode === 'quick' ? 'quick' : 'standard';
    const aiStyle = ['aggressive', 'steady', 'counter'].includes(body.aiStyle) ? body.aiStyle : undefined;
    const game = store.create({ seed: body.seed, topicId: body.topicId, playerSide: side, mode, aiStyle });
    return sendJson(res, 200, { state: game.getState() });
  }

  // /api/game/:id 与 /api/game/:id/turn
  const m = pathname.match(/^\/api\/game\/([^/]+)(\/turn)?$/);
  if (m) {
    const game = store.get(decodeURIComponent(m[1]));

    if (!m[2] && method === 'GET') {
      return sendJson(res, 200, { state: game.getState() });
    }

    if (m[2] && method === 'POST') {
      const body = await readBody(req);
      const result = await game.playTurn(body.submissions, llmConfig, body.eventChoice);
      return sendJson(res, 200, result);
    }
  }

  throw new HttpError(404, `接口不存在：${method} ${pathname}`);
}

// ---------------------------------------------------------------- 启动

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      sendError(res, err);
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }
  res.writeHead(405).end('Method Not Allowed');
});

server.listen(PORT, async () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │        圈层谣言攻防战  ·  服务已启动        │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  console.log(`  ▸ 打开浏览器访问：  http://localhost:${PORT}`);
  console.log(`  ▸ 单局回合数：      ${TOTAL_ROUNDS} 回合，每回合选 ${NODES_PER_TURN} 个节点`);
  console.log('');

  if (!isLlmConfigured(llmConfig)) {
    console.log('  ▸ 话术评分引擎：    本地规则引擎（未检测到大模型凭证）');
    console.log('    如需接入大模型，把 config.example.json 复制为 config.local.json 并填入凭证，');
    console.log('    或直接设置环境变量 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL。');
  } else {
    console.log(`  ▸ 话术评分引擎：    大模型（${llmConfig.model}）`);
    console.log(`    接口地址：        ${llmConfig.baseUrl}`);
    console.log(`    凭证来源：        ${llmConfig.source === 'env' ? '环境变量' : 'config.local.json'}`);
    process.stdout.write('    探活中…');
    const r = await probe(llmConfig);
    if (r.ok) {
      console.log(`\r    探活成功 ✓  ${r.latencyMs}ms        `);
    } else {
      console.log(`\r    探活失败 ✗  ${r.reason}`);
      console.log('    游戏仍可正常进行，评分会自动降级到本地规则引擎。');
    }
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。换个端口重试：PORT=5174 node server.js\n`);
    process.exit(1);
  }
  throw err;
});
