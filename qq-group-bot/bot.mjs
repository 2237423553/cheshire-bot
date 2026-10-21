// ═══════════════════════════════════════════════════════════
//  QQ 群聊机器人 —— @ 我才回 · 全模态 · 自动补最近媒体
//  LLM: OpenCode Go / MiMo-V2.6-Flash（thinking = 模型默认，可在群里 #接口 / #切换 热切换）
//
//  关键点：QQ 会把「文字+@」和「图片/语音/视频」拆成多条消息发出，
//  所以被 @ 时若本条没有媒体，就回溯群历史，把最近的媒体一并喂给模型。
// ═══════════════════════════════════════════════════════════
import { readFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SnowLumaHttpClient, SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { cfg } from './config.mjs';
import { pickThree, foodCount } from './foods.mjs';
import * as exa from './exa.mjs';
import * as wt from './wt.mjs';
import * as imggen from './imggen.mjs';
import * as vidgen from './vidgen.mjs';
import { extractBvLink, summarizeVideo } from './bilibili.mjs';

// ─────────── 限制 ───────────
const MAX_IMAGES = 3;
const MAX_MEDIA_BYTES = cfg.maxMediaBytes;   // 见 config.mjs（15MB 会挡掉手机拍的视频）
const VIDEO_OK = ['mp4', 'wmv', 'mov', 'avi'];   // API 只收这四种
const LOOKBACK_COUNT = 30;                       // 回溯拉多少条群消息

// ─────────── 会话状态 ───────────
const history = new Map();
const lastReplyAt = new Map();
const groupSummary = new Map();   // gid -> 压缩后的历史摘要
const promptTokens = new Map();   // gid -> 上次请求的真实 prompt_tokens
const repeatState = new Map();    // gid -> 上一条消息 { sig, sender, joined }，用来识别「+1 复读」

// ─────────── 功能开关（API 面板写 switches.json；每条消息现读，改了即刻生效，不用重启）───────────
// 键：imggen(画图+改稿路由) / vidgenEnabled(生视频) / bilibili(免@总结) /
//     search(联网搜索) / repeat(+1复读) / beacon(寻呼信标)。缺省=开；vidgen 缺省跟 cfg.vidgenEnabled。
const SWITCH_PATH = fileURLToPath(new URL('./switches.json', import.meta.url));
let swCache = { mtime: -1, data: null };
function featureOn(name, dflt = true) {
  try {
    const m = statSync(SWITCH_PATH).mtimeMs;
    if (m !== swCache.mtime) swCache = { mtime: m, data: JSON.parse(readFileSync(SWITCH_PATH, 'utf8')) };
  } catch { swCache = { mtime: -1, data: swCache.data ?? null }; }
  const v = swCache.data?.[name];
  return v === undefined || v === null ? dflt : Boolean(v);
}
function toolsNow() {
  // 联网搜索关了就不给模型 web_search / fetch_webpage；生图关了不给 generate_image（路由也会歇业）
  const search = featureOn('search', true);
  const imggenOn = featureOn('imggen', true);
  return TOOLS.filter((t) => {
    const n = t.function?.name;
    if (!search && (n === 'web_search' || n === 'fetch_webpage')) return false;
    if (!imggenOn && n === 'generate_image') return false;
    return true;
  });
}
const eatHistory = new Map();     // gid -> 最近推过的菜名，用来避免老推同样的几样
const lastDrawByGroup = new Map(); // gid -> 最近一次画图 { prompt, subj, at }，供「改一下/重画」改稿路由用

/**
 * content 可以是字符串（纯文字），也可以是 parts 数组（带图片/视频）。
 * textOnly 是纯文字版 —— 这条掉出「媒体关联窗口」后就用它，图不再发给模型。
 */
function pushHistory(gid, role, content, textOnly) {
  // ⚠️ 键名必须统一成 group-<gid>：historyForApi / buildSystem / #清空 都用这个键。
  // 之前这里存的是裸数字键、读取用的是 group-<gid>，两套键对不上，
  // 等于机器人从来没看见过历史 —— 多轮对话全是失忆状态。
  const key = `group-${gid}`;
  const arr = history.get(key) ?? [];
  arr.push({ role, content, text: textOnly ?? content });
  while (arr.length > cfg.maxTurns * 2) arr.shift();
  history.set(key, arr);
}

/**
 * 过滤出「可以进关联窗口」的 parts：太大的媒体直接剔掉（只保留文字）。
 * data URL 的字节数按 base64 长度反推，不用真去解码。
 */
function stickyParts(parts) {
  return parts.filter((p) => {
    // 视频一律不进上下文（太重），走「描述式」——由模型写一句话描述代替，见 VIDEO_DESC_HINT
    if (p?.type === 'video_url') return false;
    const u = p?.image_url?.url ?? '';
    if (!u.startsWith('data:')) return true;
    const b64 = u.slice(u.indexOf(',') + 1);
    const bytes = Math.floor((b64.length * 3) / 4);
    return bytes <= cfg.mediaHistoryMaxBytes;
  });
}

/**
 * 取出要发给模型的历史，并套上「媒体关联窗口」。
 *
 * 窗口按「与机器人的互动」数：数 user 条（一条 = 一次和柴郡的互动），
 * 最近 cfg.mediaMemoryWindow 次互动保留图片原样，更早的只留纯文字。
 * 群里不 @ 机器人的闲聊根本不进 history，所以刷屏不会把图挤掉。
 *
 * 为什么不干脆不存图：那模型只在当轮看得见图，隔一句就问不出
 * 「刚才那张图里有几个人」。留一个窗口 = 保住细节又不至于撑爆上下文。
 */
function historyForApi(sessionId) {
  const arr = history.get(sessionId) ?? [];
  // 从尾往前数 user 条，第 mediaMemoryWindow 次互动所在的下标就是窗口起点
  let counted = 0;
  let keepFrom = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].role === 'user' && ++counted >= cfg.mediaMemoryWindow) {
      keepFrom = i;
      break;
    }
  }
  return arr.map((e, i) => (i < keepFrom
    ? { role: e.role, content: e.text }
    : { role: e.role, content: e.content }));
}

// ─────────── 媒体工具 ───────────
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
  wav: 'audio/wav', mp3: 'audio/mpeg', amr: 'audio/amr', silk: 'audio/silk',
  ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', wmv: 'video/wmv', mov: 'video/quicktime', avi: 'video/x-msvideo',
};

function extOf(s) {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(s ?? '');
  return (m?.[1] || '').toLowerCase();
}

function guessMime(name, fallback) {
  return MIME_BY_EXT[extOf(name)] ?? fallback;
}

/**
 * OneBot 媒体段：
 *   image  -> data.url (下载地址) / data.image
 *   record -> data.file (文件名.amr) / data.url (下载地址，无扩展名!)
 *   video  -> data.file (文件名.mp4) / data.url (下载地址，无扩展名!)
 * 关键：格式要从 file 判，下载要用 url
 */
function mediaInfo(seg) {
  const d = seg.data ?? {};
  return {
    src: d.url || d.file || d.image || '',
    name: d.file || d.image || d.url || '',
  };
}

/**
 * 下载/读取媒体，返回 { dataUrl, reason }。
 * ⚠️ reason 一定要填 —— 失败时把它告诉模型，模型才能如实说明原因，
 *    而不是像以前那样只能瞎猜「一片黑乎乎什么都看不到」。
 *    以前 !src 和 buf 为空这两条路径是静默 return null，日志里什么都查不到。
 */
async function toDataUrl(seg, fallbackMime) {
  const { src, name } = mediaInfo(seg);
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
  if (!src) {
    const keys = Object.keys(seg?.data ?? {}).join(',') || '(空)';
    console.warn(`[bot] 媒体加载失败：segment 里没有 url/file 字段，实际字段=${keys}`);
    return { dataUrl: null, reason: `没拿到媒体地址（segment 字段：${keys}）` };
  }
  try {
    let buf;
    let mime = guessMime(name, fallbackMime);
    if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) {
        console.warn(`[bot] 媒体下载失败 HTTP ${r.status}: ${String(src).slice(0, 60)}`);
        return { dataUrl: null, reason: `下载失败 HTTP ${r.status}` };
      }
      const ct = (r.headers.get('content-type') || '').split(';')[0];
      if (ct && ct !== 'application/octet-stream') mime = ct;
      buf = Buffer.from(await r.arrayBuffer());
    } else {
      buf = await readFile(src.replace(/^file:\/\//i, ''));
    }
    if (!buf?.length) {
      console.warn(`[bot] 媒体加载失败：下载到 0 字节，src=${String(src).slice(0, 60)}`);
      return { dataUrl: null, reason: '下载到 0 字节（地址可能已过期）' };
    }
    if (buf.length > MAX_MEDIA_BYTES) {
      console.warn(`[bot] 媒体过大已跳过：${mb(buf.length)} > 上限 ${mb(MAX_MEDIA_BYTES)}`);
      return { dataUrl: null, reason: `文件 ${mb(buf.length)} 超过上限 ${mb(MAX_MEDIA_BYTES)}` };
    }
    console.log(`[bot] 媒体加载成功：${mb(buf.length)} mime=${mime}`);
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, reason: '' };
  } catch (e) {
    console.warn('[bot] 媒体读取失败:', String(src).slice(0, 60), e.message);
    return { dataUrl: null, reason: `读取出错：${e.message}` };
  }
}

