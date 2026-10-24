// ═══════════════════════════════════════════════════════════════════════
//  Exa MCP 客户端 —— 搜索/抓取走 MCP Server（https://mcp.exa.ai/mcp）
//  不再直连 Exa REST API。
//
//  协议：JSON-RPC over HTTP（Streamable），响应是 SSE 格式（event: message / data: {...}）。
//  实测无需 API key 即可用；若被限流，可在 URL 上追加 ?exaApiKey=xxx。
//
//  工具：
//    web_search_exa  必填 query + objective（Exa 要求成对给，见 bot.mjs 的 TOOLS）
//    web_fetch_exa   必填 urls（数组）
// ═══════════════════════════════════════════════════════════════════════
import { cfg } from './config.mjs';

let sessionId = '';
let ready = false;

/** MCP 的响应是 SSE 格式，取 data: 那行解析；通知类调用返回空体 */
function parseSse(txt) {
  if (!txt?.trim()) return null;
  const line = txt.split('\n').find((l) => l.startsWith('data: '));
  try {
    return JSON.parse(line ? line.slice(6) : txt);
  } catch {
    return null;
  }
}

async function rpc(method, params, id) {
  // ⚠️ 必须带超时（10-24 评审）：MCP 端点一旦挂起不响应，无超时会让工具循环无限等待，
  // 这条 @ 消息永远没回音也没报错。60s 够 Exa 慢慢想，不至于卡死整条回复。
  let r;
  try {
    r = await fetch(cfg.exaMcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',   // MCP 规范要求两个都给
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(60 * 1000),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error('Exa 搜索 60 秒没响应，已掐断这次请求（是超时不是卡死）');
    }
    throw e;
  }
  const s = r.headers.get('mcp-session-id');
  if (s) sessionId = s;
  return parseSse(await r.text());
}

/** 初始化握手（只做一次） */
async function ensureReady() {
  if (ready) return;
  const res = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'qq-group-bot', version: '1.0' },
  }, 1);
  if (!res?.result) throw new Error('MCP 初始化失败');
  await rpc('notifications/initialized');   // 规范要求握手后补一条通知，返回空体
  ready = true;
}

/** 调 MCP 工具；会话失效（服务端可能回收）时自动重新握手再试一次 */
async function callTool(name, args) {
  await ensureReady();
  let res = await rpc('tools/call', { name, arguments: args }, Date.now());
  if (res?.error) {
    ready = false;
    sessionId = '';
    await ensureReady();
    res = await rpc('tools/call', { name, arguments: args }, Date.now());
  }
  if (res?.error) throw new Error(res.error.message ?? 'MCP 调用失败');
  return (res?.result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n\n');
}

/** 搜索。objective 是 Exa 要求的「这次搜索想达成什么」，缺省时退回用 query */
export async function search(query, objective, numResults) {
  return callTool('web_search_exa', {
    query,
    objective: objective || query,
    numResults: numResults ?? cfg.searchResults,
  });
}

/** 抓取网页正文 */
export async function fetchPage(url) {
  return callTool('web_fetch_exa', { urls: [url] });
}
