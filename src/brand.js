// 品牌設定（全域，一份）：data/brand.json，Logo 存在 data/brand/
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export const brandDir = path.join(config.dataDir, 'brand');
const file = path.join(config.dataDir, 'brand.json');

const DEFAULTS = {
  name: '',
  color: '#2F55E4',
  logoFile: null,
  watermark: true, // 右上角 Logo 浮水印
  intro: true, // 開頭 1.5 秒 Logo
  outro: true, // 片尾卡（最後 3 秒）
  ctaText: '', // 片尾行動呼籲，例如「立即私訊預約」
  ctaSub: '', // 片尾小字，例如網址、LINE ID
  narratorName: '', // 說書人名字（小頭像下方顯示）
  narratorPhoto: null, // 說書人照片檔名
  narratorPip: true, // 說書人圓形小頭像（說書人沒出鏡的場景顯示在左下）
  narratorVoice: null, // 說書人的聲音 { id, label, type: 'prompted'|'replicated' }
  narratorLipsync: false, // 真人對嘴（Omni）：說書人出鏡的場景，嘴型與聲音一次產生
  lipsyncVoice: 'female-warm', // 對嘴時 Omni 的聲音類型（config.lipsyncVoices）
  lipsyncVoiceNote: '' // 聲音補充描述，例如「帶一點客家口音」
};

export async function getBrand() {
  try {
    return { ...DEFAULTS, ...JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveBrand(patch) {
  const cur = await getBrand();
  const next = { ...cur };
  if (typeof patch.name === 'string') next.name = patch.name.trim().slice(0, 30);
  if (/^#[0-9a-f]{6}$/i.test(patch.color || '')) next.color = patch.color;
  for (const k of ['watermark', 'intro', 'outro']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  if (typeof patch.ctaText === 'string') next.ctaText = patch.ctaText.trim().slice(0, 24);
  if (typeof patch.ctaSub === 'string') next.ctaSub = patch.ctaSub.trim().slice(0, 40);
  if ('logoFile' in patch) next.logoFile = patch.logoFile;
  if ('narratorPhoto' in patch) next.narratorPhoto = patch.narratorPhoto;
  if (typeof patch.narratorName === 'string') next.narratorName = patch.narratorName.trim().slice(0, 20);
  if (typeof patch.narratorPip === 'boolean') next.narratorPip = patch.narratorPip;
  if ('narratorVoice' in patch) next.narratorVoice = patch.narratorVoice;
  if (typeof patch.narratorLipsync === 'boolean') next.narratorLipsync = patch.narratorLipsync;
  if (config.lipsyncVoices[patch.lipsyncVoice]) next.lipsyncVoice = patch.lipsyncVoice;
  if (typeof patch.lipsyncVoiceNote === 'string') next.lipsyncVoiceNote = patch.lipsyncVoiceNote.trim().slice(0, 60);
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2));
  return next;
}

export function logoPath(brand) {
  return brand.logoFile ? path.join(brandDir, path.basename(brand.logoFile)) : null;
}

export function narratorPath(brand) {
  return brand.narratorPhoto ? path.join(brandDir, path.basename(brand.narratorPhoto)) : null;
}