/**
 * 把一组媒体段转成 OpenAI content 片段。
 * 同时把加载失败收集进 errors —— 失败必须当场说出口，
 * 以前只写日志，指挥官根本不知道出了什么问题（只看到模型瞎猜「一片黑乎乎」）。
 */
async function mediaToParts(segs) {
  const parts = [];
  const errors = [];
  let nImg = 0, nRec = 0, nVid = 0;
  for (const s of segs) {
    if (s.type === 'image' && nImg < MAX_IMAGES) {
      nImg++;
      const r = await toDataUrl(s, 'image/jpeg');
      if (r.dataUrl) {
        parts.push({ type: 'image_url', image_url: { url: r.dataUrl } });
      } else {
        parts.push({ type: 'text', text: `[一张图片未能加载：${r.reason}]` });
        errors.push(`图片加载失败（${r.reason}）`);
      }
    } else if (s.type === 'record' && nRec < 1) {
      nRec++;
      // 语音暂不支持：QQ 语音是腾讯 SILK v3 专有编码，MiMo 不认、ffmpeg 也无解。
      // 不瞎喂，改成如实告知模型，让它老实说听不了，别编造内容。
      parts.push({ type: 'text', text: '[群友发来一段语音消息，但你听不懂语音内容，请如实说听不了，不要编造]' });
    } else if (s.type === 'video' && nVid < 1) {
      nVid++;
      // 格式从 file 判；无扩展名时放行尝试（QQ 一般就是 mp4）
      const ext = extOf(mediaInfo(s).name);
      if (ext && !VIDEO_OK.includes(ext)) {
        parts.push({ type: 'text', text: `[一段视频未能加载：格式 ${ext} 不受支持]` });
        errors.push(`视频格式 ${ext} 不受支持（只收 ${VIDEO_OK.join('/')}）`);
        continue;
      }
      // URL 方式（MiMo 官方支持，≤300MB）：把 QQ 原始下载链接直接给模型，
      // 不下载不转码 —— 省流量省时间，也绕开 base64 ≤50MB 的限制。
      // fps/media_resolution 是 MiMo 的精细度参数（fps 默认 2，范围 0.1~10）。
      const { src } = mediaInfo(s);
      if (/^https?:\/\//i.test(src)) {
        parts.push({ type: 'video_url', video_url: { url: src }, fps: 2, media_resolution: 'default' });
      } else {
        // 拿不到网络链接（本地文件）才退回 base64
        const r = await toDataUrl(s, 'video/mp4');
        if (r.dataUrl) {
          parts.push({ type: 'video_url', video_url: { url: r.dataUrl } });
        } else {
          parts.push({ type: 'text', text: `[一段视频未能加载：${r.reason}]` });
          errors.push(`视频加载失败（${r.reason}）`);
        }
      }
    }
  }
  return { parts, errors };
}

// ─────────── 回溯最近媒体（QQ 把媒体和@拆开发）───────────
/**
 * 回溯群历史，只取「最近一条视频」。
 *
 * 为什么只取视频：QQ 会把「文字+@」和「视频/图片」拆成多条消息，所以被 @ 时
 * 得回头找视频。但图片不该一起抓——用户发视频时附近常有无关图片，一起喂给
 * 模型反而干扰它。图片只在 @ 那条消息里直接附带时才传。
 *
 * 不做时间窗口过滤：两次视频挨得近时，按时间累积会拿到旧的那条。
 * messages 按时间正序返回，所以后出现的覆盖先出现的 = 留最新的。
 */
async function fetchRecentMedia(gid, senderId) {
  try {
    const j = await http.raw('get_group_msg_history', { group_id: gid, count: LOOKBACK_COUNT });
    const msgs = j?.messages ?? [];

    const pickLatestVideo = (filter) => {
      let latest = null;
      for (const m of msgs) {
        if (!filter(m)) continue;
        for (const s of (Array.isArray(m.message) ? m.message : [])) {
          if (s.type === 'video') latest = s;
        }
      }
      return latest ? [latest] : [];
    };

    // 只认「@ 我的那个人」自己发的视频。
    // 不放宽到其他人：别人发的无关图片/视频不该被拖进上下文，否则机器人会
    // 答非所问地评论别人发的东西。
    return pickLatestVideo((m) => String(m.user_id) === String(senderId));
  } catch (e) {
    console.warn('[bot] 回溯群历史失败:', e.message);
    return [];
  }
}

// ─────────── 组装 content ───────────
/**
 * 展开「引用回复」：QQ 的 reply 段只带被引用消息的 id，内容要拿 id 去
 * get_msg 拉回来 —— 不展开的话，指挥官引用一张图问「这台车的配置数据」，
 * 模型根本看不见那张图。
 * 引用里如果是合并转发（forward），再拉 get_forward_msg 取各节点内容。
 * 只展开一层不套娃；拉不到就当没有，不影响主流程。
 */
async function expandReplySegs(segs) {
  const out = [];
  for (const s of segs) {
    if (s.type !== 'reply' || !s.data?.id) continue;
    try {
      const msg = await http.raw('get_msg', { message_id: s.data.id });
      let inner = Array.isArray(msg?.message) ? msg.message : [];

      // 合并转发：取最后 3 个节点的内容（最新的在后面）
      if (inner.some((x) => x.type === 'forward')) {
        const f = await http.raw('get_forward_msg', { message_id: s.data.id });
        const nodes = Array.isArray(f?.messages) ? f.messages : [];
        inner = nodes.slice(-3).flatMap((n) => (Array.isArray(n.content) ? n.content : []));
      }

      const quotedSender = msg?.sender?.card || msg?.sender?.nickname || '别人';
      out.push({ type: 'text', text: `[引用 ${quotedSender} 的消息]` });
      out.push(...inner.filter((x) => ['image', 'video', 'text'].includes(x.type)));
    } catch (e) {
      console.warn('[bot] 展开引用消息失败:', e.message);
    }
  }
  return out;
}

async function buildContent(event) {
  const segs = segments(event);
  const txt = segs
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim();

  let mediaSegs = segs.filter((s) => ['image', 'record', 'video'].includes(s.type));
  let fromHistory = false;

  // 引用回复：把被引用消息里的图/文拉进来（引用也算「看得见」，有它就不再回溯）
  const quoted = await expandReplySegs(segs);
  mediaSegs.push(...quoted.filter((s) => ['image', 'video'].includes(s.type)));
  const quotedText = quoted
    .filter((s) => s.type === 'text')
    .map((s) => (s.data?.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);   // 引用的长文别全塞，截断防撑

  // 本条消息没有媒体（含引用里也没有）-> 回溯（QQ 常把媒体和@拆成两条）
  if (!mediaSegs.length) {
    const recent = await fetchRecentMedia(event.group_id, event.user_id);
    if (recent.length) {
      mediaSegs = recent;
      fromHistory = true;
    }
  }

  const { parts, errors: mediaErrors } = await mediaToParts(mediaSegs);
  const kinds = parts.map((p) => ({ image_url: '图片', audio_url: '语音', video_url: '视频' })[p.type]).filter(Boolean);

  const prefix = kinds.length
    ? `(群友发来：${[...new Set(kinds)].join('、')}${fromHistory ? '，来自刚才的消息' : ''})`
    : '';
  const body = [prefix, quotedText, txt].filter(Boolean).join(' ');
  if (body) parts.push({ type: 'text', text: body });

  // rawText = 用户真实说的话（不含「群友发来：图片」这类前缀），
  // 只有它会进上下文历史，避免把媒体前缀当成长期记忆累积。
  return parts.length ? { parts, rawText: txt, mediaErrors } : null;
}

// ─────────── 网络工具（Exa）───────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '搜索互联网获取实时信息（新闻、天气、价格、事件等）。' +
        '常识性问题不需要搜索，直接回答即可。' +
        '重要：query 和 objective 都要用英文（本搜索引擎对英文的召回远好于中文）。' +
        'query 写「理想结果的页面描述」而不是关键词堆砌，' +
        '例如写 "blog post comparing React and Vue performance" 而不是 "React vs Vue"。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'English. Description of the ideal page to find' },
          objective: {
            type: 'string',
            description: 'English. What this search is for: which pages should rank first, and what facts to pull from them',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wt_stats',
      description:
        '查询战争雷霆（War Thunder 国际服）玩家的战绩统计。' +
        '当指挥官想查某个游戏玩家在战争雷霆里的 K/D、胜率、场次时使用。',
      parameters: {
        type: 'object',
        properties: {
          nickname: { type: 'string', description: '游戏内玩家昵称，要完整精确（区分大小写、含特殊符号）' },
        },
        required: ['nickname'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        '画一张图并发到群里（AI 文生图）。' +
        '当指挥官想画画/生成图片/看某个画面时使用。' +
        'prompt 用英文写，详细描述画面主体、风格、构图、光线，例如 ' +
        '"a chubby gray cat in a royal navy uniform, cute cartoon style, warm lighting"。' +
        '生成要等几十秒，画完会自动发到群里，你只需在文字里简单说一句画了什么。' +
        '如果工具返回被审核拦截，如实告诉指挥官画不了，不要编造图片内容。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'English. Detailed description of the image to generate' },
        },
        required: ['prompt'],
      },
    },
  },
];

