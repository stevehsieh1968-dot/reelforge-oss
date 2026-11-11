// 開源版的「來源切換」：配音、AI 畫面、補圖、說書人對嘴，各自可以選免費來源或 Gemini
// 設定在 .env：TTS_PROVIDER / VIDEO_PROVIDER / IMAGE_PROVIDER / LIPSYNC_PROVIDER
import fs from 'node:fs/promises';
import { config } from './config.js';
import * as gemini from './gemini.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PEXELS = (process.env.PEXELS_API_BASE || 'https://api.pexels.com').replace(/\/$/, ''); // 測試時可指向假的服務
const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ================= 配音 ================= */

// Gemini 聲線名稱（Aoede…）→ 本機配音服務的聲線 key（female-warm…）
function localVoiceKey(voice) {
  if (!voice) return 'female-warm';
  if (/^local_/.test(voice) || config.voices[voice]) return voice;
  const hit = Object.entries(config.voices).find(([, v]) => v.voiceName === voice);
  return hit ? hit[0] : 'female-warm';
}

async function localTts(path, init, label) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${config.localTtsUrl}${path}`, { ...init, signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!r.ok) {
        const msg = (await r.text()).slice(0, 400);
        const e = httpError(r.status >= 500 ? 502 : 400, `${label}失敗：${msg}`);
        if (r.status < 500) throw Object.assign(e, { final: true });
        throw e;
      }
      return r;
    } catch (e) {
      if (e.final) throw e;
      lastErr = e;
      if (/ECONNREFUSED|fetch failed/i.test(String(e?.cause?.code || e?.message))) {
        throw httpError(503, `連不到本機配音服務（${config.localTtsUrl}）：請先執行「啟動配音服務.bat」，或在 .env 把 TTS_PROVIDER 改成 gemini`);
      }
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

// 回傳 { data: Buffer, mime }，和 gemini.synthesizeSpeech 一樣
export async function synthesizeSpeech(text, voice) {
  if (config.ttsProvider === 'gemini') return gemini.synthesizeSpeech(text, voice);
  const r = await localTts(
    '/tts',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: localVoiceKey(voice) }) },
    '產生配音'
  );
  return { data: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'audio/wav' };
}

// 說書人聲音：內建（prompted）或複製（replicated）；回傳 voice id
export async function createVoice(opts) {
  if (config.ttsProvider === 'gemini') return gemini.createVoice(opts);
  if (config.mock) return `local_mock_${opts.type}_${Math.random().toString(36).slice(2, 8)}`;
  if (opts.type === 'prompted') return `local_preset_${opts.presetId || 'story-female'}`;
  const r = await localTts(
    '/voices',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: opts.displayName, source: opts.source, transcript: opts.transcript || '' })
    },
    '建立聲音'
  );
  const json = await r.json();
  if (!json.id) throw new Error('本機配音服務沒有回傳聲音 id');
  return json.id;
}

// 聲音複製前要唸的同意聲明（本機版不經過 Google）
export function consentText() {
  return config.ttsProvider === 'gemini' ? null : '我是此聲音的擁有者，並同意使用此聲音建立語音合成模型';
}

/* ================= Pexels 免費影片庫／圖庫 ================= */

async function pexels(url) {
  if (!config.pexelsApiKey) throw httpError(400, '沒有設定 PEXELS_API_KEY：請到 https://www.pexels.com/api/ 免費申請，填進 .env');
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { Authorization: config.pexelsApiKey }, signal: AbortSignal.timeout(30000) });
    if (r.status === 429) {
      await sleep(5000 * (i + 1));
      continue;
    }
    if (!r.ok) throw new Error(`Pexels 搜尋失敗（${r.status}）：${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  throw new Error('Pexels 一直回傳「請求太多」，請稍後再試');
}

async function download(url, outPath) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!r.ok) throw new Error(`下載素材失敗（${r.status}）`);
  await fs.writeFile(outPath, Buffer.from(await r.arrayBuffer()));
}

