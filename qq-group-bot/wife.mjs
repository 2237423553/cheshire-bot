// ═══════════════════════════════════════════════════════════
//  今日老婆 / 签到 / 本命老婆（2026-11-10 从旧版 project_g2_3.py 接回）
//
//  数据全部住在 ../register_table/（与旧版文件同名同格式，直接沿用）：
//    老婆池   fig_data.json     旧版 data.json 的原样拷贝（591 位；
//                                zh_name: / en_name: / jp_name: / add / words）
//    用户档   register_dict.json 旧版同名文件（QQ号 -> 配置），已有的用户数据直接继承
//             字段：magic_cubes / consecutive_checkins / total_checkins /
//                   last_checkin_date / wife（'none' 或老婆池下标）
//  图在 ../downloaded_images（扁平存放，按文件名取）。
//
//  命令解析在 bot.mjs（parseWifeCommand），本模块只负责业务：
//  run({ uid, nickname, kind, arg }) 返回「按顺序发送的步骤」——
//    [{ type: 'text', text }, { type: 'image', path }, ...]
//  步骤顺序沿用旧版：扣魔方 → 发图 → 报名字 → 两条台词。
//
//  ⚠️ 用户档读写全部同步完成（读-改-写之间没有 await）：
//     Node 单线程下这就是原子操作，同一个人连点两次不会把魔方扣丢一次；
//     整表 temp+rename 原子替换，写一半断电也不会留半截档。
// ═══════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REGISTER_DIR = path.resolve(__dir, '..', 'register_table');
const IMAGE_DIR = path.resolve(__dir, '..', 'downloaded_images');
const DATA_FILE = path.join(REGISTER_DIR, 'fig_data.json');
const TABLE_FILE = path.join(REGISTER_DIR, 'register_dict.json');

const INITIAL_CUBES = 30;      // 新用户初始魔方（旧版同值）
const CHECKIN_CUBES = 10;      // 每次签到 +10
const DRAW_COST = 2;           // 一次随机抽卡 -2
const FATE_CHANCE = 0.5;       // 本命老婆：五成概率直接出本命、不扣魔方
const FATE_MIN_SCORE = 0.3;    // 模糊匹配低于这个分数就当没找到（旧版没阈值，会瞎认）

// ─────────── 老婆池（fig_data.json 原样字段 -> 内部结构）───────────
let pool = null;
function characters() {
  if (pool) return pool;
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('fig_data.json 结构不对（应为数组）');
  pool = [];
  for (const item of raw) {
    const images = [...new Set((item.add ?? [])
      .map((p) => String(p).split(/[\\/]/).pop())
      .filter(Boolean))];
    const words = (item.words ?? []).map((w) => String(w).trim()).filter(Boolean);
    if (!images.length || !words.length) continue;
    pool.push({
      zh: String(item['zh_name:'] ?? '').trim(),
      jp: String(item['jp_name:'] ?? '').trim(),
      en: String(item['en_name:'] ?? '').trim(),
      images,
      words,
    });
  }
  if (!pool.length) throw new Error('老婆池是空的（fig_data.json 解析出 0 条）');
  return pool;
}

// 上次抽到的下标（内存态，重启归零；旧版 wife_before 同款）——连着抽不重样
let lastIndex = -1;

