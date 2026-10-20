// ═══════════════════════════════════════════════════════════════════════
//  B站视频总结器（命令行入口）
//
//  用法：
//    bun run bilibili-summarize.mjs <B站链接或BV号> [想问的问题]
//  例：
//    bun run bilibili-summarize.mjs BV1GJ411x7h7
//    bun run bilibili-summarize.mjs "https://b23.tv/xxxxx" 这个教程的第三步在干嘛
//
//  核心引擎在 qq-group-bot/bilibili.mjs —— 和群机器人共用同一套，
//  这里只负责进度打印。总结自动存档到 B站总结/<BV>_P<P>.md。
// ═══════════════════════════════════════════════════════════════════════

import { summarizeVideo } from './qq-group-bot/bilibili.mjs';

const [input, ...qRest] = process.argv.slice(2);
if (!input) {
  console.log('用法：bun run bilibili-summarize.mjs <B站链接或BV号> [想问的问题]');
  process.exit(1);
}
const question = qRest.join(' ').trim();

try {
  const r = await summarizeVideo(input, question, (line) => console.log(`[..] ${line}`));
  console.log(`\n模型看完了${r.usage ? `（prompt ${r.usage.prompt_tokens} / completion ${r.usage.completion_tokens} tok）` : ''}，总结如下：\n`);
  console.log('═'.repeat(50));
  console.log(r.summary);
  console.log('═'.repeat(50));
  console.log(`\n[i] 已存档：B站总结/${r.bvid}_P${r.page}.md`);
} catch (e) {
  console.error(`[x] 失败：${e.message}`);
  process.exit(1);
}
