// 說書人：內建虛擬人物照片、內建說書人聲音（聲音設計）、複製說書人聲音（聲音複製）
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import * as providers from './providers.js';
import { run } from './media.js';
import { brandDir, getBrand, saveBrand, narratorPath } from './brand.js';

const libDir = path.join(config.dataDir, 'library');
const libFile = path.join(libDir, 'library.json');

// 內建虛擬說書人（AI 生成的虛構人物，沒有肖像權問題）
export const PHOTO_PRESETS = [
  { id: 'warm-woman', label: '溫暖女性（40 多歲）', prompt: 'A warm, kind Taiwanese woman in her mid 40s, shoulder-length black hair, soft cardigan, gentle smile, looking at the camera, cozy living room with warm lamp light in the background, half-body portrait' },
  { id: 'gentle-man', label: '溫和男性（50 多歲）', prompt: 'A calm, trustworthy Taiwanese man in his early 50s with thin glasses and a neat shirt, friendly expression, looking at the camera, a bright study room with bookshelves in the background, half-body portrait' },
  { id: 'young-woman', label: '親切年輕女性', prompt: 'A friendly Taiwanese woman in her late 20s with natural makeup and a casual blouse, bright smile, looking at the camera, a sunny cafe in the background, half-body portrait' },
  { id: 'young-man', label: '陽光年輕男性', prompt: 'A cheerful Taiwanese man in his early 30s with short hair and a simple knit sweater, confident smile, looking at the camera, a modern bright office in the background, half-body portrait' },
  { id: 'elder', label: '慈祥長者', prompt: 'A kind elderly Taiwanese man in his late 60s with grey hair and a warm smile, simple collared shirt, looking at the camera, a peaceful garden courtyard in the background, half-body portrait' }
];

// 內建說書人聲音（用 Gemini 聲音設計，第一次使用時建立，之後重複使用）
export const VOICE_PRESETS = [
  { id: 'story-female', label: '溫暖女聲說書人', gender: 'female', prompt: 'A warm, gentle Taiwanese woman in her 40s telling a story, speaking Mandarin Chinese with a soft Taiwan accent, calm and unhurried pace, intimate and comforting like a bedtime story.' },
  { id: 'story-male', label: '沉穩男聲說書人', gender: 'male', prompt: 'A calm, trustworthy Taiwanese man in his 50s, deep warm voice with a slight rasp, speaking Mandarin Chinese with a Taiwan accent, steady storytelling pace, sincere and reassuring.' },
  { id: 'bright-female', label: '親切明亮女聲', gender: 'female', prompt: 'A friendly, bright Taiwanese woman in her late 20s, speaking Mandarin Chinese with a natural Taiwan accent, lively but clear, smiling while she talks.' },
  { id: 'elder-male', label: '慈祥長者男聲', gender: 'male', prompt: 'A kind elderly Taiwanese man in his late 60s, slow and gentle voice, speaking Mandarin Chinese with a Taiwan accent, wise and caring like a grandfather sharing life stories.' }
];

// 中文同意聲明（Google 規定的簡體字原文，用國語照著唸即可）
export const CONSENT_ZH = '我是此声音的拥有者并授权谷歌使用此声音创建语音合成模型';
export const CONSENT_ZH_TW = '我是此聲音的擁有者並授權谷歌使用此聲音創建語音合成模型';

async function readLib() {
  try {
    return JSON.parse(await fs.readFile(libFile, 'utf8'));
  } catch {
    return { photos: {}, voices: {} };
  }
}
async function writeLib(lib) {
  await fs.mkdir(libDir, { recursive: true });
  await fs.writeFile(libFile, JSON.stringify(lib, null, 2));
}

export async function presetsView() {
  const lib = await readLib();
  return {
    photos: PHOTO_PRESETS.map((p) => ({ id: p.id, label: p.label, ready: Boolean(lib.photos[p.id]), url: lib.photos[p.id] ? `/api/narrator/preset-photo/${p.id}` : null })),
    voices: VOICE_PRESETS.map((v) => ({ id: v.id, label: v.label, ready: Boolean(lib.voices[v.id]) })),
    consent: providers.consentText() || CONSENT_ZH_TW
  };
}

