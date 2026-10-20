// ═══════════════════════════════════════════════════════════════════════
//  战争雷霆（War Thunder 国际服）战绩查询 —— 走 Thunderskill 的 JSON 导出
//
//  数据源：https://thunderskill.com/en/stat/<昵称>/export/json
//  无需 API key；数据不是实时 —— 玩家被人查过才更新（约 24h 一次），
//  所以回复里必须带上 lastStat（数据更新时间），别让指挥官以为是刚打的。
//
//  模式键：a = 街机(AB) / r = 历史(RB) / s = 全真(SB)
// ═══════════════════════════════════════════════════════════════════════

const CACHE_TTL = 10 * 60 * 1000;   // 同名 10 分钟内直接用缓存
const cache = new Map();            // 小写昵称 -> { at, data }

const MODE_NAMES = { a: '街机', r: '历史', s: '全真' };

export async function fetchStats(nick) {
  const name = String(nick ?? '').trim();
  if (!name) throw new Error('没给玩家名');
  if (name.length > 40) throw new Error('玩家名太长了，要游戏内的完整昵称');

  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const path = `/en/stat/${encodeURIComponent(name)}/export/json`;
  const hosts = ['https://thunderskill.com', 'https://www.thunderskill.com'];
  // 这个站从国内访问时好时坏（实测既有超时也有 2~8s 慢连），所以要重试 + 换备用域名
  let r = null;
  let lastErr = '';
  outer:
  for (let attempt = 0; attempt < 3; attempt++) {
    const host = hosts[attempt % hosts.length];
    try {
      r = await fetch(host + path, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(30000),
      });
      break outer;
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? '超时' : e.message;
      r = null;
    }
  }
  if (!r) throw new Error(`连不上 Thunderskill（${lastErr}，重试 3 次都不行）——过会儿再试`);

  if (r.status === 404 || r.status === 403) {
    throw new Error(`Thunderskill 没有收录「${name}」——这个站只统计被人查过的玩家，先去 thunderskill.com 搜一次这个名字，明天再来查`);
  }
  if (!r.ok) throw new Error(`Thunderskill HTTP ${r.status}`);

  let j;
  try {
    j = await r.json();
  } catch {
    throw new Error('Thunderskill 返回的不是 JSON，可能网站改版了');
  }
  const s = j?.stats;
  if (!s?.nick) throw new Error(`没查到「${name}」的战绩`);

  const fmt = (m) => (m ? {
    kd: m.kd ?? null,
    winrate: m.winrate ?? null,          // 百分数，如 50.22
    missions: m.mission ?? 0,            // 出击场次
    killsPerBattle: m.kb ?? null,        // 场均击杀
    kdAir: m.kd_air ?? null,             // 空/陆细分
    kdGround: m.kd_ground ?? null,
  } : null);

  const data = {
    nick: s.nick,
    rank: s.rank ?? '',
    lastStat: s.last_stat ?? '',
    modes: {},
  };
  for (const k of Object.keys(MODE_NAMES)) data.modes[MODE_NAMES[k]] = fmt(s[k]);

  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);   // 防缓存无限涨
  return data;
}

/** 把战绩渲染成群消息文本（指令和工具共用一个格式） */
export function formatStats(d) {
  const line = (name) => {
    const m = d.modes?.[name];
    if (!m || !m.missions) return `  ${name}：无数据`;
    return `  ${name}：K/D ${m.kd ?? '?'} · 胜率 ${m.winrate ?? '?'}% · ${m.missions} 场` +
      (m.killsPerBattle != null ? ` · 场均击杀 ${m.killsPerBattle}` : '');
  };
  return (
    `【战争雷霆战绩】${d.nick}\n` +
    (d.rank ? `评级：${d.rank}\n` : '') +
    `${line('街机')}\n${line('历史')}\n${line('全真')}\n` +
    `数据更新：${d.lastStat || '未知'}（Thunderskill，非实时）`
  );
}
