import assert from 'node:assert/strict';
import { ImageEditRouter, originalEditText, isEditIntent } from './image-edit.mjs';
import { editImage } from './imggen.mjs';

const image = Buffer.from([137,80,78,71,13,10,26,10,1]);
const router = new ImageEditRouter();
const text = `改成中文舰名
不要改变黑发
名字：霞之丘诗羽
${'细节'.repeat(800)}`;
const event = (user, message, group = 10) => ({ user_id: user, group_id: group, message });
const calls = [];
const run = (e, extra = {}) => router.run({
  event: e, scope: e.group_id ?? `pv${e.user_id}`, enabled: true,
  loadReply: async id => extra.reply,
  loadImage: async () => image,
  edit: async (prompt, ref) => { calls.push({ prompt, ref }); return image; },
  send: async () => {},
  ...extra,
});

assert.equal(originalEditText(event('u', [{type:'at',data:{qq:'bot'}},{type:'text',data:{text:'  中文\n不要翻译  '}}])), '  中文\n不要翻译  ');
assert.equal(await run(event('u', [{type:'text',data:{text}} ,{type:'image'}])), true);
assert.equal(calls[0].prompt, text);
assert.deepEqual(calls[0].ref, [image]);   // 多图升级后统一传数组
await assert.rejects(run(event('other', [{type:'text',data:{text:'改成夜景'}}])), /缺少可用参考图片/);
await assert.rejects(run(event('u', [{type:'text',data:{text:'改成夜景'}}], 11)), /缺少可用参考图片/);
for (const question of ['有没有60kg左右的弓', '这张图片是什么？', '改图怎么用？', '图生图是什么？']) assert.equal(isEditIntent(question, true), false);
// 11-18 群内实锤回归：「把图片中的人物换成痞老板」旧正则漏接
assert.equal(isEditIntent('把图片中的人物换成痞老板。衣服不要换', true), true);
assert.equal(isEditIntent('把图里的人物换成痞老板', true), true);
assert.equal(isEditIntent('把背景换成夜晚', true), true);
assert.equal(isEditIntent('把话说清楚', true), false);
assert.equal(isEditIntent('把群名改成测试', true), false);
// 11-18 群内实锤回归：场景式改图（无改图字面、引用图）
const sceneReq = '全身出镜，然后让俺春物的平冢静，由比滨结衣，一色彩羽都穿修身旗袍（根据人物特性设计）几人在一起合照';
assert.equal(isEditIntent(sceneReq, true), true);
assert.equal(isEditIntent(sceneReq, false), false);
assert.equal(isEditIntent('这张图的表情绝了', true), false);
assert.equal(isEditIntent('这张图全身都露出来了？', true), false);
// 11-19 群内实锤回归：「再生成…」句首带「再/重新」也要接住
assert.equal(isEditIntent('再生成一个第三人称视角的。', true), true);
assert.equal(isEditIntent('重新画一张，视角拉远', true), true);
assert.equal(isEditIntent('再画一张天空的', true), true);
assert.equal(isEditIntent('再生成一个第三人称视角的。', false), false);
// 11-19 第四漏回归：句首「按照/根据」类兜底大闸
assert.equal(isEditIntent('按照这个聊天记录生成一张图', true), true);
assert.equal(isEditIntent('根据这张图再画一张全身的', true), true);
assert.equal(isEditIntent('这图是AI生成的吧', true), false);
assert.equal(isEditIntent('这张图是谁画的', true), false);
assert.equal(isEditIntent('这张图是用什么软件生成的', true), false);
assert.equal(isEditIntent('画一张猫', true), true);   // 有参考图在手，画/生成一律带图走编辑
assert.equal(isEditIntent('画一张猫', false), false); // 无参考图的纯文生图诉求，不归图生图管
// 11-23 误伤回归：问「生成什么了」（含异体「甚么/基么」）不是改图指令
assert.equal(isEditIntent('生成甚么了', true), false);
assert.equal(isEditIntent('生成基么了', true), false);
assert.equal(isEditIntent('生成完了吗', true), false);
assert.equal(await run(event('u', [{type:'text',data:{text:'这张图片是什么？'}},{type:'image'}])), false);
await assert.rejects(run(event('new', [{type:'text',data:{text:'改图，画成雨天'}}])), /缺少可用参考图片/);
// 多图支持（2026-11-23 指挥官指示升级）：两张参考图全收
assert.equal(await run(event('u', [{type:'text',data:{text:'改图'}},{type:'image'},{type:'image'}])), true);
assert.equal(calls.at(-1).ref.length, 2);
const quoted = await run(event('u', [{type:'text',data:{text:'改图换背景'}},{type:'reply',data:{id:'q'}}]), { reply:{group_id:10,message:[{type:'image'}]} });
assert.equal(quoted, true);
await assert.rejects(run(event('u', [{type:'text',data:{text:'改图'}},{type:'reply',data:{id:'q'}}]), { reply:{group_id:11,message:[{type:'image'}]} }), /不属于当前会话/);
// 私聊放开归属校验（2026-11-23 误杀实锤）：pv 里引用带 group_id 的消息也放行
assert.equal(await run(event('pv1', [{type:'text',data:{text:'改图'}},{type:'reply',data:{id:'q'}}], null), { reply:{group_id:5,message:[{type:'image'}]} }), true);
const previous = await run(event('u', [{type:'text',data:{text:'改图加上月亮'}}]));
assert.equal(previous, true);
const beforeFailure = router.previous(10, 'u').toString('hex');
await assert.rejects(router.run({event:event('u',[{type:'text',data:{text:'改图'}}]),scope:10,enabled:true,edit:async()=>{throw Error('offline')},send:async()=>{}}), /offline/);
assert.equal(router.previous(10,'u').toString('hex'), beforeFailure);
let fetchCalled = false;
const config = {imggenEditUrl:'https://local.invalid/edit', imggenEditProtocol:'openai-multipart',imggenModel:'model',imggenKey:'test'};
await editImage(text,image,{config,fetchImpl:async (url,init)=>{fetchCalled=true; const form=init.body; assert.equal(form.get('prompt'),text); assert.equal(form.get('model'),'model'); assert.equal(form.get('image').type,'image/png'); return {ok:true,json:async()=>({data:[{b64_json:image.toString('base64')}]})};}});
assert.equal(fetchCalled,true);
await assert.rejects(editImage('x',image,{config:{...config,imggenEditUrl:''},fetchImpl:()=>{throw Error('must not call')}}), /不会转文生图/);
// ── 判官路径（2026-11-23 指挥官拍板：模型判意优先，正则退居回退）──
const judgeCalls = [];
const judgeRun = (e, verdict) => router.run({
  event: e, scope: e.group_id ?? `pv${e.user_id}`, enabled: true,
  loadReply: async () => undefined, loadImage: async () => image,
  edit: async (prompt, ref) => { judgeCalls.push({ prompt, ref }); return image; },
  send: async () => {},
  judge: async () => verdict,
});
// 判官说不是 → 直接放行，正则再中也不烧钱
assert.equal(await judgeRun(event('u', [{type:'text',data:{text:'改图换成夜景'}},{type:'image'}]), false), false);
assert.equal(judgeCalls.length, 0);
// 判官说是 → 放行，哪怕正则认不出（「把这张做成表情包风格」旧正则不中）
assert.equal(await judgeRun(event('u2', [{type:'text',data:{text:'把这张做成表情包风格'}},{type:'image'}]), true), true);
assert.equal(judgeCalls.length, 1);
assert.equal(judgeCalls[0].prompt, '把这张做成表情包风格');
// 判官失灵（null/抛错）→ 回退正则：正则认得出的照样触发、认不出的照样不触发
assert.equal(await judgeRun(event('u3', [{type:'text',data:{text:'真可爱'}},{type:'image'}]), null), false);
assert.equal(await judgeRun(event('u4', [{type:'text',data:{text:'改图加上月亮'}},{type:'image'}]), null), true);
assert.equal(judgeCalls.length, 2);
// 判官抛异常同失灵处理
assert.equal(await judgeRun(event('u5', [{type:'text',data:{text:'真可爱'}},{type:'image'}]), undefined), false);
console.log('image-edit offline tests passed');
