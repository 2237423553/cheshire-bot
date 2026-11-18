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
assert.deepEqual(calls[0].ref, image);
await assert.rejects(run(event('other', [{type:'text',data:{text:'改成夜景'}}])), /缺少参考图片/);
await assert.rejects(run(event('u', [{type:'text',data:{text:'改成夜景'}}], 11)), /缺少参考图片/);
for (const question of ['有没有60kg左右的弓', '这张图片是什么？', '改图怎么用？', '图生图是什么？']) assert.equal(isEditIntent(question, true), false);
// 11-18 群内实锤回归：「把图片中的人物换成痞老板」旧正则漏接
assert.equal(isEditIntent('把图片中的人物换成痞老板。衣服不要换', true), true);
assert.equal(isEditIntent('把图里的人物换成痞老板', true), true);
assert.equal(isEditIntent('把背景换成夜晚', true), true);
assert.equal(isEditIntent('把话说清楚', true), false);
assert.equal(isEditIntent('把群名改成测试', true), false);
assert.equal(await run(event('u', [{type:'text',data:{text:'这张图片是什么？'}},{type:'image'}])), false);
await assert.rejects(run(event('new', [{type:'text',data:{text:'改图，画成雨天'}}])), /缺少参考图片/);
await assert.rejects(run(event('u', [{type:'text',data:{text:'改图'}},{type:'image'},{type:'image'}])), /仅支持单张/);
const quoted = await run(event('u', [{type:'text',data:{text:'改图换背景'}},{type:'reply',data:{id:'q'}}]), { reply:{group_id:10,message:[{type:'image'}]} });
assert.equal(quoted, true);
await assert.rejects(run(event('u', [{type:'text',data:{text:'改图'}},{type:'reply',data:{id:'q'}}]), { reply:{group_id:11,message:[{type:'image'}]} }), /不属于当前会话/);
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
console.log('image-edit offline tests passed');
