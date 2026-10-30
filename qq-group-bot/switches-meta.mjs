// ═══════════════════════════════════════════════════════════════════════
//  功能开关清单 —— 唯一来源
//
//  bot.mjs（启动快照 + 各业务闸）与 api-panel.mjs（面板开关卡）都从这份清单
//  生成。之前是两处手抄，已经漂移过（面板漏 tts，10-30 评审）——
//  加开关只改这里，别再往别处抄键名。
//
//  def：switches.json 里没写这个键时的缺省值。'config' = 跟 cfg.vidgenEnabled
//  （生视频的出厂默认统一由 config.mjs 管；其余开关都是「不写即开」）。
// ═══════════════════════════════════════════════════════════════════════
export const SWITCHES = [
  { key: 'search', label: '搜索', def: true },
  { key: 'imggen', label: '画画', def: true },
  { key: 'bilibili', label: 'B站总结', def: true },
  { key: 'vidgenEnabled', label: '生视频', def: 'config' },
  { key: 'repeat', label: '复读', def: true },
  { key: 'beacon', label: '信标', def: true },
  { key: 'tts', label: '语音', def: true },
];
