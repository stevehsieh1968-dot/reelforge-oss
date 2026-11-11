import 'dotenv/config';
import path from 'node:path';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Google 已停用的模型 → 目前的替代模型
const RETIRED = {
  'gemini-2.5-flash': 'gemini-3.8-flash',
  'gemini-2.5-flash-preview-tts': 'gemini-3.8-flash-lite-tts',
  'gemini-2.5-pro-preview-tts': 'gemini-3.8-flash-tts',
  'gemini-3.1-flash-tts-preview': 'gemini-3.8-flash-lite-tts',
  'veo-3.1-generate-preview': 'gemini-omni-1.2-flash',
  'veo-3.1-fast-generate-preview': 'gemini-omni-1.2-flash',
  'veo-3.1-lite-generate-preview': 'gemini-omni-1.2-flash',
  'gemini-omni-flash-preview': 'gemini-omni-1.2-flash',
  'gemini-omni-1.1-flash': 'gemini-omni-1.2-flash',
  'gemini-2.5-flash-image': 'gemini-nano-banana-2.1'
};
function upgradeModel(value, fallback) {
  const v = (value || '').trim();
  if (!v) return fallback;
  if (RETIRED[v]) {
    console.warn(`[設定] 模型 ${v} 已被 Google 停用，自動改用 ${RETIRED[v]}`);
    return RETIRED[v];
  }
  return v;
}

// 每個專案可選 1／2／3 分鐘（需求裡的 duration，單位秒）
export const DURATIONS = [60, 120, 180];
export function targetOf(brief) {
  const d = Number(brief?.duration);
  return DURATIONS.includes(d) ? d : config.targetSeconds;
}