// ─────────── 用户档（register_dict.json 整表读写）───────────
function readTable() {
  let s = '';
  try {
    s = fs.readFileSync(TABLE_FILE, 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return {};   // 还没人登记过
    throw new Error(`register_dict.json 读取失败：${e.message}`);
  }
  if (!s) return {};
  let o;
  try {
    o = JSON.parse(s);
  } catch (e) {
    throw new Error(`register_dict.json 不是合法 JSON：${e.message}`);
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    throw new Error('register_dict.json 结构不对（应为 QQ号 -> 配置 的对象）');
  }
  return o;
}

function saveTable(table) {
  fs.mkdirSync(REGISTER_DIR, { recursive: true });
  const tmp = `${TABLE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(table, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, TABLE_FILE);   // 同目录 rename 原子替换
}

/** 把表里的一条配置补全成内部结构；保留未知字段（别的功能将来可以共用这张表） */
function userOf(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...o,
    magic_cubes: Number.isFinite(o.magic_cubes) ? o.magic_cubes : INITIAL_CUBES,
    consecutive_checkins: Number.isFinite(o.consecutive_checkins) ? o.consecutive_checkins : 0,
    total_checkins: Number.isFinite(o.total_checkins) ? o.total_checkins : 0,
    last_checkin_date: typeof o.last_checkin_date === 'string' ? o.last_checkin_date : null,
    wife: typeof o.wife === 'string' && o.wife ? o.wife : 'none',
  };
}

// ─────────── 日期键（本地时区 YYYY-MM-DD）───────────
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayKey = () => dateKey(new Date());
function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateKey(d);
}

// ─────────── 签到（旧版 remark 的等价实现）───────────
/** 就地修改 table；调用方负责 saveTable */
function checkin(table, uid, nickname) {
  const user = userOf(table[uid]);
  if (user.last_checkin_date === todayKey()) {
    table[uid] = user;   // 旧版同样会在「已签到」时落盘（创建新档那一次要靠它）
    return { user, message: `${nickname} 今天已经签到过了哦` };
  }
  user.consecutive_checkins = user.last_checkin_date === yesterdayKey() ? user.consecutive_checkins + 1 : 1;
  user.magic_cubes += CHECKIN_CUBES;
  user.total_checkins += 1;
  user.last_checkin_date = todayKey();
  table[uid] = user;
  return {
    user,
    message: `${nickname}的数据已更新：魔方数量=${user.magic_cubes}, 连续签到天数=${user.consecutive_checkins}, 累计签到天数=${user.total_checkins}`,
  };
}

// ─────────── 抽卡 ───────────
function pickImage(character) {
  const left = character.images.slice();
  while (left.length) {
    const [name] = left.splice(Math.floor(Math.random() * left.length), 1);
    const p = path.join(IMAGE_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;   // 图全丢了就只发名字，别把整条流程炸掉
}

function pickWords(words, n) {
  const left = words.slice();
  const out = [];
  while (out.length < n && left.length) {
    out.push(left.splice(Math.floor(Math.random() * left.length), 1)[0]);
  }
  return out;
}

function draw(uid, nickname, mode) {
  const steps = [];
  const table = readTable();
  let user = table[uid] ? userOf(table[uid]) : null;
  let dirty = false;

  // 旧版：没档就先走一次签到（白送 30+10=40 魔方），今天已经签过就只提示
  if (!user) {
    const c = checkin(table, uid, nickname);
    user = c.user;
    dirty = true;
    steps.push({ type: 'text', text: c.message });
  }

  if (user.magic_cubes <= 1) {
    if (dirty) saveTable(table);
    steps.push({
      type: 'text',
      text: `${nickname} 的魔方不够了喵（当前 ${user.magic_cubes} 个）……先去签到攒点再抽吧～`,
    });
    return steps;
  }

  // 本命老婆：只有「今日老婆」有这待遇（今日老婆2 = 纯随机），五成概率白嫖
  let index = -1;
  if (mode === 'today' && user.wife !== 'none') {
    const w = Number(user.wife);
    if (Number.isInteger(w) && w >= 0 && w < characters().length && Math.random() < FATE_CHANCE) {
      index = w;
    }
  }

  const paid = index < 0;
  if (paid) {
    const n = characters().length;
    index = Math.floor(Math.random() * n);
    // 避免和前一个人抽到同一个（旧版 wife_before 同款；只有一位老婆时认命）
    for (let guard = 0; n > 1 && index === lastIndex && guard < 20; guard++) {
      index = Math.floor(Math.random() * n);
    }
    user.magic_cubes -= DRAW_COST;
    table[uid] = user;
    dirty = true;
    steps.push({ type: 'text', text: `${nickname} 的魔方 -2 当前：${user.magic_cubes}` });
  }
  if (dirty) saveTable(table);
  lastIndex = index;

  const c = characters()[index];
  const img = pickImage(c);
  if (img) steps.push({ type: 'image', path: img });
  steps.push({ type: 'text', text: `${nickname} 你的老婆是： ${c.zh} ${c.jp} ${c.en}` });
  for (const w of pickWords(c.words, 2)) steps.push({ type: 'text', text: w });
  return steps;
}

// ─────────── 本命老婆（模糊匹配）───────────
function normalizeName(s) {
  // 只留文字和数字（中英日都算 \p{L}），空格/标点/符号一律去掉
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Levenshtein 相似度（0~1），替代旧版 difflib.SequenceMatcher.ratio */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function setFate(uid, nickname, arg) {
  const input = String(arg ?? '').trim();
  if (!input) {
    return [{ type: 'text', text: '用法：本命老婆 <名字>（例：本命老婆 大凤）' }];
  }
  const list = characters();
  const q = normalizeName(input);

  // ① 精确命中中/日/英任一名字 —— 用户照着数据里的全名抄时直接认
  let index = list.findIndex((c) =>
    [c.zh, c.jp, c.en].some((n) => n && normalizeName(n) === q));
  let score = 1;

  // ② 没有精确命中再模糊：口径与旧版一致，只看中文名（中文名为空才退日文）。
  //    不能把日文名也拿来模糊 —— 「大凤」会被「大山」（日文名=大山）以更短的编辑距离抢走。
  if (index < 0) {
    let best = { score: -1, index: -1, len: Infinity };
    for (let i = 0; i < list.length; i++) {
      const zh = normalizeName(list[i].zh);
      const target = zh || normalizeName(list[i].jp);
      if (!target) continue;
      const s = similarity(q, target);
      if (s > best.score || (s === best.score && target.length < best.len)) {
        best = { score: s, index: i, len: target.length };
      }
    }
    index = best.index;
    score = best.score;
  }

  if (index < 0 || score < FATE_MIN_SCORE) {
    return [{ type: 'text', text: `没找到叫「${input}」的老婆喵～换个名字试试？` }];
  }

  const table = readTable();
  const user = userOf(table[uid]);   // 没签到过也允许先定本命（只建空档，不白送签到）
  user.wife = String(index);
  table[uid] = user;
  saveTable(table);

  const c = list[index];
  const fuzzy = score < 1 ? '（按最像的算）' : '';
  return [{ type: 'text', text: `${nickname} 已指定本命老婆：${c.zh}${fuzzy}` }];
}

// ─────────── 对外入口 ───────────
export function run({ uid, nickname, kind, arg }) {
  const name = String(nickname ?? '').trim() || '指挥官';
  if (kind === 'checkin') {
    const table = readTable();
    const { message } = checkin(table, uid, name);
    saveTable(table);
    return [{ type: 'text', text: message }];
  }
  if (kind === 'today' || kind === 'today2') return draw(uid, name, kind);
  if (kind === 'fate') return setFate(uid, name, arg);
  return [{ type: 'text', text: '未知的老婆指令喵' }];
}

/** 老婆池条目数（启动日志用） */
export function wifeCount() {
  return characters().length;
}

/**
 * 检查用户档：register_dict.json 不存在（或为空）就自动创建空表；
 * 已存在则读一遍校验（坏了会抛错，由调用方上报，绝不静默覆盖旧数据）。
 * 启动时调用，返回 { created, normalized, path }：
 *   created    = 文件原本不存在，已新建
 *   normalized = 文件存在但是空文件，已写成 {}
 */
export function ensureRegisterTable() {
  if (!fs.existsSync(TABLE_FILE)) {
    saveTable({});
    return { created: true, normalized: false, path: TABLE_FILE };
  }
  const raw = fs.readFileSync(TABLE_FILE, 'utf8').trim();
  if (!raw) {
    saveTable({});
    return { created: false, normalized: true, path: TABLE_FILE };
  }
  readTable();   // 只校验结构，不改内容
  return { created: false, normalized: false, path: TABLE_FILE };
}