export async function presetPhotoPath(id) {
  const lib = await readLib();
  return lib.photos[id] ? path.join(libDir, path.basename(lib.photos[id])) : null;
}

// 用內建虛擬說書人當說書人照片（第一次用時 AI 生成，約 US$0.034）
export async function usePresetPhoto(id) {
  const preset = PHOTO_PRESETS.find((p) => p.id === id);
  if (!preset) throw Object.assign(new Error('沒有這個內建說書人'), { status: 400 });
  const lib = await readLib();
  let file = lib.photos[id];
  if (!file || !(await fs.stat(path.join(libDir, file)).catch(() => null))) {
    await fs.mkdir(libDir, { recursive: true });
    const tmp = path.join(libDir, `${id}.tmp`);
    // 內建說書人必須是 AI 生成的虛構人物；圖庫照片是真人，不能拿來當品牌代言人
    if (config.imageProvider !== 'gemini' && !config.mock) {
      throw Object.assign(new Error('內建虛擬說書人需要 Gemini 生圖（第一次約 US$0.034，之後重複使用）。請上傳自己的照片，或在 .env 暫時設 IMAGE_PROVIDER=gemini'), { status: 400 });
    }
    const mime = await providers.generateImage({ prompt: preset.prompt + '. Fictional person, not a celebrity.', outPath: tmp });
    file = `narrator-${id}${mime === 'image/png' ? '.png' : '.jpg'}`;
    await fs.rename(tmp, path.join(libDir, file));
    lib.photos[id] = file;
    await writeLib(lib);
  }
  const brand = await getBrand();
  if (brand.narratorPhoto) await fs.unlink(narratorPath(brand)).catch(() => {});
  await fs.mkdir(brandDir, { recursive: true });
  const dest = `narrator-${crypto.randomUUID()}${path.extname(file)}`;
  await fs.copyFile(path.join(libDir, file), path.join(brandDir, dest));
  return saveBrand({ narratorPhoto: dest });
}

// 內建說書人聲音（聲音設計）
export async function usePresetVoice(id) {
  const preset = VOICE_PRESETS.find((v) => v.id === id);
  if (!preset) throw Object.assign(new Error('沒有這個內建聲音'), { status: 400 });
  const lib = await readLib();
  let voiceId = lib.voices[id];
  // 換過配音來源（gemini ↔ 本機）時，舊的聲音 id 不能用，要重建
  if (voiceId && /^local_/.test(voiceId) !== (config.ttsProvider !== 'gemini')) voiceId = null;
  if (!voiceId) {
    voiceId = await providers.createVoice({ type: 'prompted', presetId: id, displayName: preset.label, gender: preset.gender, prompt: preset.prompt });
    lib.voices[id] = voiceId;
    await writeLib(lib);
  }
  return saveBrand({ narratorVoice: { id: voiceId, label: preset.label, type: 'prompted', preset: id } });
}

// 複製說書人的聲音：樣本（10–30 秒）＋同意聲明錄音
export async function cloneVoice(sourceFile, consentFile, label = '說書人的聲音') {
  const tmp = path.join(libDir, `clone-${crypto.randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const src = path.join(tmp, 'source.wav');
    const con = path.join(tmp, 'consent.wav');
    // 轉成 24kHz 單聲道 16-bit WAV；樣本最多取 30 秒
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', sourceFile, '-t', '30', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', src]);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', consentFile, '-t', '20', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', con]);
    const secs = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src])).trim());
    if (secs < 9.5) throw Object.assign(new Error(`聲音樣本只有 ${secs.toFixed(1)} 秒，請錄 10–30 秒`), { status: 400 });
    const voiceId = await providers.createVoice({
      type: 'replicated',
      displayName: label,
      source: (await fs.readFile(src)).toString('base64'),
      consent: (await fs.readFile(con)).toString('base64')
    });
    return saveBrand({ narratorVoice: { id: voiceId, label, type: 'replicated' } });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