export const config = {
  port: num(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),

  geminiApiKey: process.env.GEMINI_API_KEY || '',

  // ===== 開源版：每一步可以各自選來源（預設最省錢） =====
  // 文案：gemini（便宜、品質好）｜openai（任何 OpenAI 相容服務，例如本機 Ollama）
  textProvider: (process.env.TEXT_PROVIDER || 'gemini').toLowerCase(),
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, ''),
  openaiApiKey: process.env.OPENAI_API_KEY || 'ollama',
  openaiModel: process.env.OPENAI_MODEL || 'qwen3:8b',
  // 配音：local（本機配音服務：edge 免費微軟語音／breezy 聯發科 BreezyVoice）｜gemini
  ttsProvider: (process.env.TTS_PROVIDER || 'local').toLowerCase(),
  localTtsUrl: (process.env.LOCAL_TTS_URL || 'http://127.0.0.1:5100').replace(/\/$/, ''),
  // AI 動態畫面：pixabay／pexels（免費實拍影片庫）｜kenburns（只用鏡頭推移）｜gemini（Omni，付費）
  videoProvider: (process.env.VIDEO_PROVIDER || 'pixabay').toLowerCase(),
  // AI 補圖：pixabay／pexels（免費圖庫）｜gemini（nano-banana，付費）｜none
  imageProvider: (process.env.IMAGE_PROVIDER || 'pixabay').toLowerCase(),
  // 說書人對嘴：off（照片＋鏡頭推移＋配音，免費）｜gemini（Omni，付費）
  lipsyncProvider: (process.env.LIPSYNC_PROVIDER || 'off').toLowerCase(),
  pixabayApiKey: process.env.PIXABAY_API_KEY || '',
  pexelsApiKey: process.env.PEXELS_API_KEY || '',
  // 場景有自己上傳的圖時，仍然換成影片庫畫面（預設不換：保留你的產品圖，用鏡頭推移）
  stockReplaceUploads: (process.env.STOCK_REPLACE_UPLOADS || process.env.PEXELS_REPLACE_UPLOADS) === '1',

  // 模擬模式：MOCK=1，或文案要用 Gemini 卻沒有金鑰
  mock: process.env.MOCK === '1' || ((process.env.TEXT_PROVIDER || 'gemini').toLowerCase() === 'gemini' && !process.env.GEMINI_API_KEY),

  // 模型名稱（Google 改版時只要改 .env）；已停用的舊名稱會自動換成新的
  textModel: upgradeModel(process.env.TEXT_MODEL, 'gemini-3.8-flash'),
  // 主模型忙碌（503）時改用的備用文案模型
  textFallbackModel: process.env.TEXT_FALLBACK_MODEL || 'gemini-3.5-flash-lite',
  ttsModel: upgradeModel(process.env.TTS_MODEL, 'gemini-3.8-flash-lite-tts'),
  videoModel: upgradeModel(process.env.VIDEO_MODEL, 'gemini-omni-1.2-flash'),
  imageModel: upgradeModel(process.env.IMAGE_MODEL, 'gemini-nano-banana-2.1'),
  // 說書人真人對嘴：Omni 依照片＋台詞一次產生「會說話的畫面＋聲音」（每段最長 15 秒）
  lipsyncModel: upgradeModel(process.env.LIPSYNC_MODEL, 'gemini-omni-1.2-flash'),
  lipsyncPricePerSecond: num(process.env.LIPSYNC_PRICE, 0.07),
  lipsyncCharsPerClip: num(process.env.LIPSYNC_CHARS, 48), // 每段最多幾個字（約 11–12 秒）
  lipsyncVoices: {
    'female-warm': { label: '溫柔親切女聲', desc: 'a gentle, warm, friendly Taiwanese woman in her late 30s, soft clear voice, sincere unhurried storytelling pace' },
    'female-bright': { label: '知性明亮女聲', desc: 'a confident, articulate Taiwanese woman in her 30s, bright clear voice, professional yet warm' },
    'male-warm': { label: '溫暖沉穩男聲', desc: 'a warm, calm, sincere middle-aged Taiwanese man, medium-low pitch, unhurried storytelling pace' },
    'male-bright': { label: '明亮活力男聲', desc: 'an energetic, friendly young Taiwanese man in his late 20s, bright upbeat tone' },
    elder: { label: '慈祥長者', desc: 'a kind, gentle elderly Taiwanese storyteller around 65 years old, slow warm voice' }
  },
  imagePrice: num(process.env.IMAGE_PRICE, 0.034),
  videoResolution: process.env.VIDEO_RESOLUTION || '720p',

  veoConcurrency: num(process.env.VEO_CONCURRENCY, 2),
  ttsConcurrency: num(process.env.TTS_CONCURRENCY, 2),
  veoPollMs: num(process.env.VEO_POLL_MS, 10000),

  // 影片規格
  targetSeconds: num(process.env.TARGET_SECONDS, 180),
  sceneCount: num(process.env.SCENE_COUNT, 10), // 預設（建議）場景數；每個專案可另選
  sceneCountOptions: [6, 8, 10, 12, 15, 18],
  shotSeconds: num(process.env.SHOT_SECONDS, 9), // 場景超過這個長度，AI 會拆成多個連續鏡頭
  width: 1080,
  height: 1920,
  fps: 30,

  // 修改規則
  maxRevisions: num(process.env.MAX_REVISIONS, 5),
  maxScenesPerRevision: num(process.env.MAX_SCENES_PER_REVISION, 4),
  fullRedoCost: num(process.env.FULL_REDO_COST, 2),

  // 成本估算用（US$ / 秒），只用於後台記帳
  veoPricePerSecond: num(process.env.VEO_PRICE_PER_SECOND, 0.07), // Omni 1.2 Flash 720p
  usdToTwd: num(process.env.USD_TO_TWD, 32.4),

  // 方案：幾個場景用 AI 動態，其餘用鏡頭推移
  tiers: {
    economy: { label: '經濟版', aiRatio: 0.2 },
    standard: { label: '標準版', aiRatio: 0.5 },
    premium: { label: '高階版', aiRatio: 1 }
  },

  // voiceName：Gemini 聲線；本機配音服務用同一個 key（female-warm 等）對應台灣國語聲音
  voices: {
    'female-warm': { label: '女聲・溫暖', voiceName: 'Aoede' },
    'female-bright': { label: '女聲・活潑', voiceName: 'Leda' },
    'male-calm': { label: '男聲・沉穩', voiceName: 'Charon' },
    'male-upbeat': { label: '男聲・輕快', voiceName: 'Puck' }
  },

  // 字幕字型：Windows 內建微軟正黑體、Mac 內建蘋方，Linux／Docker 用思源黑體；可用 SUBTITLE_FONT 指定
  subtitleFont:
    process.env.SUBTITLE_FONT ||
    (process.platform === 'win32' ? 'Microsoft JhengHei' : process.platform === 'darwin' ? 'PingFang TC' : 'Noto Sans CJK TC'),

  // 內建背景音樂（music/*.mp3，程式合成、無版權問題）
  builtinMusic: {
    qin: '琴音（古箏）',
    flute: '長笛',
    piano: '鋼琴',
    guitar: '木吉他',
    pop: '輕快流行'
  },
  // 舊版內建音樂（不再列出，但舊專案仍可使用）
  legacyMusic: ['tech', 'lofi', 'epic'],

  // 語速（倍數）
  speeds: { '0.9': '慢', '1': '標準', '1.1': '稍快', '1.2': '快' },

  subtitleStyles: {
    outline: { label: '白字黑框' },
    box: { label: '品牌色底' },
    karaoke: { label: '逐字跳出' }
  },

  // 場景轉場
  transitions: { fade: '淡入淡出', slide: '滑動', zoom: '推近', none: '直接切換' },
  transitionSeconds: 0.4
};