let searchCount = 0;   // 当日搜索计数（简单保护）

// 搜索/抓取都走 Exa MCP Server（exa.mjs），不再直连 REST API
async function exaSearch(query, objective) {
  if (cfg.searchDailyLimit > 0 && searchCount >= cfg.searchDailyLimit) {
    return '搜索次数已达今日上限，请直接根据已有知识回答。';
  }
  searchCount++;
  try {
    const text = await exa.search(query, objective, cfg.searchResults);
    if (!text?.trim()) return '搜索没有返回任何结果。';
    console.log(`[bot] 🔍 搜索 "${query}" -> ${text.length} 字（今日第 ${searchCount} 次）`);
    return text.slice(0, cfg.searchResults * cfg.searchTextChars);
  } catch (e) {
    return '搜索出错：' + e.message;
  }
}

async function exaFetch(url) {
  try {
    const text = await exa.fetchPage(url);
    const t = (text ?? '').trim();
    if (!t) return '该网页抓取不到正文内容。';
    console.log(`[bot] 🌐 抓取 ${url} -> ${t.length} 字`);
    return t.slice(0, cfg.fetchTextChars);
  } catch (e) {
    return '抓取出错：' + e.message;
  }
}

async function runTool(name, args, gid) {
  if (name === 'web_search') return exaSearch(String(args.query ?? ''), String(args.objective ?? ''));
  if (name === 'fetch_webpage') return exaFetch(String(args.url ?? ''));
  if (name === 'wt_stats') return wt.formatStats(await wt.fetchStats(String(args.nickname ?? '')));
  if (name === 'generate_image') return generateImageTool(args, gid);
  return '未知工具：' + name;
}

/** 画图工具：生成 -> 直接发群 -> 回执给模型。失败把原因喂回去让它如实转告 */
async function generateImageTool(args, gid) {
  if (!gid) return '这里不是群聊，没法发图。';
  console.log(`[bot] 🎨 画画：${args.prompt}`);
  let buf;
  try {
    buf = await imggen.generateImage(args.prompt);
  } catch (e) {
    console.warn('[bot] 生图失败:', e.message);
    // 失败原因别指望模型转告（它有时就吞了）——脚本直接发群里，返回值只要它别重复
    try {
      await http.raw('send_group_msg', {
        group_id: Number(gid),
        message: [text(`⚠️ 画画失败了喵：${String(e.message).slice(0, 100)}`)],
      }, { timeoutMs: 60 * 1000 });
      return '画画失败，失败原因已经直接发到群里了。简短回应一句即可，不要重复报错细节。';
    } catch (e2) {
      console.error('[bot] 失败提示也发不出去:', e2.message);
      return '画画失败：' + e.message;
    }
  }
  try {
    // 2~3MB 图走 highway 上传可能超过 SDK 默认 30s，实测超时报「发送失败」其实 QQ 侧还在传
    await http.raw('send_group_msg', {
      group_id: Number(gid),
      message: [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }],
    }, { timeoutMs: 120 * 1000 });
  } catch (e) {
    console.warn('[bot] 图片发送失败:', e.message);
    return `图已经画好了（${Math.round(buf.length / 1024)}KB）但发到群里失败：${e.message}`;
  }
  return `图片已生成并发到群里（${Math.round(buf.length / 1024)}KB）。用一两句话告诉指挥官画的是什么即可。`;
}

// ─────────── LLM（带工具循环）───────────
function buildSystem(sessionId, extraSystem = '') {
  const summary = groupSummary.get(sessionId);
  return [cfg.systemPrompt, summary ? `[之前对话摘要]\n${summary}` : '', extraSystem]
    .filter(Boolean)
    .join('\n\n');
}

async function callLLM(sessionId, messages, useTools) {
  const body = {
    model: cfg.model,
    messages,
  };
  if (cfg.thinking && cfg.thinking !== 'default') body.thinking = cfg.thinking;   // 'default' = 不传，用模型默认
  if (useTools) body.tools = toolsNow();   // 按开关现过滤（search/imggen 关了工具就从清单里消失）

  const r = await fetch(cfg.llmUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.llmKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'qq-group-bot/1.0',
      // OpenCode Go 要求每个会话带稳定的会话 ID（路由 + 提示词缓存），缺失不影响调用但官方明确建议
      'x-opencode-session': sessionId,
      // 自定义头放最后 —— 允许覆盖上面任何一条（有些中转商要自己的鉴权头）
      ...(cfg.llmHeaders ?? {}),
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(`LLM ${r.status}: ${JSON.stringify(j.error)}`);

  // 记下真实 prompt_tokens，用来判断何时该压缩（比按字数估算准）
  const pt = j.usage?.prompt_tokens;
  if (pt) promptTokens.set(sessionId, pt);

  return j.choices?.[0]?.message ?? {};
}

/**
 * 清理「工具调用被当文本吐出来」的残留。
 * 如果中途没传 tools，模型会用文本伪造 `` 这种语法，
 * 这里兜底删掉，免得发到群里。
 */
function cleanToolArtifacts(s) {
  return s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/<[^>]+>[\s\S]*?<\/[a-z_]+>/gi, '')
    .trim();
}

async function askLLM(sessionId, userContent, extraSystem = '') {
  const messages = [
    { role: 'system', content: buildSystem(sessionId, extraSystem) },
    ...historyForApi(sessionId),   // 套上媒体关联窗口：10 条内带图，更早的只留文字
    { role: 'user', content: userContent },
  ];

  // 工具循环：模型说要调工具 -> 执行 -> 喂回去 -> 再问
  // 注意：每一轮都必须带 tools。中途撤掉 tools 会让模型用文本伪造工具调用语法。
  let drewImage = false;   // 本轮有没有真的调过 generate_image（防「嘴上画好了图却不存在」）
  for (let round = 0; round < cfg.maxToolRounds; round++) {
    const msg = await callLLM(sessionId, messages, true);
    const toolCalls = msg.tool_calls;
    if (!toolCalls?.length) {
      const content = cleanToolArtifacts(msg.content ?? '');
      // 模型有样学样：上下文里全是「画好啦喵～」的成功句式，它就会跳过工具直接编一句。
      // 声称画好 / 承诺马上画（「这就重新画」）但这轮没调过画图工具 => 图不存在，
      // 当场戳穿让它真调工具或如实说（2026-10-21 补承诺式，改稿请求最容易嘴遁）。
      if (!drewImage && /画好|画完|图片已(生成|发)|这就(去|重新)?画|马上(就)?画|这就给你画/.test(content)) {
        messages.push({
          role: 'user',
          content: '[系统提示：你说「画好了」，但这一轮你并没有真的调用 generate_image 工具，群里的图片并不存在。' +
            '如果指挥官确实想要图，现在就调用 generate_image 工具；不想画或画不了就如实说，绝不许谎报。]',
        });
        continue;
      }
      return content;
    }

    // MiMo 官方要求：思考模式下带工具调用的 assistant 消息必须完整回传
    // reasoning_content，缺失会 400（见 MiMo 文档「深度思考-多轮对话回传要求」）
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: toolCalls,
      ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
    });
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* 保持空对象 */ }
      if (tc.function?.name === 'generate_image') drewImage = true;   // 调过就算（哪怕失败，也已如实回报）
      const result = await runTool(tc.function?.name, args, sessionId.startsWith('group-') ? sessionId.slice(6) : null);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  // 轮数用完 -> 提示它收手出答案（仍然带 tools，见上方注释）
  messages.push({
    role: 'user',
    content: '[系统提示：工具调用次数已达上限，请不要再调用任何工具，直接给出最终回答]',
  });
  const final = await callLLM(sessionId, messages, true);
  return cleanToolArtifacts(final.content ?? '');
}