// 關鍵字找不到東西時，逐步放寬（去掉最後一個字）
async function searchLoose(make, query, pick) {
  let words = String(query || '').split(/\s+/).filter(Boolean);
  if (!words.length) words = ['lifestyle'];
  while (words.length) {
    const list = pick(await pexels(make(words.join(' '))));
    if (list.length) return list;
    words = words.slice(0, -1);
  }
  return pick(await pexels(make('people lifestyle')));
}

// 找一段直式實拍影片：盡量挑長度夠、解析度接近 1080×1920 的
async function pexelsVideo({ query, seconds, variant = 0, outPath }) {
  const list = await searchLoose(
    (q) => `${PEXELS}/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&size=medium&per_page=20`,
    query,
    (j) => (j.videos || []).filter((v) => (v.video_files || []).some((f) => f.file_type === 'video/mp4'))
  );
  if (!list.length) throw new Error(`影片庫找不到「${query}」的畫面`);
  // 長度夠的排前面，其次是越接近需要的長度越好
  const ranked = [...list].sort((a, b) => (b.duration >= seconds) - (a.duration >= seconds) || Math.abs(a.duration - seconds) - Math.abs(b.duration - seconds));
  const video = ranked[variant % ranked.length];
  const files = video.video_files.filter((f) => f.file_type === 'video/mp4' && f.height >= f.width);
  const pool = files.length ? files : video.video_files.filter((f) => f.file_type === 'video/mp4');
  // 挑高度最接近 1920 的（太大的 4K 下載慢、合成也慢）
  const file = pool.sort((a, b) => Math.abs((a.height || 0) - 1920) - Math.abs((b.height || 0) - 1920))[0];
  await download(file.link, outPath);
  return { id: video.id, url: video.url, author: video.user?.name, duration: video.duration };
}

async function pexelsPhoto({ query, variant = 0, outPath }) {
  const list = await searchLoose(
    (q) => `${PEXELS}/v1/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=20`,
    query,
    (j) => j.photos || []
  );
  if (!list.length) throw new Error(`圖庫找不到「${query}」的照片`);
  const photo = list[variant % list.length];
  await download(photo.src?.portrait || photo.src?.large2x || photo.src?.original, outPath);
  return { id: photo.id, url: photo.url, author: photo.photographer };
}

/* ================= AI 畫面（場景動態） ================= */

// 這個場景要不要走「AI 動態」那條路（kenburns 模式一律直接鏡頭推移）
export function wantsMotion({ hasOwnImage }) {
  if (config.videoProvider === 'kenburns') return false;
  if (config.videoProvider === 'pexels') return !hasOwnImage || config.pexelsReplaceUploads;
  return true;
}

// 回傳 { usd, info }；被安全過濾會丟出 e.safety
export async function sceneVideo({ imagePath, mime, prompt, outPath, seconds, query, variant }) {
  if (config.videoProvider === 'gemini') {
    await gemini.imageToVideo({ imagePath, mime, prompt, outPath, seconds });
    return { usd: null };
  }
  if (config.videoProvider === 'pexels') {
    const info = await pexelsVideo({ query, seconds, variant, outPath });
    return { usd: 0, info };
  }
  throw Object.assign(new Error('鏡頭推移模式'), { safety: true });
}

/* ================= 補圖 ================= */

export async function generateImage({ prompt, outPath, query, variant = 0 }) {
  if (config.imageProvider === 'gemini' || config.mock) return gemini.generateImage({ prompt, outPath });
  if (config.imageProvider === 'none') throw httpError(400, '目前設定不補圖（IMAGE_PROVIDER=none），請自己上傳圖片');
  const q = query || (await gemini.stockQuery({ visual: prompt, motionPrompt: prompt }));
  await pexelsPhoto({ query: q, variant, outPath });
  return 'image/jpeg';
}
export const imagePrice = () => (config.imageProvider === 'gemini' && !config.mock ? config.imagePrice : 0);

/* ================= 說書人對嘴 ================= */

export const lipsyncEnabled = () => config.lipsyncProvider === 'gemini';
