// ═══════════════════════════════════════════════════════════════════════
//  LLM 状态 / 配置档案的唯一写入口
//
//  - llmstate.json：运行时真源（config.mjs 启动时读它覆盖默认值）
//    六字段：llmUrl / llmKey / model / thinking / modelList / llmHeaders
//  - llm-profiles.json：多套「URL+Key+模型+头」配置档案（含真 Key，勿进仓）
//
//  ⚠️ 所有写盘都走这里（tmp + rename 原子写），CLI 和 Web 面板都不许自己
//     直接写这两个文件 —— 两边同时改是「后写覆盖先写」，页脚/帮助里注明。
// ═══════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
export const STATE_PATH = path.join(__dir, 'llmstate.json');
export const PROFILES_PATH = path.join(__dir, 'llm-profiles.json');

/** 原子写：先写 .tmp 再 rename（Windows 上 rename 覆盖已有文件可靠） */
function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 给面板等邻域模块用的通用原子写（switches.json / mediaapi.json 也走这套，别自己 fs.writeFileSync） */
export function writeJsonAtomic(file, obj) {
  writeAtomic(file, obj);
}

/** 读 json 文件，坏/缺失返回 null */
export function readJson(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 读 llmstate.json；不存在/坏 JSON 返回 null（config.mjs 静默回默认，同口径） */
export function loadState() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 全量写 llmstate 六字段。传 undefined/null 的字段不落盘（config.mjs 会回默认值） */
export function saveState({ llmUrl, llmKey, model, thinking, modelList, llmHeaders }) {
  const o = {};
  if (llmUrl != null && llmUrl !== '') o.llmUrl = llmUrl;
  if (llmKey != null && llmKey !== '') o.llmKey = llmKey;
  if (model != null && model !== '') o.model = model;
  if (thinking != null) o.thinking = thinking;          // null 视为「不传思考参数」，合法值
  if (modelList != null) o.modelList = modelList;
  if (llmHeaders != null) o.llmHeaders = llmHeaders;
  writeAtomic(STATE_PATH, o);
  return STATE_PATH;
}

// ── 配置档案 ──
function loadProfiles() {
  try {
    const o = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    if (o && Array.isArray(o.profiles)) return o;
  } catch { /* 不存在/坏文件从零开始 */ }
  return { version: 1, activeId: null, profiles: [] };
}

export function listProfiles() {
  return loadProfiles();
}

/** 新建/更新档案。id 空则新建（时间戳 + 随机尾巴）；传 probe 项则存探测摘要 */
export function upsertProfile({ id, name, llmUrl, llmKey, model, thinking, llmHeaders, modelList, probe }) {
  if (!name || !llmUrl) throw new Error('档案至少要有名字和 URL');
  const db = loadProfiles();
  let p = id ? db.profiles.find((x) => x.id === id) : null;
  if (!p) {
    p = { id: `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: new Date().toISOString() };
    db.profiles.push(p);
  }
  Object.assign(p, {
    name: String(name).slice(0, 60),
    llmUrl,
    model: model ?? p.model,
    thinking: thinking !== undefined ? thinking : p.thinking,
    llmHeaders: llmHeaders ?? p.llmHeaders ?? {},
    updatedAt: new Date().toISOString(),
  });
  // key：显式给了就更新（面板打码回填时空串=沿用），没给沿用旧值
  if (llmKey) p.llmKey = llmKey;
  else if (llmKey === '') p.llmKey = p.llmKey ?? '';
  if (modelList) p.modelList = modelList;
  if (probe) p.probe = probe;
  writeAtomic(PROFILES_PATH, db);
  return p;
}

export function deleteProfile(id) {
  const db = loadProfiles();
  const i = db.profiles.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('没这个档案');
  db.profiles.splice(i, 1);
  if (db.activeId === id) db.activeId = null;
  writeAtomic(PROFILES_PATH, db);
  return true;
}

/** 启用档案：六字段整体覆盖写 llmstate + 记录 activeId（两次原子写，state 先落） */
export function applyProfile(id) {
  const db = loadProfiles();
  const p = db.profiles.find((x) => x.id === id);
  if (!p) throw new Error('没这个档案');
  saveState({
    llmUrl: p.llmUrl,
    llmKey: p.llmKey ?? '',
    model: p.model,
    thinking: p.thinking,
    modelList: p.modelList,
    llmHeaders: p.llmHeaders ?? {},
  });
  db.activeId = id;
  p.updatedAt = new Date().toISOString();
  writeAtomic(PROFILES_PATH, db);
  return p;
}

export function activeProfileId() {
  return loadProfiles().activeId;
}