// ─────────── 上下文自动压缩 ───────────
/** 把旧对话压成摘要，只保留最近 keepRecent 条原文 */
async function compressHistory(gid) {
  // ⚠️ 键名统一 group-<gid>（同 pushHistory，见那里的注释）
  const key = `group-${gid}`;
  const arr = history.get(key) ?? [];
  if (arr.length <= cfg.keepRecent) return false;

  const keep = arr.slice(-cfg.keepRecent);
  const old = arr.slice(0, arr.length - cfg.keepRecent);
  // 用纯文字版拼摘要稿：m.content 可能是 parts 数组，直接插字符串会变成 [object Object]
  const transcript = old.map((m) => `${m.role === 'user' ? '群友' : '柴郡'}: ${m.text ?? m.content}`).join('\n');

  try {
    const summary = (
      await askLLM(
        `summary-${gid}`,
        transcript,
        '你是上下文压缩器。把下面的群聊记录压成简明中文摘要（300 字以内），' +
          '必须保留：人物、话题、结论、未解决的问题、关键事实与数字。' +
          '只输出摘要本身，不要客套、不要 markdown、不要标题。',
      )
    ).trim();

    groupSummary.set(key, summary);
    history.set(key, keep);
    // 注意：不要把 promptTokens 清零。它的语义是「上次真实请求的 prompt_tokens」，
    // 压缩后的真实大小要等下一次请求才知道，清零会让 #上下文 显示假 0。
    console.log(`[bot] 群 ${gid} 🗜️上下文已压缩：${old.length} 条 → 摘要 ${summary.length} 字，保留最近 ${keep.length} 条`);
    return true;
  } catch (e) {
    console.warn('[bot] 上下文压缩失败:', e.message);
    return false;
  }
}

/**
 * 当前上下文 token 数 = **上一次真实请求的 prompt_tokens**（API 回报值）。
 *
 * 语义说明：这是「最近一次发给模型的上下文大小」，不是估算值。
 * 因为 history 与 promptTokens 都在内存里，重启后一起归零——这是自洽的
 * （重启=失忆，占用自然为 0）。在任何 LLM 调用之前查，也会是 0。
 */
function currentContextTokens(gid) {
  return promptTokens.get(`group-${gid}`) ?? 0;
}

/** 达到阈值就压缩（连续压到降到阈值以下为止） */
async function maybeCompress(gid) {
  const limit = cfg.contextTokenLimit * cfg.compressRatio;
  let guard = 0;
  while (currentContextTokens(gid) >= limit && guard++ < 3) {
    if (!(await compressHistory(gid))) break;
  }
}

// ─────────── 消息工具 ───────────
function segments(event) {
  return Array.isArray(event.message) ? event.message : [];
}

function isAtMe(event, myUin) {
  return segments(event).some((s) => s.type === 'at' && String(s.data?.qq) === String(myUin));
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim();
}

function describeMedia(content) {
  const kinds = (content ?? []).map((p) => ({ image_url: '图', audio_url: '语音', video_url: '视频' })[p.type]).filter(Boolean);
  return kinds.length ? `[${[...new Set(kinds)].join('+')}]` : '';
}

