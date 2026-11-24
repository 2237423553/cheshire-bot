// 图生图独立通道：本轮原文 + 一张真实参考图；不依赖会话模型/历史 prompt。
export function originalEditText(event) {
  return (Array.isArray(event.message) ? event.message : [])
    .filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('');
}

// 问句/评论防护（所有「带参考图就接」的规则共用）——「生成甚么了」=「生成什么了」
// 的异体写法（11-23 实锤白烧一次编辑），所以 什么/甚么/啥 全收 + 句尾疑问助词兜底。
const QUESTION_RE = /(?:[?？]|什么|甚么|啥|怎么|为什么|是不是|多少|哪里|谁|AI|人工智能|(?:是[^，。\n]{0,8}(?:生成的?|画的?|做的?|修的?))|(?:[嘛么吗呢啥]\s*[了呀吧]?\s*$))/;

export function isEditIntent(raw, hasReference = false) {
  const t = raw.trim();
  // 只匹配句首明确指令；问图、评论图、泛泛讨论修图不产生费用。
  if (/^(?:图生图|改图|修图)(?:怎么|如何|是什么|有没有|支持吗|吗|呢|？|\?)/.test(t)) return false;
  if (/^(?:(?:请|帮我|给我|能不能|可以|麻烦)\s*)*(?:图生图|改图|修图|编辑(?:这张|此|图片)|修改(?:这张|此|图片)|重画|重新画|改成|改为|换成|换为|改一下|再改一下)/.test(t)) return true;
  if (/^(?:(?:请|帮我|给我|能不能|可以|麻烦)\s*)*(?:背景|头发|衣服|发色|颜色)(?:改成|改为|换成|换为)/.test(t)) return true;
  // 「把…」分支放宽（2026-11-18 群内实锤：『把图片中的人物换成痞老板』没被
  // 旧正则接住，落去文生图被审核拦，用户干等无图）。要求句中明确出现图像词，
  // 且带改动词，避免「把话说清楚」这类误伤。
  if (/^(?:请|帮我|给我)?\s*[把将][^\n]{0,16}?(?:图|照片|画面|头像|背景)[^\n]{0,12}?(?:改成|改为|换成|换为|去掉|移除|加上|变成|弄成|做成)/.test(t)) return true;
  if (/^(?:请|帮我|给我)?\s*(?:把|将)(?:这张图|这张图片|图中|背景|她|他|它|头发|衣服)/.test(t)
    && /(?:改成|改为|换成|换为|去掉|移除|加上|变成)/.test(t)) return true;
  if (/^(?:请|帮我|给我)?\s*(?:在|给)(?:这张图|图中|她|他|它).*(?:加上|加个|加一|去掉|换成)/s.test(t)) return true;
  // 引用/附带图 + 场景式改图诉求（11-18 群内实锤：「全身出镜，让俺春物的平冢静/由比滨
  // 结衣/一色彩羽都穿修身旗袍合照」——没有「改图/换成」字面但明确要动这张图）。
  // 问句与评论（这张图的表情绝了）不算。
  if (hasReference && !QUESTION_RE.test(t)
    && /(?:出镜|合照|合影|都穿|穿上|换装)/.test(t)) return true;
  // 引用/附带图 + 画/生成诉求走真参考图编辑（11-19 实锤：「再生成一个第三人称
  // 视角的。」句首多个「再」字没被接住，落去文生图凭空编了张无关图）。
  // 兜底大闸（11-19 第四漏实锤：「按照这个聊天记录生成一张图」句首是「按照」，
  // 前三轮修的都是句首动词，追不完）。只要有参考图 + 文本含画/生成 + 非问句评论
  // → 一律走图生图，不再按句式挨个接。防误伤（11-23 实锤：「生成甚么了」=问句，
  // 被「生成」前缀规则抢走白烧一次编辑）：统一走 QUESTION_RE + 最短 6 字
  // （真改图指令要么命中前面句式规则要么比这长）。
  if (hasReference && /(?:画|生成)/.test(t) && t.length >= 6
    && !QUESTION_RE.test(t)) return true;
  return hasReference && /^(?:请|帮我|给我)?\s*(?:再|重新)?\s*(?:画|生成)\s*\S/s.test(t)
    && !/^(?:请|帮我|给我)?\s*(?:再|重新)?\s*(?:画|生成).{0,12}(?:代码|脚本|文档|视频)/s.test(t)
    && !QUESTION_RE.test(t);
}

