// 影片產生流程：配音 → 對時 → 畫面（AI 動態／鏡頭推移）→ 字幕 → 合成
// 每個中間產物都依內容雜湊快取，修改時只會重做真的改到的場景。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, targetOf } from './config.js';
import { getProject, updateProject, projectDir } from './store.js';
import * as gemini from './gemini.js';
import * as providers from './providers.js';
import * as media from './media.js';
import { getBrand, logoPath, narratorPath } from './brand.js';

const MUSIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'music');

const hash = (...parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

// 同一個快取檔只做一次：其他人等它完成；先寫暫存檔再改名，避免寫到一半被讀到
const inflight = new Map();
async function buildOnce(out, make) {
  if (await media.exists(out)) return out;
  if (inflight.has(out)) return inflight.get(out);
  const job = (async () => {
    const tmp = out.replace(/(\.\w+)$/, `.tmp-${crypto.randomUUID().slice(0, 8)}$1`);
    try {
      await make(tmp);
      await fs.rename(tmp, out);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
    return out;
  })().finally(() => inflight.delete(out));
  inflight.set(out, job);
  return job;
}

async function limitAll(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function setJob(id, patch) {
  await updateProject(id, (p) => {
    p.job = { ...(p.job || {}), ...patch, updatedAt: new Date().toISOString() };
  });
}

async function placeholderImage(dir) {
  const file = path.join(dir, 'cache', 'placeholder.png');
  if (!(await media.exists(file))) {
    await media.run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x22232A:s=${config.width}x${config.height}`, '-frames:v', '1', file]);
  }
  return file;
}

/* ---------- 1. 配音 ---------- */
export async function narrationFor(dir, scene, settings, idx) {
  // 說書人自己錄的聲音：直接用，不呼叫 AI 配音
  if (scene.voiceFile) {
    const key = hash('rec', path.basename(scene.voiceFile));
    const out = path.join(dir, 'cache', `rec-${key}.wav`);
    await buildOnce(out, (tmp) => media.voiceToWav(scene.voiceFile, tmp));
    return { file: out, key, seconds: await media.duration(out), idx, recorded: true };
  }
  // 聲線：內建（Aoede 等）或說書人的自訂聲音（voice_…）
  const voiceName = settings.voice === 'narrator' && settings.narratorVoiceId ? settings.narratorVoiceId : (config.voices[settings.voice] || Object.values(config.voices)[0]).voiceName;
  // v2：新版配音（只送旁白、正確解碼、修頭尾）；舊快取不再沿用
  const key = hash('tts-v2', scene.narration, voiceName, config.ttsProvider === 'gemini' ? config.ttsModel : config.ttsProvider, config.mock, scene.ttsVariant || 0);
  const out = path.join(dir, 'cache', `tts-${key}.wav`);
  await buildOnce(out, async (tmp) => {
    if (config.mock) {
      await media.mockSpeech(scene.narration, tmp);
    } else {
      const audio = await providers.synthesizeSpeech(scene.narration, voiceName);
      await media.speechToWav(audio, tmp);
    }
  });
  return { file: out, key, seconds: await media.duration(out), idx };
}

/* ---------- 2. 對時：讓全片接近 3 分鐘 ---------- */
// locked：說書人對嘴場景，聲音和嘴型綁在一起，不能變速、不能拉長
const LOCK_GAP = 0.2;
export function planTiming(speechSecs, speed = 1, target = config.targetSeconds, locked = []) {
  const minGap = 0.35;
  const free = speechSecs.filter((_, i) => !locked[i]);
  const nFree = free.length;
  const lockedTotal = speechSecs.reduce((a, s, i) => a + (locked[i] ? s + LOCK_GAP : 0), 0);
  const speech = free.reduce((a, b) => a + b, 0);
  // 照使用者選的語速；旁白太長裝不進 3 分鐘時才自動再加快（最多 1.35 倍）
  const needed = nFree ? speech / Math.max(1, target - lockedTotal - nFree * minGap) : 1;
  // 自動加快最多到 1.35 倍；使用者自己選更快（最高 1.5）就照使用者的
  const tempo = Math.min(1.5, Math.max(0.8, speed, Math.min(needed, 1.35)));
  const spoken = speechSecs.map((s, i) => (locked[i] ? s : s / tempo));
  const base = spoken.reduce((a, s, i) => a + s + (locked[i] ? LOCK_GAP : minGap), 0);
  const extra = nFree ? Math.max(0, target - base) / nFree : 0; // 不足的時間平均分給一般場景（畫面多停留一下）
  const durations = spoken.map((s, i) => (locked[i] ? s + LOCK_GAP : Math.max(4, s + minGap + extra)));
  return { tempo, spoken, durations };
}

/* ---------- 說書人真人對嘴 ---------- */
// 把一場的旁白切成每段不超過 max 個字（先照句號，再照逗號）
export function splitForLipsync(text, max = config.lipsyncCharsPerClip) {
  const len = (x) => [...x].length;
  const sentences = String(text || '').replace(/\s+/g, '').match(/[^。！？!?；;]+[。！？!?；;」』）)]*|.+$/g) || [];
  const pieces = [];
  for (const sen of sentences) {
    if (len(sen) <= max) { pieces.push(sen); continue; }
    let cur = '';
    for (const part of sen.match(/[^，,、：:]+[，,、：:]?/g) || [sen]) {
      if (len(cur + part) > max && cur) { pieces.push(cur); cur = ''; }
      if (len(part) > max) {
        const chars = [...part];
        for (let k = 0; k < chars.length; k += max) pieces.push(chars.slice(k, k + max).join(''));
      } else cur += part;
    }
    if (cur) pieces.push(cur);
  }
  // 把相鄰的短句併在一起，減少段數（每段都要付最少 3 秒）
  const chunks = [];
  for (const p of pieces) {
    if (chunks.length && len(chunks[chunks.length - 1] + p) <= max) chunks[chunks.length - 1] += p;
    else chunks.push(p);
  }
  return chunks.filter((c) => c.replace(/[\p{P}\s]/gu, ''));
}

function lipsyncVoiceDesc(brand) {
  const v = config.lipsyncVoices[brand.lipsyncVoice] || Object.values(config.lipsyncVoices)[0];
  return brand.lipsyncVoiceNote ? `${v.desc}; ${brand.lipsyncVoiceNote}` : v.desc;
}

// 回傳 { video, audio, seconds, key }；被安全過濾回傳 null（改用一般說書人做法）
async function lipsyncFor({ dir, text, idx, variant, narrator, brand, costLog }) {
  const chunks = splitForLipsync(text);
  if (!chunks.length) return null;
  const voiceDesc = lipsyncVoiceDesc(brand);
  const parts = [];
  for (const [k, chunk] of chunks.entries()) {
    const est = Math.min(15, Math.max(3, Math.ceil([...chunk].length / 4.2 + 1.2)));
    const key = hash('talk', path.basename(narrator.photo), chunk, voiceDesc, est, variant, config.lipsyncModel, config.mock);
    const raw = path.join(dir, 'cache', `talk-${key}.mp4`);
    const blocked = path.join(dir, 'cache', `talk-${key}.blocked`);
    if (await media.exists(blocked)) return null;
    try {
      await buildOnce(raw, async (tmp) => {
        if (config.mock && !(process.env.MOCK_BLOCK || '').split(',').includes(String(idx + 1))) {
          await media.mockTalking(narrator.photo, tmp, est);
          return;
        }
        if (config.mock) {
          await fs.writeFile(blocked, '模擬安全過濾');
          const e = new Error('模擬安全過濾');
          e.safety = true;
          throw e;
        }
        try {
          await gemini.talkingVideo({ imagePath: narrator.photo, mime: narrator.mime, text: chunk, voiceDesc, seconds: est, outPath: tmp });
        } catch (e) {
          if (e.safety) await fs.writeFile(blocked, e.message);
          throw e;
        }
        const got = await media.duration(tmp).catch(() => est);
        costLog.push({ type: 'lipsync', model: config.lipsyncModel, scene: idx + 1, shot: k + 1, seconds: Math.round(got * 10) / 10, usd: Math.round(got * config.lipsyncPricePerSecond * 1000) / 1000 });
      });
    } catch (e) {
      if (e.safety) {
        console.warn(`[render] 場景 ${idx + 1} 對嘴影片被安全過濾，改用一般說書人做法`);
        return null;
      }
      throw e;
    }
    const secs = Math.round((await media.videoDuration(raw)) * 100) / 100;
    const v = await buildOnce(path.join(dir, 'cache', `talkv-${key}-${secs}.mp4`), (tmp) => media.fitClip(raw, tmp, secs, { keepSpeed: true }));
    const a = await buildOnce(path.join(dir, 'cache', `talka-${key}-${secs}.wav`), (tmp) => media.extractAudio(raw, tmp, secs));
    parts.push({ key, secs, v, a });
  }
  const seconds = parts.reduce((x, p) => x + p.secs, 0);
  if (parts.length === 1) return { video: parts[0].v, audio: parts[0].a, seconds, key: parts[0].key };
  const all = hash('talk-all', parts.map((p) => [p.key, p.secs]));
  const video = await buildOnce(path.join(dir, 'cache', `talkv-${all}.mp4`), (tmp) => media.concatVideo(parts.map((p) => p.v), tmp, path.dirname(tmp)));
  const audio = await buildOnce(path.join(dir, 'cache', `talka-${all}.wav`), (tmp) => media.concatAudio(parts.map((p) => p.a), tmp, path.dirname(tmp)));
  return { video, audio, seconds, key: all };
}

/* ---------- 3. 畫面 ---------- */
// 影片庫關鍵字：同一個畫面描述只問一次（存在快取）
async function stockQueryFor(dir, script) {
  const file = path.join(dir, 'cache', `q-${hash('q', script.visual, script.motionPrompt, config.mock)}.txt`);
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    const q = await gemini.stockQuery(script);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, q);
    return q;
  }
}

async function visualFor({ dir, project, idx, seconds, assetsById, placeholder, costLog, warnings, narrator, lip }) {
  const sc = project.scenes[idx];
  // 說書人對嘴：畫面已經和聲音一起做好，只補到場景長度（不變速）
  if (lip) {
    const secs = Number(seconds.toFixed(2));
    return buildOnce(path.join(dir, 'cache', `clip-${hash('lip', lip.key, secs)}.mp4`), (tmp) => media.fitClip(lip.video, tmp, secs, { keepSpeed: true }));
  }
  let script = project.script.scenes[idx];
  let asset = assetsById[sc.assetId];
  // 說書人出鏡：用說書人照片，動作是對著鏡頭說故事
  if (sc.narrator && narrator) {
    asset = { file: `narrator-${path.basename(narrator.photo)}`, abs: narrator.photo, mime: narrator.mime };
    script = {
      ...script,
      motionPrompt:
        `The person in this image is a storyteller speaking warmly and sincerely to the camera, telling a story; ` +
        `natural head movement, expressive face, soft smile, blinking, gentle hand gestures, mouth moving as if talking. Keep the same person, clothing and background.`
    };
  }
  const img = asset ? asset.abs || path.join(dir, 'assets', asset.file) : placeholder;
  const variant = sc.variant || 0;
  const secs = Number(seconds.toFixed(2));

  // AI 動態：有圖就圖生影片；沒圖就用文字直接生成真人實拍感畫面
  // 場景較長（例如 10 場景時每場約 18 秒）會拆成多個鏡頭，第 2 鏡從第 1 鏡最後一格接著拍，動作連續不停格
  // 影片庫模式：你的圖（不是圖庫補的圖）只在第一次出現的場景使用，其他 AI 動態場景用實拍影片
  const ownImage =
    Boolean(asset) &&
    (asset.file?.startsWith('narrator-') ||
      (!(asset.ai && config.imageProvider !== 'gemini') && project.scenes.findIndex((x) => x.assetId === sc.assetId) === idx));
  const useMotion =
    config.videoProvider === 'gemini' ? asset || !config.videoModel.startsWith('veo') : providers.wantsMotion({ hasOwnImage: ownImage });
  if (sc.motion === 'ai' && useMotion) {
    // 影片庫：一個場景抓一段夠長的實拍影片就好，不用拆鏡頭
    const stock = providers.STOCK.includes(config.videoProvider);
    const shots = stock ? 1 : Math.max(1, Math.round(secs / config.shotSeconds));
    const shotSecs = secs / shots;
    const veoSecs = stock ? Math.ceil(secs) : shotSecs >= 7 ? 8 : shotSecs >= 5 ? 6 : 4;
    const query = stock ? await stockQueryFor(dir, script) : '';
    const firstPrompt = asset ? script.motionPrompt : `${script.visual}. ${script.motionPrompt}`;
    const raws = [];
    let prev = null;
    for (let k = 0; k < shots; k++) {
      const prompt =
        k === 0
          ? firstPrompt
          : `${script.motionPrompt}. Continue this exact scene from this frame (shot ${k + 1} of ${shots}): the action keeps progressing naturally, same people, same outfits, same place and lighting.`;
      const rawKey =
        k === 0
          ? hash('veo', asset?.file || `t2v:${script.visual}`, script.motionPrompt, variant, veoSecs, stock ? `${config.videoProvider}:${query}:${idx}` : config.videoModel, config.mock)
          : hash('veo-cont', prev.key, prompt, veoSecs, config.videoModel, config.mock);
      const raw = path.join(dir, 'cache', `veo-${rawKey}.mp4`);
      const blocked = path.join(dir, 'cache', `veo-${rawKey}.blocked`);
      if (await media.exists(blocked)) {
        if (k === 0) {
          warnings.push(idx + 1);
          return kenBurnsClip();
        }
        break;
      }
      let startImg = asset ? img : null;
      let startMime = asset?.mime;
      if (k > 0) {
        startImg = await buildOnce(path.join(dir, 'cache', `last-${prev.key}.jpg`), (tmp) => media.lastFrame(prev.raw, tmp));
        startMime = 'image/jpeg';
      }
      try {
        await buildOnce(raw, async (tmp) => {
          if (config.mock && !(process.env.MOCK_BLOCK || '').split(',').includes(String(idx + 1))) {
            await media.kenBurns(startImg || img, tmp, veoSecs, idx + variant + k + 1, 0.28);
            return;
          }
          let res;
          try {
            res = await providers.sceneVideo({ imagePath: startImg, mime: startMime, prompt, outPath: tmp, seconds: veoSecs, query, variant: variant + idx });
          } catch (e) {
            if (e.safety) await fs.writeFile(blocked, e.message);
            throw e;
          }
          const got = await media.duration(tmp).catch(() => veoSecs);
          if (stock) {
            costLog.push({ type: 'stock', model: config.videoProvider, scene: idx + 1, query, source: res.info?.url, author: res.info?.author, usd: 0 });
          } else {
            costLog.push({ type: 'video', model: config.videoModel, scene: idx + 1, shot: k + 1, seconds: Math.round(got * 10) / 10, usd: Math.round(got * config.veoPricePerSecond * 1000) / 1000 });
          }
        });
      } catch (e) {
        if (!e.safety) throw e;
        if (k === 0) {
          // 被安全過濾：已記下（下次不再重送、不再花錢），這一段改用鏡頭推移
          console.warn(`[render] 場景 ${idx + 1} 被安全過濾，改用鏡頭推移`);
          warnings.push(idx + 1);
          return kenBurnsClip();
        }
        break; // 後面的鏡頭被擋：用已完成的鏡頭撐滿這個場景
      }
      prev = { key: rawKey, raw };
      raws.push(prev);
    }
    // 每個鏡頭平均分配場景長度（最後一個補足誤差）
    const parts = [];
    let used = 0;
    raws.forEach((r, k) => {
      const d = k === raws.length - 1 ? Math.round((secs - used) * 100) / 100 : Math.round((secs / raws.length) * 100) / 100;
      used += d;
      parts.push({ ...r, d });
    });
    const fitted = await Promise.all(
      parts.map((r) => buildOnce(path.join(dir, 'cache', `clip-${hash(r.key, r.d)}.mp4`), (tmp) => media.fitClip(r.raw, tmp, r.d)))
    );
    if (fitted.length === 1) return fitted[0];
    const sceneKey = hash('scene', parts.map((r) => [r.key, r.d]));
    return buildOnce(path.join(dir, 'cache', `scene-${sceneKey}.mp4`), (tmp) => media.concatVideo(fitted, tmp, path.dirname(tmp)));
  }

  return kenBurnsClip();

  async function kenBurnsClip() {
    const out = path.join(dir, 'cache', `kb-${hash('kb', asset?.file || 'none', variant, idx, secs)}.mp4`);
    return buildOnce(out, (tmp) => media.kenBurns(img, tmp, secs, idx + variant));
  }
}

/* ---------- 主流程 ---------- */
export async function render(projectId, { note = '', regenerated = [], isRevision = false } = {}) {
  const dir = projectDir(projectId);
  const project = await getProject(projectId);
  const n = project.script.scenes.length;
  const work = path.join(dir, 'work');
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  const costLog = [];
  const warnings = [];

  await setJob(projectId, { status: 'running', step: '產生配音', progress: 5 });
  const voiceOf = (i) => {
    const a = project.assets.find((x) => x.id === project.scenes[i]?.voiceAssetId);
    return a ? path.join(dir, 'assets', a.file) : null;
  };
  const merged = project.script.scenes.map((s, i) => ({ ...s, ttsVariant: project.scenes[i]?.ttsVariant || 0, voiceFile: voiceOf(i) }));
  const brandV = await getBrand();
  const settings = { ...project.settings, tone: project.brief?.tone, narratorVoiceId: brandV.narratorVoice?.id };
  const nPhoto = narratorPath(brandV);
  const narrator = nPhoto && (await media.exists(nPhoto)) ? { photo: nPhoto, mime: /\.png$/i.test(nPhoto) ? 'image/png' : /\.webp$/i.test(nPhoto) ? 'image/webp' : 'image/jpeg' } : null;

  // 說書人真人對嘴：先做說書人出鏡的場景（畫面＋聲音一起），自己錄音的場景不做
  const lip = new Array(n).fill(null);
  const lipIdx = providers.lipsyncEnabled() && brandV.narratorLipsync && narrator ? project.scenes.map((s, i) => (s.narrator && !merged[i].voiceFile ? i : -1)).filter((i) => i >= 0) : [];
  if (lipIdx.length) {
    let lipDone = 0;
    await setJob(projectId, { step: `產生說書人對嘴影片 0/${lipIdx.length}（需數分鐘）`, progress: 3 });
    await limitAll(lipIdx, config.mock ? 2 : config.veoConcurrency, async (i) => {
      lip[i] = await lipsyncFor({ dir, text: merged[i].narration, idx: i, variant: project.scenes[i].variant || 0, narrator, brand: brandV, costLog });
      if (!lip[i]) warnings.push(i + 1);
      lipDone++;
      await setJob(projectId, { step: `產生說書人對嘴影片 ${lipDone}/${lipIdx.length}`, progress: 3 + Math.round((lipDone / lipIdx.length) * 10) });
    });
  }

  const tts = await limitAll(merged, config.ttsConcurrency, async (s, i) => {
    if (lip[i]) return { file: lip[i].audio, key: lip[i].key, seconds: lip[i].seconds, idx: i, locked: true };
    const r = await narrationFor(dir, s, settings, i);
    await setJob(projectId, { step: `產生配音 ${i + 1}/${merged.length}`, progress: 5 + Math.round(((i + 1) / merged.length) * 12) });
    return r;
  });

  const speed = Number(project.settings.speed) || 1;
  const timing = planTiming(tts.map((t) => t.seconds), speed, targetOf(project.brief), tts.map((t) => !!t.locked));

  await setJob(projectId, { step: '對齊配音長度', progress: 20 });
  const audioParts = await limitAll(tts, 4, async (t, i) => {
    const out = path.join(work, `a-${String(i).padStart(2, '0')}.wav`);
    await media.fitAudio(t.file, out, timing.durations[i], t.locked ? 1 : timing.tempo, timing.spoken[i]);
    return out;
  });

  await setJob(projectId, { step: '產生畫面（AI 動態需數分鐘）', progress: 30 });
  const assetsById = Object.fromEntries(project.assets.map((a) => [a.id, a]));
  const placeholder = await placeholderImage(dir);
  let done = 0;
  const aiIdx = [];
  const kbIdx = [];
  project.scenes.forEach((s, i) => (s.motion === 'ai' ? aiIdx : kbIdx).push(i));
  const clips = new Array(n);
  const transition = media.TRANSITIONS[project.settings.transition] ? project.settings.transition : 'none';
  const xd = transition === 'none' ? 0 : config.transitionSeconds;
  // 有轉場時每段（最後一段除外）多做 xd 秒，給轉場重疊用
  const clipSecs = (i) => timing.durations[i] + (i < n - 1 ? xd : 0);
  const tick = async () => {
    done++;
    await setJob(projectId, { progress: 30 + Math.round((done / n) * 55), step: `產生畫面 ${done}/${n}` });
  };
  await Promise.all([
    limitAll(aiIdx, config.mock ? 2 : config.veoConcurrency, async (i) => {
      clips[i] = await visualFor({ dir, project, idx: i, seconds: clipSecs(i), assetsById, placeholder, costLog, warnings, narrator, lip: lip[i] });
      await tick();
    }),
    limitAll(kbIdx, 2, async (i) => {
      clips[i] = await visualFor({ dir, project, idx: i, seconds: clipSecs(i), assetsById, placeholder, costLog, warnings, narrator, lip: lip[i] });
      await tick();
    })
  ]);

  await setJob(projectId, { step: '合成影片與字幕', progress: 88 });
  const narration = path.join(work, 'narration.wav');
  await media.concatAudio(audioParts, narration, work);

  const cues = [];
  let t = 0;
  project.script.scenes.forEach((s, i) => {
    const pieces = media.splitCaption(s.narration);
    const total = pieces.reduce((a, p) => a + [...p].length, 0) || 1;
    let c = t + 0.1;
    for (const p of pieces) {
      const len = (timing.spoken[i] * [...p].length) / total;
      cues.push({ start: c, end: c + len, text: p });
      c += len;
    }
    t += timing.durations[i];
  });
  // 每個場景在影片中的時間（預覽頁標示目前場景、重點大字用）
  let acc = 0;
  const timeline = timing.durations.map((d) => {
    const s = { start: Math.round(acc * 100) / 100, end: Math.round((acc + d) * 100) / 100 };
    acc += d;
    return s;
  });
  const totalSecs = acc;

  const brand = await getBrand();
  const logo = logoPath(brand);
  const hasLogo = logo && (await media.exists(logo));
  const endCard = brand.outro && (hasLogo || brand.name || brand.ctaText) ? { start: Math.max(0, totalSecs - 3.2), end: totalSecs } : null;
  const headlines =
    project.settings.headlines === false
      ? []
      : project.script.scenes.map((s, i) => ({
          text: s.headline,
          start: timeline[i].start + (i === 0 && brand.intro && hasLogo ? 1.6 : 0.15),
          end: Math.min(timeline[i].start + 3.2, timeline[i].end - 0.2, endCard ? endCard.start : Infinity)
        })).filter((h) => h.text && h.end > h.start + 0.5);

  // 說書人小頭像：說書人沒出鏡的時段顯示（片頭 Logo、片尾卡時隱藏）
  let pip = null;
  let pipName = null;
  if (narrator && brand.narratorPip) {
    const hide = project.scenes.map((s, i) => (s.narrator ? [timeline[i].start, timeline[i].end] : null)).filter(Boolean);
    if (brand.intro && hasLogo) hide.push([0, 1.6]);
    if (endCard) hide.push([endCard.start, totalSecs]);
    hide.sort((a, b) => a[0] - b[0]);
    const ranges = [];
    let t0 = 0;
    for (const [a, b] of hide) {
      if (a > t0 + 0.3) ranges.push([t0, a]);
      t0 = Math.max(t0, b);
    }
    if (totalSecs > t0 + 0.3) ranges.push([t0, totalSecs]);
    if (ranges.length) {
      const circle = path.join(dir, 'cache', `pip-${hash(path.basename(narrator.photo))}.png`);
      await buildOnce(circle, (tmp) => media.makeCircle(narrator.photo, tmp));
      pip = { file: circle, ranges };
      pipName = brand.narratorName ? { text: brand.narratorName, ranges } : null;
    }
  }

  const ass = path.join(work, 'subs.ass');
  await media.writeAss({ cues, headlines, style: project.settings.subtitle, brand, endCard, pipName }, ass);

  const bgmId = project.settings.bgmAssetId;
  let bgmFile = null;
  if (bgmId?.startsWith('builtin:') && (config.builtinMusic[bgmId.slice(8)] || config.legacyMusic.includes(bgmId.slice(8)))) {
    bgmFile = path.join(MUSIC_DIR, `${bgmId.slice(8)}.mp3`);
  } else {
    const a = project.assets.find((x) => x.id === bgmId);
    if (a) bgmFile = path.join(dir, 'assets', a.file);
  }
  const versionN = project.versions.length + 1;
  const outName = `v${versionN}.mp4`;
  const outFile = path.join(dir, 'versions', outName);
  await media.finalMux({
    clips,
    durations: timing.durations,
    transition,
    xd,
    narrationFile: narration,
    bgmFile,
    assFile: ass,
    outFile,
    workDir: work,
    logoFile: hasLogo ? logo : null,
    watermark: brand.watermark,
    intro: brand.intro,
    endCard,
    pip
  });
  const finalSecs = await media.duration(outFile);

  // 封面圖：預設取第 1 場 1.2 秒的畫面＋標題
  await setJob(projectId, { step: '產生封面', progress: 97 });
  const coverName = `v${versionN}-cover.jpg`;
  await media
    .makeCover({ videoFile: outFile, time: (brand.intro && hasLogo ? 1.8 : 1.2), title: project.script.title || project.script.titles?.[0] || '', brand, logoFile: hasLogo && !brand.watermark ? logo : null, outFile: path.join(dir, 'versions', coverName), workDir: work })
    .catch((e) => console.warn('[cover] 封面產生失敗', e.message));
  await fs.rm(work, { recursive: true, force: true });

  await updateProject(projectId, (p) => {
    p.versions.push({
      n: versionN,
      file: outName,
      seconds: Math.round(finalSecs * 10) / 10,
      createdAt: new Date().toISOString(),
      note: isRevision ? note || '修改' : '初版',
      regenerated,
      isRevision,
      blockedScenes: [...new Set(warnings)].sort((a, b) => a - b),
      timeline,
      cover: coverName,
      transition,
      tempo: Math.round(timing.tempo * 100) / 100,
      speed,
      sections: project.script.scenes.map((s) => s.section)
    });
    const usd = costLog.reduce((a, c) => a + c.usd, 0);
    p.cost.usd = Math.round((p.cost.usd + usd) * 100) / 100;
    p.cost.items.push(...costLog.map((c) => ({ ...c, version: versionN })));
    p.job = { status: 'done', step: '完成', progress: 100, updatedAt: new Date().toISOString() };
  });
}

/* ---------- 單場配音試聽 ---------- */
export async function previewNarration(projectId, index, text, settingsOverride) {
  const dir = projectDir(projectId);
  const project = await getProject(projectId);
  const scene = { ...project.script.scenes[index], ttsVariant: project.scenes[index]?.ttsVariant || 0 };
  if (typeof text === 'string' && text.trim()) scene.narration = text.trim().slice(0, 200);
  const va = project.assets.find((x) => x.id === project.scenes[index]?.voiceAssetId);
  if (va) scene.voiceFile = path.join(dir, 'assets', va.file);
  const settings = { ...(settingsOverride || project.settings), narratorVoiceId: (await getBrand()).narratorVoice?.id };
  const r = await narrationFor(dir, scene, settings, index);
  const speed = Number(settings.speed) || 1;
  const name = `prev-${r.key}-${speed}.wav`;
  const out = path.join(dir, 'cache', name);
  await buildOnce(out, (tmp) => media.applyTempo(r.file, tmp, speed));
  return name;
}

/* ---------- 重做封面（用指定時間的畫面） ---------- */
export async function remakeCover(projectId, versionN, time, title) {
  const dir = projectDir(projectId);
  const project = await getProject(projectId);
  const v = project.versions.find((x) => x.n === versionN);
  if (!v) throw new Error('找不到這個版本');
  const brand = await getBrand();
  const logo = logoPath(brand);
  const hasLogo = logo && (await media.exists(logo));
  const work = path.join(dir, `cover-work-${Date.now()}`);
  await fs.mkdir(work, { recursive: true });
  const coverName = `v${versionN}-cover.jpg`;
  try {
    await media.makeCover({
      videoFile: path.join(dir, 'versions', v.file),
      time: Math.max(0, Math.min(Number(time) || 0, (v.seconds || 1) - 0.1)),
      title: title ?? project.script.title ?? '',
      brand,
      logoFile: hasLogo && !brand.watermark ? logo : null,
      outFile: path.join(dir, 'versions', coverName),
      workDir: work
    });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
  await updateProject(projectId, (p) => {
    const vv = p.versions.find((x) => x.n === versionN);
    vv.cover = coverName;
    vv.coverAt = new Date().toISOString();
  });
  return coverName;
}

/* ---------- AI 補圖：依場景畫面建議生成一張 9:16 寫實照片，存成素材 ---------- */
export async function generateSceneImage(project, idx, extra = '') {
  const dir = projectDir(project.id);
  const s = project.script.scenes[idx];
  const prompt = [
    `Product / brand: ${project.brief.brand || ''}. Target audience: ${project.brief.audience || ''}.`,
    `Scene ${idx + 1} (${s.section}): ${s.visual}.`,
    `What happens in this scene: ${s.motionPrompt}.`,
    `Narration (Traditional Chinese, for context only, do not render as text): ${s.narration}`,
    extra ? `Extra direction: ${extra}` : ''
  ].join('\n');
  const id = crypto.randomUUID();
  const tmp = path.join(dir, 'assets', `${id}.img`);
  const query = providers.STOCK.includes(config.imageProvider) ? await gemini.stockQuery({ visual: s.visual + (extra ? `；${extra}` : ''), motionPrompt: s.motionPrompt }) : '';
  const mime = await providers.generateImage({ prompt, outPath: tmp, query, variant: Math.floor(Math.random() * 6) });
  const file = `${id}${mime === 'image/png' ? '.png' : '.jpg'}`;
  await fs.rename(tmp, path.join(dir, 'assets', file));
  const asset = { id, file, originalName: `AI 生圖-場景${String(idx + 1).padStart(2, '0')}`, mime, size: 0, ai: true };
  const usd = providers.imagePrice();
  return { asset, cost: { type: 'image', model: config.imageProvider === 'gemini' ? config.imageModel : config.imageProvider, scene: idx + 1, usd } };
}
