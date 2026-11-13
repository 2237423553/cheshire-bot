// ═══════════════════════════════════════════════════════════════════════
//  外形词脚本硬闸（2026-11-11）—— 铁律「角色外形一个字都不要编」靠模型自觉被实锤
//  破防（霞之丘诗羽被翻译器编成 silver-haired，实际黑发），软约束不可靠，改脚本机械兜底：
//  翻译层产出的 prompt 里出现发色/发型/瞳色类外形词、且用户原话没点名对应特征时，
//  直接删词放行（删词比拒画好，画面其余部分照用）。用户亲口点名的特征原样保留
//  （11-10 指挥官铁令：明确要求原样直达，闸只拦模型编的，不拦用户要的）。
//
//  范围说明：
//  - 只机械拦「发色/发型/瞳色」这三类——它们是角色识别的核心特征（诗羽实锤编错发色
//    直接画成另一个人），词表封闭、误伤可控
//  - 服饰/装备细节不在闸内：与场景画风词纠缠太深，机械删会毁画面，
//    服饰编造仍靠铁律软约束 + 改稿纠偏
// ═══════════════════════════════════════════════════════════════════════

/** 外形词规则表：re=英文外形描述词；need=用户原话必须包含的 CJK 关键词（命中任一即放行）。
 *  need 另有英文兜底：用户原话里出现过同款英文词也放行（中英混用的指挥官）。 */
const RULES = [
  { re: /\b(?:silver|platinum)[- ]haired\b|\b(?:silver|platinum) hair\b/gi, need: ['银'] },
  { re: /\b(?:golden|blonde|blond)[- ]haired\b|\b(?:golden|blonde|blond) hair\b/gi, need: ['金'] },
  { re: /\bwhite[- ]haired\b|\bwhite hair\b/gi, need: ['白发', '白'] },
  { re: /\bblack[- ]haired\b|\bblack hair\b/gi, need: ['黑'] },
  { re: /\bbrown[- ]haired\b|\bbrown hair\b/gi, need: ['棕', '茶'] },
  { re: /\b(?:red|crimson)[- ]haired\b|\b(?:red|crimson) hair\b/gi, need: ['红'] },
  { re: /\bpink[- ]haired\b|\bpink hair\b/gi, need: ['粉'] },
  { re: /\bblue[- ]haired\b|\bblue hair\b/gi, need: ['蓝'] },
  { re: /\bpurple[- ]haired\b|\bpurple hair\b/gi, need: ['紫'] },
  { re: /\bgreen[- ]haired\b|\bgreen hair\b/gi, need: ['绿'] },
  { re: /\b(?:grey|gray)[- ]haired\b|\b(?:grey|gray) hair\b/gi, need: ['灰'] },
  { re: /\borange[- ]haired\b|\borange hair\b/gi, need: ['橙', '橘'] },
  { re: /\btwin[- ]?tails?\b|\btwintails?\b/gi, need: ['双马尾'] },
  { re: /\b(?:side[- ]tail|ponytail)s?\b/gi, need: ['马尾'] },
  { re: /\bbraids?\b|\bbraided\b/gi, need: ['辫', '编发'] },
  { re: /\bhime[- ]cut\b/gi, need: ['姬发', '公主切'] },
  { re: /\bahoge\b/gi, need: ['呆毛'] },
  { re: /\bshort hair\b/gi, need: ['短发'] },
  { re: /\blong hair\b/gi, need: ['长发'] },
  { re: /\b(?:silver|golden|blue|green|red|brown|amber|grey|gray|purple|pink)[- ]eyes\b/gi, need: ['瞳', '眼'] },
  { re: /\bheterochromia\b/gi, need: ['异色瞳', '异瞳'] },
];

/** 「definitely not X」式角色否定句机械摘除——生图引擎对否定句经常反向画（画什么来什么），
 *  且这类句子只可能是模型自己加的（用户否定要求走「不要X」→ without/no，不会长这样）。 */
const NEGATION_RE = /,?\s*(?:and\s+)?definitely not\b[^,.]*/gi;

function cleanup(s) {
  return s
    .replace(/ {2,}/g, ' ')
    .replace(/ , /g, ', ')
    .replace(/, ?,/g, ',')
    .replace(/, ?\./g, '.')
    .replace(/^,?\s*/, '')
    .trim();
}

/** 过闸：返回 { text, stripped }。stripped=被删的外形词/否定句清单（空数组=原样放行）。
 *  subj=用户本轮原话（新画=原始请求；改稿=改稿反馈），只信它来判定「用户点名」。 */
export function stripInventedAppearance(prompt, subj) {
  const user = String(subj ?? '');
  const stripped = [];
  let text = String(prompt ?? '');

  for (const { re, need } of RULES) {
    re.lastIndex = 0;
    text = text.replace(re, (m) => {
      // 用户点名判定：CJK 关键词任一命中，或原话里出现同款英文词
      if (need.some((k) => user.includes(k))) return m;
      const en = (m.match(/[a-z]+/i) ?? [''])[0];
      if (en && new RegExp(`\\b${en}\\b`, 'i').test(user)) return m;
      stripped.push(m.trim());
      return '';
    });
  }

  text = text.replace(NEGATION_RE, (m) => { stripped.push(m.trim()); return ''; });
  text = cleanup(text);
  if (stripped.length) {
    console.log(`[bot] ✂️ 外形硬闸删除（用户未点名）：${stripped.join(' | ')} <- 用户原话「${user.slice(0, 30)}」`);
  }
  return { text, stripped };
}