export class ImageEditRouter {
  constructor({ now = Date.now, ttl = 10 * 60 * 1000 } = {}) {
    this.now = now; this.ttl = ttl; this.successes = new Map();
  }
  key(scope, user) { return JSON.stringify([String(scope), String(user)]); }
  remember(scope, user, image) {
    const now = this.now();
    for (const [key, value] of this.successes) if (now - value.at >= this.ttl) this.successes.delete(key);
    this.successes.delete(this.key(scope, user));
    this.successes.set(this.key(scope, user), { image: Buffer.from(image), at: now });
    // 有界内存；最多保留 32 张、总共 64MB，不持久化用户图。
    let bytes = [...this.successes.values()].reduce((n, v) => n + v.image.length, 0);
    for (const [key, value] of this.successes) {
      if (bytes <= 64 * 1024 * 1024 && this.successes.size <= 32) break;
      bytes -= value.image.length; this.successes.delete(key);
    }
  }
  previous(scope, user) {
    const key = this.key(scope, user), value = this.successes.get(key);
    if (value && this.now() - value.at < this.ttl) return value.image;
    this.successes.delete(key); return null;
  }
  async run({ event, scope, enabled, loadReply, loadImage, edit, send, ack, judge }) {
    const segs = Array.isArray(event.message) ? event.message : [];
    const prompt = originalEditText(event);
    const attached = segs.filter(s => s.type === 'image');
    const replies = segs.filter(s => s.type === 'reply');
    const hasRef = attached.length > 0 || replies.length > 0;
    // ── 语义判意优先（2026-11-23 指挥官拍板）：带参考图的消息先让模型判一句
    // 「是不是要基于这张图改图/生成」，判完再路由——正则按句式追永远追不完
    // （五轮猫鼠游戏：漏四次+误伤一次）。判官返回：true=改图 / false=不是 / null=判官失灵。
    if (hasRef && judge) {
      let verdict = null;
      try { verdict = await judge(prompt); } catch { verdict = null; }
      if (verdict === false) return false;
      if (verdict === true) {
        // 判官说改就走，不再过正则（正则只是判官失灵时的回退）
      } else if (!isEditIntent(prompt, true)) return false;   // 判官失灵 → 回退正则
    } else if (!isEditIntent(prompt, hasRef)) return false;
    if (!enabled) throw new Error('画画业务暂停营业');
    let candidates = attached;
    if (!candidates.length && replies.length) {
      // 显式引用优先且失败不回退，避免误拿用户上次成功图。
      if (replies.length !== 1) throw new Error('请只引用一条含图片的消息');
      const quoted = await loadReply(replies[0].data?.id);
      if (quoted?.group_id != null && String(quoted.group_id) !== String(scope)) throw new Error('引用图片不属于当前会话');
      if (String(scope).startsWith('pv') && (quoted?.group_id != null || String(quoted?.user_id ?? quoted?.sender?.user_id) !== String(event.user_id))) throw new Error('无法确认私聊引用图片归属');
      candidates = (Array.isArray(quoted?.message) ? quoted.message : []).filter(s => s.type === 'image');
      if (!candidates.length) throw new Error('引用消息没有可用图片，请附上一张参考图');
    }
    // 多图支持（2026-11-23 指挥官指示）：官方 edits 端点最多 16 张参考图，
    // 多图合照/对比场景直接全收，不再「首版仅单张」。
    if (candidates.length > 16) throw new Error('参考图最多 16 张，多的先删掉再发');
    const references = candidates.length
      ? await Promise.all(candidates.map((s) => loadImage(s)))
      : [this.previous(scope, event.user_id)].filter(Boolean);
    if (!references.length || references.some((b) => !b?.length)) throw new Error('缺少可用参考图片，请附图或引用含图消息');
    // 「收到」回执 + 接管日志（11-19 实锤：编辑一把 1~3 分钟且全程无日志，
    // 群里体感就是没反应——出图慢可以等，无声干等不行）
    if (ack) { try { await ack(); } catch { /* 回执发不出去不挡正事 */ } }
    const output = await edit(prompt, references);
    await send(output);
    this.remember(scope, event.user_id, output);
    return true;
  }
}