/** 去掉 markdown 记号 —— QQ 里 **粗体** 会显示成一堆星号 */
function stripMd(s) {
  return s
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 把长文本拆成若干条 QQ 消息（按段落 → 句子）。
 *
 * **不做条数硬限制、不截断内容** —— 条数靠「让模型按预算生成」来控制
 * （见 askLLM 的 lengthHint），这里只负责把已经生成好的文本切开发出去。
 * 之前那种「超过 3 条就 slice 砍掉」会丢内容，已经去掉。
 */
function splitMessage(s, max) {
  if (s.length <= max) return [s];

  // ① 先把段落切成不超 max 的「块」（超长段落按句子切）
  const blocks = [];
  for (const para of s.split(/\n{2,}/)) {
    if (para.length <= max) { blocks.push(para); continue; }
    let cur = '';
    for (const sent of para.split(/(?<=[。！？!?；;\n])/)) {
      if (cur && (cur + sent).length > max) { blocks.push(cur); cur = ''; }
      cur += sent;
    }
    if (cur) blocks.push(cur);
  }

  // ② 合并短块、塞满为止 —— 少了这步会导致「N 个段落 = N 条消息」的碎片化刷屏
  const out = [];
  let cur = '';
  for (const b of blocks) {
    const joiner = cur ? '\n\n' : '';
    if (cur && (cur.length + joiner.length + b.length) > max) {
      out.push(cur.trim());
      cur = b;
    } else {
      cur += joiner + b;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 视频走「描述式」：本轮仍发原片给模型看（不然没法解析视频），
 * 但要它在同一次回答里顺带写一句画面描述，由系统摘走放进上下文 —— 原片不留。
 * 零额外调用：描述和回答出自同一次请求。
 *
 * ⚠️ 标记用〔〕而不是尖括号：往提示词里塞工具协议的标签字面量会截断工具调用（见下篇坑 11）。
 */
const VIDEO_DESC_HINT =
  '\n【额外要求】回答完之后，另起一行写「〔视频描述〕」，后面跟一句对这段视频画面的客观描述（25 字以内）。' +
  '这一行由系统单独取走、不会发给群友，所以正文里别提到它。';

/** 思考强度的展示文案（启动日志和 #模型 指令共用，免得两处写得不一致） */
function thinkingLabel() {
  return !cfg.thinking || cfg.thinking === 'default' ? '模型默认（不传参数）' : JSON.stringify(cfg.thinking);
}

/** 给模型的长度预算说明 —— 让它自己生成「刚好装下或更少」的回复 */
function lengthHint() {
  const budget = cfg.maxReplyChunks * cfg.chunkChars;
  return (
    `【长度要求】把回答控制在约 ${budget} 字以内（这样能装进 ${cfg.maxReplyChunks} 条消息）。` +
    '内容多时自己取舍重点、精炼表达，保持完整不残缺，宁可少写也别啰嗦。'
  );
}

/**
 * 发送长文本，自动分段 + 可选去 markdown。
 * ⚠️ 参数名不能叫 `text` —— 会遮蔽从 @snowluma/sdk 导入的 text() 构造函数，
 * 导致 text(chunks[i]) 变成「把字符串当函数调用」而抛 TypeError。
 */
async function sendReply(ctx, msg, { strip = true } = {}) {
  const body = strip ? stripMd(msg) : msg;
  if (!body) return;
  const chunks = splitMessage(body, cfg.chunkChars);
  for (let i = 0; i < chunks.length; i++) {
    await ctx.reply(text(chunks[i]));
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 500));
  }
}

// ─────────── 管理指令（不走 LLM，不耗 token）───────────
/**
 * 指令用 # 开头，也认中文关键词。**整句精确匹配**，避免误触发
 * （比如有人聊天里说到「压缩」不该被当成指令）。
 */
const COMMANDS = {
  context: ['上下文', '记忆', '查上下文', 'ctx', 'context', 'history'],
  compress: ['压缩', '压缩上下文', 'compress', 'zip'],
  clear: ['清空', '清空上下文', 'clear', 'reset'],
  model: ['模型', '当前模型', 'model'],
  // ⚠️ 只有这个是「真调大模型」的，上面三个都是纯脚本零 token
  eat: ['吃什么', '今天吃什么', '今日吃什么', '吃啥', '三餐', '今日三餐', 'eat', 'food'],
};

function extractUserText(event) {
  return segments(event)
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim();
}

/**
 * 群里的显示名：**群名片优先**（大家在群里看到的名字），没设群名片才退回 QQ 昵称。
 * ⚠️ 这俩是两个字段：拿错就会「认错人」——比如群名片叫「-ECN-柴俊」的人，
 * QQ 昵称可能是「(阿？惊慌)报喜职员刷屏了上墙」这种，模型用后者称呼他，群里看就是认错人。
 */
function displayName(event) {
  const s = event.sender ?? {};
  return String(s.card || s.nickname || '').trim() || '群友';
}

function parseCommand(raw) {
  const t = raw.trim().replace(/^[#＃]/, '').replace(/\s+/g, '').toLowerCase();
  if (!t) return null;
  for (const [cmd, aliases] of Object.entries(COMMANDS)) {
    if (aliases.some((a) => t === a.toLowerCase())) return cmd;
  }
  return null;
}

/**
 * #战绩 <玩家名>：带参数的指令，和整句精确匹配的 COMMANDS 分开认。
 * 玩家名允许空格/特殊符号，取「战绩」后面的整段。
 */
function parseWtCommand(raw) {
  const m = /^[#＃]\s*战绩[\s　]+([\s\S]+)$/.exec(raw.trim());
  return m ? m[1].trim() : null;
}

/**
 * 生视频意图识别（和画图同理，宁漏勿错）。
 * 必须同时有「视频/影片/动画」关键词 + 动作词；纯提「视频」俩字不接。
 * 注意：parseDrawIntent 的文字产物名单里含「视频」，两闸互斥不抢活。
 */
function parseVideoIntent(raw) {
  let t = String(raw ?? '').trim();
  t = t.replace(new RegExp(cfg.beaconTrigger, 'g'), '').trim();
  if (!t || t.length > 80) return null;
  if (/(脚本|代码|程序|文件|文档|表格|配置|翻译|总结|摘要|作文|文章|小说|歌词)/.test(t)) return null;
  if (!/(视频|影片|动画)/.test(t)) return null;
  if (!/(?:生成|画|做|来|出|拍|给我)/.test(t)) return null;
  return t;
}

/**
 * 把生视频诉求翻成英文视频 prompt（独立小会话 vid-<gid>）。
 * 同翻译层否决权：不是要视频就 NO，放行正常对话。
 */
async function translateVideoPrompt(sid, subj) {
  try {
    const msg = await callLLM(sid, [
      {
        role: 'system',
        content:
          '你是文生视频 prompt 翻译器。把用户请求翻成一段高质量的英文生视频 prompt：' +
          '描述场景、主体、动作/镜头运动、氛围（30~80 词英文），直接输出 prompt 本身，无解释、无引号。' +
          '如果用户的请求根本不是要生成一段视频（要代码/文字/图片/闲聊等），只回复 NO。',
      },
      { role: 'user', content: subj },
    ], false);
    const p = cleanToolArtifacts(msg.content ?? '').trim();
    if (!p || /^N[Oo]$/.test(p) || /^否/.test(p)) return null;
    return p.slice(0, 800);
  } catch (e) {
    console.warn('[bot] 生视频 prompt 翻译失败:', e.message);
    return null;
  }
}

/**
 * 画图意图识别（意图强制路由的闸门）。
 * 命中：@ 后「画…」开头（画一张/画个/画大凤…），或「生成/来/出 …图(片/照片)」句式。
 * 原则：**宁漏勿错** —— 文字类产物（代码/脚本/文档…）绝对不接画，闲聊疑似灵活放行。
 * 返回要画的主题原文（交给翻译层 Plumbing 成英文 prompt），不命中返回 null。
 */
function parseDrawIntent(raw) {
  // 摘掉开头的 @某人和询呼词，剩下才是诉求本体
  let t = String(raw ?? '').trim();
  t = t.replace(new RegExp(cfg.beaconTrigger, 'g'), '').trim();
  if (!t || t.length > 80) return null;
  // 明确要的是文字/视频产物：接了必错，直接放行（视频走 vidgen 路由，别被画图闸抢走）
  if (/(脚本|代码|程序|文件|文档|表格|配置|翻译|总结|摘要|作文|文章|小说|歌词|视频|影片|动画)/.test(t)) return null;
  // 「画」必须在句首附近才算画图诉求（防「你上次画的大凤呢」这种越聊越歪的）
  const headDraw = /^(?:帮我|给我|请|柴郡|出示)?[，,。！!～\s]{0,3}画[\s\S]{1,60}$/.test(t);
  // 「画一张 X」「生成一张 X」：有量词就算（群里真实句式「生成一张赛车大凤」没有图字）
  const counterDraw = /(?:画|生成)\s*(?:一|两|三)?\s*(?:张|幅|个|款|副)/.test(t);
  // 「来张 X 的图」「生成 X 图片」：动词弱，必须有图字才认
  const nounDraw = /(?:画|生成|来|出)\s*[^。？！]{0,50}(?:图|图片|照片)/.test(t);
  if (!headDraw && !counterDraw && !nounDraw) return null;
  return t;
}

/**
 * 把画图诉求翻成英文生图 prompt（独立小会话，不吃群记忆、不占上下文、不带工具）。
 * 翻译层带否决权：根本不是画图诉求时回复 NO，路由退回正常对话（双保险）。
 * prevPrompt 有值 = 改稿模式：这是对上一次成图的修改请求，翻成「修改版 prompt」。
 * 返回 null = 否决或空译文。
 */
async function translateDrawPrompt(sid, subj, prevPrompt = '') {
  try {
    const sys = prevPrompt
      ? `这是对上一次 AI 生成图片的修改请求。上一次使用的英文生图 prompt：\n${prevPrompt}\n\n` +
        '按用户的反馈修改这张图的 prompt：只改被点名的部分，没提到的保持原样，' +
        '直接输出修改后的完整英文 prompt（30~80 词），无解释、无引号。' +
        '如果用户的反馈根本不是在要求修改这张图（纯闲聊/问别的事），只回复 NO。'
      : '你是文生图 prompt 翻译器。把用户请求翻成一段高质量的英文生图 prompt：' +
        '补全画面主体、风格、构图、光线等细节，直接输出 prompt 本身（30~80 词英文），无解释、无引号。' +
        '如果用户的请求根本不是要生成一张图片（要代码/文字/闲聊等），只回复 NO。';
    const msg = await callLLM(sid, [
      { role: 'system', content: sys },
      { role: 'user', content: subj },
    ], false);
    const p = cleanToolArtifacts(msg.content ?? '').trim();
    if (!p || /^N[Oo]$/.test(p) || /^否/.test(p)) return null;
    return p.slice(0, 800);   // prompt 太长也没意义，截到 800
  } catch (e) {
    console.warn('[bot] 生图 prompt 翻译失败:', e.message);
    return null;
  }
}

async function handleCommand(cmd, gid, ctx) {
  // ── #吃什么：唯一会真调大模型的指令 ──
  // 用独立会话 food-<gid>：
  //   · 不吃群聊记忆（每次都是纯随机，不会被聊天内容带偏）
  //   · 不进上下文统计（不占用 #上下文 的额度）
  //   · 不带工具（报菜名用不上搜索，省下 Exa 额度）
  if (cmd === 'eat') {
    const sid = `food-${gid}`;
    try {
      // 抽签交给脚本做：靠模型「自己随机」不靠谱 —— 实测它每次都往盖饭、汉堡钻。
      // 这样随机性由 Math.random 保证、自动避开最近推过的菜，模型只剩「写推荐语」的活，挑不了食。
      const recent = eatHistory.get(gid) ?? [];
      const { breakfast, lunch, dinner } = pickThree(recent);
      const picked = [breakfast.name, lunch.name, dinner.name];
      const plain = `早餐：${breakfast.name}\n午餐：${lunch.name}\n晚餐：${dinner.name}`;

      const msg = await callLLM(
        sid,
        [
          { role: 'system', content: buildSystem(sid) },
          {
            role: 'user',
            content: `柴郡已经替指挥官抽好了今天三餐（菜名不能改、也不能换）：\n${plain}\n\n${cfg.eatPrompt}`,
          },
        ],
        false,   // 不带工具
      );
      const reply = cleanToolArtifacts(msg.content ?? '').trim();

      // 这三道进黑名单，下次抽签自动避开（只留最近 18 个，免得越攒越长）
      eatHistory.set(gid, [...recent, ...picked].slice(-18));

      // 万一模型没按格式输出，也至少把抽签结果发出去，别让指挥官白等
      await sendReply(ctx, reply || plain, { strip: cfg.stripMarkdown });
    } finally {
      promptTokens.delete(sid);   // 独立会话的 token 数别留在表里越攒越多
    }
    return;
  }

  // ── #模型：报当前用的模型（纯脚本零 token）──
  // 接口那行从 llmUrl 里取主机名，以后换服务商这行会自动跟着变，不用改代码
  if (cmd === 'model') {
    const host = new URL(cfg.llmUrl).host;
    const think = thinkingLabel();
    await sendReply(
      ctx,
      `当前模型：${cfg.model}\n接口：${host}\n思考强度：${think}`,
      { strip: false },
    );
    return;
  }

  const key = `group-${gid}`;
  const arr = history.get(key) ?? [];
  const summary = groupSummary.get(key);
  const tok = currentContextTokens(gid);
  const limit = cfg.contextTokenLimit;
  const pct = limit ? Math.round((tok / limit) * 100) : 0;

  if (cmd === 'context') {
    await sendReply(
      ctx,
      `当前上下文Token 占用：${tok} / ${limit}（${pct}%，压缩阈值 ${Math.round(cfg.compressRatio * 100)}%）`,
      { strip: false },
    );
    return;
  }

  if (cmd === 'compress') {
    const before = arr.length;
    const ok = await compressHistory(gid);
    const after = (history.get(key) ?? []).length;
    if (ok) {
      // 只报条数，不报新 token 数：压缩后的真实占用要等下次请求才知道
      await sendReply(ctx, `已压缩：${before} → ${after} 条 + 摘要`, { strip: false });
    } else if (before <= cfg.keepRecent) {
      await sendReply(ctx, `无需压缩：${before} 条`, { strip: false });
    } else {
      await sendReply(ctx, '压缩失败', { strip: false });
    }
    return;
  }

  if (cmd === 'clear') {
    history.delete(key);
    groupSummary.delete(key);
    promptTokens.delete(key);
    await sendReply(ctx, '已清空', { strip: false });
  }
}

// ─────────── B站链接自动总结 ───────────
// 直链直传引擎在 bilibili.mjs；这里只管群里的编排：
// 缓存（2h 内同一视频秒回）、防重入（正在看再发不重复烧钱）、ack（看片要几分钟，先吭一声）。
const bvCache = new Map();       // key -> { at, text }
const bvBusy = new Set();        // 正在总结中的 key
const BV_CACHE_TTL = 2 * 60 * 60 * 1000;

async function handleBilibili(link, userText, event, ctx, gid) {
  // 链接之外的话（去掉QQ分享标题【…】后够长）当作对视频的提问
  const qRaw = userText
    .replace(/【[^】]*】/g, ' ')
    .replace(link, ' ')
    .replace(/-哔哩哔哩/g, ' ')
    .trim();
  const question = qRaw.length >= 4 ? qRaw : '';

  const bv = link.match(/BV[0-9A-Za-z]{10}/);
  const pm = userText.match(/[?&]p=(\d+)/);
  const key = `${bv ? bv[0] : link}:P${pm ? pm[1] : 1}:${question}`;

  const cached = bvCache.get(key);
  if (cached && Date.now() - cached.at < BV_CACHE_TTL) {
    await ctx.reply(text(`这部咱看过喵～之前的总结再发一遍：\n\n${cached.text}`));
    console.log(`[bot] B站总结 群 ${gid} <- ${key} (缓存秒回)`);
    return;
  }
  if (bvBusy.has(key)) return;   // 正在看这条，别重复点火（双发=双倍烧钱）
  bvBusy.add(key);
  try {
    await ctx.reply(text('收到链接喵！咱这就去看片（720P 直传，看完就回～）'));
    const r = await summarizeVideo(link, question, (line) =>
      console.log(`[bot] B站 群 ${gid}: ${line.slice(0, 50)}`));

    const reply = `📺 ${r.title}（${r.owner}｜${r.durationText}）\n\n${r.summary}`;
    bvCache.set(key, { at: Date.now(), text: reply });

    // 进上下文：之后群里能接着追问这部视频的内容（纯文字，不重传视频）
    pushHistory(gid, 'user', `分享B站视频《${r.title}》${question ? ` 并问：${question}` : ''}`, true);
    pushHistory(gid, 'assistant', `[回 ${displayName(event)}] ${reply}`);

    // 长总结分段连发（和主回复同一套节流）
    const chunks = splitMessage(reply, cfg.chunkChars);
    for (let i = 0; i < chunks.length; i++) {
      await ctx.reply(text(chunks[i]));
      if (i < chunks.length - 1) await new Promise((r2) => setTimeout(r2, 500));
    }
    const tok = r.usage ? ` | tok=${r.usage.prompt_tokens}/${r.usage.completion_tokens}` : '';
    console.log(`[bot] B站总结 群 ${gid} <- ${r.bvid} P${r.page} ${question ? '(带提问)' : ''} | ${r.quality}P/${r.sizeMB}MB${tok} | 已分${chunks.length}条`);
  } finally {
    bvBusy.delete(key);
  }
}

// ─────────── 启动 ───────────
const http = new SnowLumaHttpClient({ baseUrl: cfg.obHttp, accessToken: cfg.obHttpToken });

// SnowLuma 没就绪时不要当场崩溃 —— 启动顺序随意，注入完自动连上。
// 不设超时：机器人本来就是常驻服务，等多久都无所谓，别让它因为「等过头」而躺平。
const t0 = Date.now();
let me = null;
for (let n = 0; ; n++) {
  try {
    me = await http.getLoginInfo();
    break;
  } catch {
    const waited = Math.round((Date.now() - t0) / 1000);
    if (n === 0) {
      console.log(`[bot] SnowLuma 未就绪（${cfg.obHttp}），等待「进程注入」中……（不设超时，注入完自动连上）`);
      console.log('[bot] 顺序随意：也可以先注入再启动机器人');
    } else if (waited % 60 < 3) {
      console.log(`[bot] 仍在等待 SnowLuma 注入…… 已等 ${waited}s`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
console.log(`[bot] 已连接 OneBot：${me.nickname} (UIN ${me.user_id})`);
console.log(`[bot] 模型=${cfg.model}  思考=${thinkingLabel()}  冷却=${cfg.cooldownMs}ms`);
console.log(`[bot] 触发：群内 @ 我 · 或喊「${cfg.beaconTrigger}」（寻呼信标 ->「${cfg.beaconReply}」，不用 @、不耗 token）`);
console.log(`[bot] 指令：#上下文（查记忆） · #压缩（手动压缩） · #清空（清记忆） · #模型（查模型）——不耗 token`);
console.log('[bot]      #战绩 <玩家名>（战争雷霆 K/D / 胜率，走 Thunderskill）');
console.log(`[bot]      #吃什么（从 ${foodCount()} 道菜里真随机抽早/中/晚三餐，模型只写推荐语）`);
console.log(`[bot] 复读：群里出现「+1 复读」时跟着复读一次（同一内容只跟一次，防死循环）`);
console.log(`[bot] 支持：文字 / 图片 / 视频 | 语音暂不支持(QQ用SILK编码)`);
console.log(`[bot] 被@时自动补【自己发的】最近一条视频（图片一律不回溯、他人媒体一律不回溯）`);
{
  // 开机打一眼当前开关状态（面板改了开关不用重启，这行只在启动时打一次快照）
  const names = { imggen: '画画', vidgenEnabled: '生视频', bilibili: 'B站总结', search: '搜索', repeat: '复读', beacon: '信标' };
  const states = Object.entries(names).map(([k, l]) => `${l}=${featureOn(k, k === 'vidgenEnabled' ? cfg.vidgenEnabled !== false : true) ? '开' : '关'}`);
  console.log(`[bot] 功能开关：${states.join(' · ')}（switches.json，每条消息现读，面板改了即刻生效）`);
}

const bot = new SnowLumaWebSocketClient({ url: cfg.obWs, accessToken: cfg.obWsToken, reconnect: true });

bot.onGroupMessage(async (event, ctx) => {
  const gid = event.group_id;
  const userText = extractUserText(event);
  const beacon = !!cfg.beaconTrigger && userText.includes(cfg.beaconTrigger);
  const atMe = isAtMe(event, me.user_id);
  const cmd = userText ? parseCommand(userText) : null;
  const bvLink = userText ? extractBvLink(userText) : null;   // B站链接算「正事」，不进复读链

  if (String(event.user_id) === String(me.user_id)) return;   // 别回自己的消息（防死循环）

  // ── +1 复读：有人把上一条原样再发一遍（QQ 会挂个 +1 气泡）时，机器人跟着发一次 ──
  // 🔒 防死循环四道闸：
  //    ① 不处理自己的消息 —— 机器人不会复读自己的复读（上面那行 return）
  //    ② 同一个内容只跟一次 —— joined 一旦置位就不再跟，直到群里换了新内容才重置
  //    ③ 先置位再发送 —— 就算发送失败也绝不重试，杜绝「失败重试 -> 无限刷屏」
  //    ④ 必须换个人来重复 —— 同一个人连发同样的话不算复读
  // 寻呼 / 指令 / @ 我都算「正事」，不参与复读，免得把复读链搅乱。
  const last = repeatState.get(gid);
  if (userText && !beacon && !cmd && !atMe && !bvLink && featureOn('repeat', true)) {
    const sameAsLast = !!last && last.sig === userText;
    const byAnother = sameAsLast && String(last.sender) !== String(event.user_id);

    if (byAnother) {
      if (!last.joined) {
        last.joined = true;   // ⚠️ 必须先置位再发
        try {
          await ctx.reply(text(userText));
          console.log(`[bot] +1 复读 群 ${gid} <- ${userText.slice(0, 18)}`);
        } catch { /* 发不出去就算了 */ }
      }
      return;   // 重复的这条只负责跟一次，不进 LLM
    }

    repeatState.set(gid, {
      sig: userText,
      sender: String(event.user_id),
      // 内容没变就沿用旧的 joined —— 堵死「A 发 B 发 A 发 B 发」轮流刷机器人的漏洞
      joined: sameAsLast ? last.joined : false,
    });
    return;   // 普通闲聊：记一笔就走，不打扰
  }
  // 走到这儿的都是「打断复读链」的情况：寻呼 / 指令 / @ 我 / 纯媒体消息。
  // 复读比的是「紧挨着的上一条」，中间插了别的东西就不算 +1 了。
  repeatState.delete(gid);

  // ── B站链接：群里出现就自动总结（不用 @，链接即触发）──
  // 同一条视频 2 小时内只「看」一遍（缓存秒回），正在看的时候再发不重复点火。
  if (bvLink && featureOn('bilibili', true)) {
    const nowBv = Date.now();
    if (nowBv - (lastReplyAt.get(gid) ?? 0) < cfg.cooldownMs) return;
    lastReplyAt.set(gid, nowBv);
    try {
      await handleBilibili(bvLink, userText, event, ctx, gid);
    } catch (e) {
      console.error(`[bot] B站总结 群 ${gid} 出错：`, e.message);
      try { await ctx.reply(text(`⚠️ B站视频没看成喵：${String(e.message).slice(0, 100)}`)); } catch { /* 发不出去就算了 */ }
    }
    return;
  }

  if (!atMe && !(beacon && featureOn('beacon', true))) return;   // 既没 @ 我、也没喊寻呼（或信标已关），就当没看见

  // 冷却：防刷屏（寻呼和正常回复共用一个闸门，免得刷爆）
  const now = Date.now();
  if (now - (lastReplyAt.get(gid) ?? 0) < cfg.cooldownMs) return;
  lastReplyAt.set(gid, now);

  // ── 寻呼信标：喊「柴郡柴郡」就自动蹦出来 ──
  // 纯脚本回复，不走 LLM、不耗 token、瞬间到达；目的就是让指挥官搜得到机器人在哪。
  if (beacon && featureOn('beacon', true)) {
    try {
      await ctx.reply(text(cfg.beaconReply));
      console.log(`[bot] 寻呼信标触发 群 ${gid} <- ${userText.slice(0, 18)}  ->  ${cfg.beaconReply}`);
    } catch { /* 发不出去就算了 */ }
    if (!atMe) return;   // 只是喊一嗓子的话，到此为止，别再走 LLM
  }

  // ── #战绩 <玩家名>：战争雷霆战绩查询（纯查询，不走 LLM、不耗 token）──
  const wtNick = parseWtCommand(userText);
  if (wtNick !== null) {
    try {
      if (!wtNick) {
        await sendReply(ctx, '用法：#战绩 <游戏内昵称>\n例：#战绩 PhlyDaily', { strip: false });
      } else {
        const d = await wt.fetchStats(wtNick);
        await sendReply(ctx, wt.formatStats(d), { strip: false });
        console.log(`[bot] 群 ${gid} #战绩 ${wtNick} -> ${d.nick}`);
      }
    } catch (e) {
      console.error('[bot] #战绩 出错：', e.message);
      try { await ctx.reply(text(`⚠️ ${e.message}`)); } catch { /* 发不出去就算了 */ }
    }
    return;
  }

  // ── 画图意图强制路由（2026-10-20 上线；10-21 加改稿路由）──
  // 不信模型的自觉（坑 34：它见惯「画好啦喵～」会跳过工具装成功），
  // 命中画图句式时脚本直接接管：翻译 prompt -> 生图 -> 发群 -> 报告，
  // 全程模型没有「装成功」的机会（翻 prompt 那步模型只当翻译器）。
  // 改稿路由：刚画过的 10 分钟内，「性别错了/改一下/重画」这类没有画图句式的
  // 追加意见也接管重画（沿用上次 prompt + 用户反馈），否则模型只会嘴上答应不干活。
  const lastDraw = lastDrawByGroup.get(gid);
  const drawSubj = atMe ? (parseDrawIntent(userText)
    ?? (lastDraw
      && Date.now() - lastDraw.at < 10 * 60 * 1000
      && userText.length <= 60
      && /(改|换|重画|重新画|不对|错了|不像|性别|再来|画错|加个|不要)/.test(userText)
      ? userText : null)) : null;
  const isRedraw = !!(drawSubj && !parseDrawIntent(userText) && lastDraw
    && Date.now() - lastDraw.at < 10 * 60 * 1000);
  let drawVeto = false;   // 翻译层否决 = 不是画图诉求，退回正常对话（不许静默挂起）
  if (drawSubj && !featureOn('imggen', true)) {
    // 生图总闸关着：直接回歇业，不进普通对话（防模型嘴上承诺画却零动作，坑 34 同族）
    console.log(`[bot] 群 ${gid} 生图业务已暂停，直接回绝 <- ${drawSubj.slice(0, 18)}`);
    try { await ctx.reply(text('画画业务暂停营业喵，恢复时间等指挥官通知～')); } catch { /* 发不出去就算了 */ }
    return;
  }
  if (drawSubj) {
    const sid = `img-${gid}`;   // 独立翻译会话：不吃群聊记忆、不占 #上下文 额度
    try {
      const prompt = await translateDrawPrompt(sid, drawSubj, isRedraw ? lastDraw.prompt : '');
      if (!prompt) {
        // 翻译层否决：不是画图诉求，走正常对话继续
        drawVeto = true;
        console.log(`[bot] 群 ${gid} 画图意图被翻译层否决 <- ${drawSubj.slice(0, 18)}`);
      } else {
        console.log(`[bot] 🎨 ${isRedraw ? '改稿路由' : '意图路由'}接管：${drawSubj.slice(0, 30)}\n[bot]    prompt: ${prompt.slice(0, 90)}`);
        await ctx.reply(text(isRedraw
          ? `收到喵，按「${drawSubj.slice(0, 20)}」重新画，要等十几秒～`
          : `正在给指挥官画「${drawSubj.slice(0, 30)}」喵，画画要等十几秒到一分钟，别急～`));

        // 路由本身有 drewImage 语义：走到这步就必然真生成真发送，不存在嘴遁环节
        const buf = await imggen.generateImage(prompt);
        // 同上：SDK 默认 30s 掐不死 highway 慢传，给到 120s
        await http.raw('send_group_msg', {
          group_id: Number(gid),
          message: [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }],
        }, { timeoutMs: 120 * 1000 });
        const caption = isRedraw
          ? `改好啦喵～按「${drawSubj.slice(0, 30)}」重新画了一版`
          : `画好啦喵～给指挥官画的是：${drawSubj}`;
        await sendReply(ctx, caption, { strip: cfg.stripMarkdown });

        // 记下这次的 prompt：10 分钟内的「改一下/性别错了」能接着改稿
        lastDrawByGroup.set(gid, { prompt, subj: drawSubj, at: Date.now() });

        // 进对话线（纯文字）：user 记诉求、assistant 记 [已画图]，之后可以接着聊这张画
        pushHistory(gid, 'user', drawSubj, `${displayName(event)}: ${drawSubj}${isRedraw ? ' [要求改图]' : ' [要求画图]'}`);
        pushHistory(gid, 'assistant', `[回 ${displayName(event)}] [已画图: ${drawSubj}] ${caption}`);
      }
    } catch (e) {
      console.error(`[bot] 群 ${gid} 画图出错：`, e.message);
      // 失败提示必须送达（22:41 事故：只 log 没发群里，指挥官干等）；再发不出去也留痕
      try { await ctx.reply(text(`⚠️ 画画失败了喵：${String(e.message).slice(0, 100)}`)); }
      catch (e2) { console.error('[bot] 画图失败提示也发不出去：', e2.message); }
    } finally {
      promptTokens.delete(sid);   // 独立会话的 token 数别留在表里越攒越多
    }
    if (!drawVeto) return;   // 接管成功或失败都到此为止；被否决才放行到正常对话
  }

  // ── 生视频意图强制路由（2026-10-21 上线）─────────────
  // 放在 buildContent 之后（见下方调用处）：要支持图生视频，图来自消息本体或引用。
  // 这里只留个声明位，实际接管在 buildContent 拿到媒体之后。

  // ── 管理指令：不走 LLM、不耗 token、立即返回 ──
  if (cmd) {
    try {
      await handleCommand(cmd, gid, ctx);
    } catch (e) {
      console.error(`[bot] 指令 ${cmd} 出错：`, e.message);
      // 一定要给用户反馈，别让群里静悄悄
      try {
        await ctx.reply(text(`指令执行失败：${e.message}`));
      } catch { /* 连回复都失败就算了 */ }
    }
    return;
  }

  const content = await buildContent(event);
  if (!content) return;

  // ⚠️ 媒体加载失败必须当场说出口 —— 以前只写进 bot.err，指挥官根本不知道出了什么问题。
  // 放在 LLM 之前发：万一后面 LLM 挂了，这条诊断也已经送达了。
  if (content.mediaErrors?.length) {
    try {
      await ctx.reply(text(`⚠️ [媒体] ${content.mediaErrors.join('；')}`));
    } catch { /* 发不出去就算了，别影响后面的回复 */ }
  }

  // ── 生视频意图强制路由（2026-10-21 上线；下午起支持图生视频）──
  // 放在 buildContent 之后：图生视频的图来自消息本体或引用（expandReplySegs 已并进 parts）。
  // 同画图路由：脚本接管（翻译 -> 提交 -> 轮询 -> 下载 -> 发群），模型没有装成功的机会。
  const videoSubj = atMe ? parseVideoIntent(userText) : null;
  let vidVeto = false;
  if (videoSubj && !featureOn('vidgenEnabled', cfg.vidgenEnabled !== false)) {
    // 总闸关着：直接告知歇业，不放行进普通对话（免得模型嘴上承诺「这就生成」又装成功，坑 34 同族）
    console.log(`[bot] 群 ${gid} 生视频业务已暂停，直接回绝 <- ${videoSubj.slice(0, 18)}`);
    try { await ctx.reply(text('生视频业务暂停营业喵，恢复时间等指挥官通知～')); } catch { /* 发不出去就算了 */ }
    return;
  }
  if (videoSubj) {
    const sid = `vid-${gid}`;   // 独立翻译会话：不吃群聊记忆、不占 #上下文 额度
    try {
      // 图生视频：拿本轮视觉里的第一张图（消息附带的或引用里的都算）
      const imgPart = content.parts.find((p) =>
        p.type === 'image_url' && String(p.image_url?.url ?? '').startsWith('data:'));
      const imgDataUrl = imgPart ? imgPart.image_url.url : '';

      const prompt = await translateVideoPrompt(sid, videoSubj);
      if (!prompt) {
        vidVeto = true;
        console.log(`[bot] 群 ${gid} 生视频意图被翻译层否决 <- ${videoSubj.slice(0, 18)}`);
      } else {
        console.log(`[bot] 🎬 ${imgDataUrl ? '图生视频' : '文生视频'}意图路由接管：${videoSubj.slice(0, 30)}\n[bot]    prompt: ${prompt.slice(0, 90)}`);
        await ctx.reply(text(imgDataUrl
          ? `收到喵，按指挥官给的图生视频，要几分钟，别干等～`
          : `正在给指挥官生成视频喵，这个要几分钟，先去干点别的别干等～`));

        const buf = await vidgen.generateVideo(prompt, imgDataUrl);
        // 视频比图大（实测 5.5MB/8s），highway 上传更慢，超时给到 5 分钟
        await http.raw('send_group_msg', {
          group_id: Number(gid),
          message: [{ type: 'video', data: { file: 'base64://' + buf.toString('base64') } }],
        }, { timeoutMs: 300 * 1000 });
        const caption = imgDataUrl
          ? `生成好啦喵～按指挥官给的图做的是：${videoSubj}`
          : `生成好啦喵～给指挥官做的是：${videoSubj}`;
        await sendReply(ctx, caption, { strip: cfg.stripMarkdown });

        // 进对话线（纯文字），之后可以接着聊这条视频
        pushHistory(gid, 'user', videoSubj, `${displayName(event)}: ${videoSubj} [要求生视频${imgDataUrl ? '，按图' : ''}]`);
        pushHistory(gid, 'assistant', `[回 ${displayName(event)}] [已生成视频: ${videoSubj}] ${caption}`);
      }
    } catch (e) {
      console.error(`[bot] 群 ${gid} 生视频出错：`, e.message);
      try { await ctx.reply(text(`⚠️ 生成视频失败了喵：${String(e.message).slice(0, 100)}`)); }
      catch (e2) { console.error('[bot] 生视频失败提示也发不出去：', e2.message); }
    } finally {
      promptTokens.delete(sid);
    }
    if (!vidVeto) return;
  }

  try {
    await maybeCompress(gid);   // 上下文到阈值就先压缩，再进本轮

    const hasVideo = content.parts.some((p) => p.type === 'video_url');
    const baseText = `${displayName(event)}: ${content.rawText || '[发来一条媒体消息]'}`;

    // 视频走「描述式」：本轮发原片给模型看（否则没法解析视频），
    // 同时要它在同一次回答里写一句画面描述，由下面摘走放进上下文。
    let reply = (await askLLM(
      `group-${gid}`,
      content.parts,
      lengthHint() + (hasVideo ? VIDEO_DESC_HINT : ''),
    )).trim();

    // 摘走「〔视频描述〕」那行：正文发群，描述进上下文，原片不留
    let videoDesc = '';
    if (hasVideo) {
      const m = /〔视频描述〕\s*([\s\S]*)$/.exec(reply);
      if (m) {
        videoDesc = m[1].split('\n')[0].trim().slice(0, 60);   // 先取行再去空格，反了会留尾空格
        reply = reply.slice(0, m.index).trim();
      }
    }

    // 模型看到上下文里全是「[回 xxx]」开头的记录，会有样学样自己也编一个（还常编错人）。
    // 发出去之前摘掉，署名统一由下面一行用正确的名字加。
    reply = reply.replace(/^\s*\[回[^\]]*\]\s*/, '').trim();

    // ⚠️ 历史必须在 LLM 调用之后再存 —— 否则同一条消息会同时出现在 history 和 userContent 里，
    //    图片/视频被发两遍、白白双倍计费。
    pushHistory(
      gid,
      'user',
      stickyParts(content.parts),   // 视频不进、超大图不进
      videoDesc ? `${baseText} [视频：${videoDesc}]` : baseText,
    );
    // 署名：群聊多人插话，标明这条回复是回给谁的，模型才不会张冠李戴。
    // 用户消息本来就带「群名片: 内容」前缀，assistant 这条补上对应关系。
    pushHistory(gid, 'assistant', `[回 ${displayName(event)}] ${reply}`);

    if (!reply) return;
    if (cfg.stripMarkdown) reply = stripMd(reply);
    if (cfg.maxReplyChars > 0 && reply.length > cfg.maxReplyChars) {
      reply = reply.slice(0, cfg.maxReplyChars) + '…';
    }

    // 长回复自动分段连发，避免单条被 QQ 吞掉或挤成一坨
    const chunks = splitMessage(reply, cfg.chunkChars);
    for (let i = 0; i < chunks.length; i++) {
      await ctx.reply(text(chunks[i]));
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
    const tok = promptTokens.get(`group-${gid}`) ?? '?';
    console.log(`[bot] 群 ${gid}${describeMedia(content.parts)} <- ${content.rawText.slice(0, 18) || '[媒体]'}  ->  ${reply.slice(0, 22)} | tok=${tok}${chunks.length > 1 ? ` 已分${chunks.length}条` : ''}`);
  } catch (e) {
    console.error(`[bot] 群 ${gid} 出错：`, e.message);
    // 出错也要回一句，别让群里静悄悄（媒体过大、接口拒收时尤其需要）
    try {
      await ctx.reply(text(`柴郡这边卡住了一下喵：${String(e.message).slice(0, 80)}`));
    } catch { /* 连回复都失败就算了 */ }
  }
});

await bot.connect();
console.log('[bot] 事件流已连接，等待 @ …');
