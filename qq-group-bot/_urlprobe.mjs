import { cfg } from './config.mjs';
const t0 = Date.now();
const r = await fetch(cfg.llmUrl, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${cfg.llmKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'qq-group-bot/1.0',
    'x-opencode-session': 'probe-url-video',
  },
  body: JSON.stringify({
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'video_url', video_url: { url: 'https://example-files.cnbj1.mi-fds.com/example-files/video/video_example.mp4' }, fps: 2, media_resolution: 'default' },
        { type: 'text', text: '一句话描述这段视频' },
      ],
    }],
  }),
});
const t = await r.text();
console.log('HTTP', r.status, `${Date.now() - t0}ms`);

try { const j = JSON.parse(t); console.log('err:', JSON.stringify(j.error)?.slice(0,200)); console.log('content:', JSON.stringify(j.choices?.[0]?.message?.content)?.slice(0,200)); } catch { console.log(t.slice(0,200)); }
