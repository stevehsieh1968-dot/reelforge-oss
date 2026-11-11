import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, DURATIONS } from './config.js';
import {
  createProject, getProject, updateProject, listProjects, projectDir, projectsDir, httpError
} from './store.js';
import * as gemini from './gemini.js';
import * as providers from './providers.js';
import { render, previewNarration, remakeCover, generateSceneImage } from './pipeline.js';
import { getBrand, saveBrand, brandDir, logoPath, narratorPath } from './brand.js';
import { TEMPLATES, getTemplate, narratorScenes } from './templates.js';
import * as narr from './narrator.js';
import { enqueue, queueLength } from './queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- 簡易密碼保護（建議正式上線一定要設） ---------- */
if (process.env.ACCESS_PASSWORD) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const [, b64] = auth.split(' ');
    const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    const ok =
      pass.length === process.env.ACCESS_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(process.env.ACCESS_PASSWORD));
    if (ok) return next();
    res.set('WWW-Authenticate', 'Basic realm="ReelForge"').status(401).send('需要密碼');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/music', express.static(path.join(__dirname, '..', 'music')));

// 聲線：內建聲線，或 'narrator'（說書人的聲音，要先在品牌設定建立）
const validVoice = (v) => Boolean(config.voices[v] || v === 'narrator');

// 語速：0.8–1.5 倍，以 0.05 為單位
function validSpeed(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(1.5, Math.max(0.8, n)) * 20) / 20;
}

// 背景音樂：內建（builtin:xxx）、上傳的音檔 id，或 null（不使用）
function validBgm(p, id) {
  if (!id) return null;
  if (String(id).startsWith('builtin:')) {
    const k = String(id).slice(8);
    return config.builtinMusic[k] || config.legacyMusic.includes(k) ? id : null;
  }
  return p.assets.some((a) => a.id === id && a.mime.startsWith('audio/')) ? id : null;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const publicView = (p) => ({
  ...p,
  revisionsLeft: config.maxRevisions - p.revisionsUsed,
  cost: { usd: p.cost.usd, twd: Math.round(p.cost.usd * config.usdToTwd) }
});

// 方案決定 AI 動態的場景比例（經濟 20%、標準 50%、高階全部）
function aiCap(tier, n) {
  const r = (config.tiers[tier] || config.tiers.standard).aiRatio;
  return Math.max(1, Math.min(n, Math.round(n * r)));
}

// 依方案自動挑出要用 AI 動態的場景：平均分散，且一定包含開場
function autoMotion(n, tier) {
  const k = aiCap(tier, n);
  const picks = new Set();
  for (let j = 0; j < k; j++) picks.add(Math.round((j * (n - 1)) / Math.max(1, k - 1 || 1)));
  if (k === 1) picks.add(0);
  return Array.from({ length: n }, (_, i) => (picks.has(i) ? 'ai' : 'kenburns'));
}

function sceneCountOf(p) {
  const n = Number(p.brief?.sceneCount);
  return config.sceneCountOptions.includes(n) ? n : config.sceneCount;
}

function ensureScenes(p) {
  const n = p.script?.scenes.length || sceneCountOf(p);
  const images = p.assets.filter((a) => a.mime.startsWith('image/'));
  const motions = autoMotion(n, p.settings.tier);
  const prev = p.scenes || [];
  p.scenes = Array.from({ length: n }, (_, i) => ({
    assetId: prev[i]?.assetId && p.assets.some((a) => a.id === prev[i].assetId) ? prev[i].assetId : images[i % Math.max(1, images.length)]?.id || null,
    motion: prev[i]?.motion || motions[i],
    variant: prev[i]?.variant || 0,
    ttsVariant: prev[i]?.ttsVariant || 0,
    narrator: Boolean(prev[i]?.narrator),
    voiceAssetId: prev[i]?.voiceAssetId && p.assets.some((a) => a.id === prev[i].voiceAssetId) ? prev[i].voiceAssetId : null
  }));
}

function enforceAiCap(p) {
  const cap = aiCap(p.settings.tier, p.scenes.length);
  let count = 0;
  for (const s of p.scenes) {
    if (s.motion === 'ai') {
      count++;
      if (count > cap) s.motion = 'kenburns';
    }
  }
}

// 依方案設定 AI 動態場景；說書人出鏡的場景優先用 AI 動態
function applyMotion(p) {
  const n = p.scenes.length;
  const cap = aiCap(p.settings.tier, n);
  const base = autoMotion(n, p.settings.tier);
  const order = [
    ...p.scenes.map((s, i) => (s.narrator ? i : null)).filter((x) => x !== null),
    ...base.map((m, i) => (m === 'ai' ? i : null)).filter((x) => x !== null),
    ...base.map((m, i) => i)
  ];
  const pick = new Set();
  for (const i of order) {
    if (pick.size >= cap) break;
    pick.add(i);
  }
  p.scenes.forEach((s, i) => (s.motion = pick.has(i) ? 'ai' : 'kenburns'));
}

// 用說書人範本產生文案後，標記說書人出鏡的場景
function markNarrator(p) {
  const tpl = getTemplate(p.brief?.template);
  const idx = new Set(narratorScenes(tpl, p.scenes.length));
  p.scenes.forEach((s, i) => (s.narrator = idx.has(i)));
}

function assertIdle(p) {
  if (p.job && ['queued', 'running'].includes(p.job.status)) throw httpError(409, '影片正在產生中，請稍候');
}

/* ---------- 設定 ---------- */
// 連線診斷：瀏覽器打開 http://localhost:3000/api/diag
app.get('/api/diag', wrap(async (req, res) => {
  res.json(await gemini.diagnose());
}));

app.get('/api/config', (req, res) => {
  res.json({
    mock: config.mock,
    targetSeconds: config.targetSeconds,
    durations: DURATIONS,
    sceneCount: config.sceneCount,
    sceneCountOptions: config.sceneCountOptions,
    templates: TEMPLATES,
    pricing: {
      videoPerSecond: config.videoProvider === 'gemini' ? config.veoPricePerSecond : 0,
      lipsyncPerSecond: config.lipsyncProvider === 'gemini' ? config.lipsyncPricePerSecond : 0,
      image: providers.imagePrice(),
      usdToTwd: config.usdToTwd
    },
    providers: { text: config.textProvider, tts: config.ttsProvider, video: config.videoProvider, image: config.imageProvider, lipsync: config.lipsyncProvider },
    lipsyncVoices: Object.fromEntries(Object.entries(config.lipsyncVoices).map(([k, v]) => [k, v.label])),
    maxRevisions: config.maxRevisions,
    maxScenesPerRevision: config.maxScenesPerRevision,
    fullRedoCost: config.fullRedoCost,
    tiers: config.tiers,
    voices: Object.fromEntries(Object.entries(config.voices).map(([k, v]) => [k, v.label])),
    subtitleStyles: Object.fromEntries(Object.entries(config.subtitleStyles).map(([k, v]) => [k, v.label])),
    speeds: config.speeds,
    speedRange: { min: 0.8, max: 1.5, step: 0.05 },
    transitions: config.transitions,
    music: Object.entries(config.builtinMusic).map(([k, label]) => ({ id: `builtin:${k}`, label, url: `/music/${k}.mp3` }))
  });
});

/* ---------- 專案與需求 ---------- */
app.get('/api/projects', wrap(async (req, res) => res.json(await listProjects())));

app.post('/api/projects', wrap(async (req, res) => {
  const b = req.body?.brief || {};
  if (!b.brand?.trim() || !b.points?.trim()) throw httpError(400, '請填寫品牌名稱與核心賣點');
  const p = await createProject(b);
  res.status(201).json(publicView(p));
}));

app.get('/api/projects/:id', wrap(async (req, res) => res.json(publicView(await getProject(req.params.id)))));

app.put('/api/projects/:id/brief', wrap(async (req, res) => {
  const p = await updateProject(req.params.id, (p) => {
    if (p.versions.length) throw httpError(409, '影片已產生，需求不能再改；請用修改功能');
    p.brief = { ...p.brief, ...(req.body?.brief || {}) };
  });
  res.json(publicView(p));
}));

/* ---------- 文案（影片產生前不限次數） ---------- */
app.post('/api/projects/:id/script', wrap(async (req, res) => {
  const cur = await getProject(req.params.id);
  if (cur.versions.length) throw httpError(409, '影片已產生，文案請用修改功能調整');
  const script = await gemini.generateScript(cur.brief, req.body?.instruction || '', sceneCountOf(cur));
  const brandNow = await getBrand();
  script.title = script.titles[0];
  const p = await updateProject(req.params.id, (p) => {
    p.script = script;
    p.scenes = p.scenes.map((s) => ({ ...s, narrator: false, voiceAssetId: null })); // 文案重寫，舊錄音不再對應
    ensureScenes(p);
    markNarrator(p);
    applyMotion(p);
    if (getTemplate(p.brief?.template)?.story && brandNow.narratorVoice && !p.versions.length) p.settings.voice = 'narrator';
  });
  res.json(publicView(p));
}));

app.patch('/api/projects/:id/script', wrap(async (req, res) => {
  const { title, scenes = [], instruction, indexes } = req.body || {};
  const cur = await getProject(req.params.id);
  if (!cur.script) throw httpError(400, '請先產生文案');
  if (cur.versions.length) throw httpError(409, '影片已產生，文案請用修改功能調整');
  let rewrites = [];
  if (instruction) {
    const idx = Array.isArray(indexes) && indexes.length ? indexes : cur.script.scenes.map((_, i) => i);
    rewrites = await gemini.rewriteScenes(cur.brief, cur.script.scenes, idx, instruction);
  }
  const p = await updateProject(req.params.id, (p) => {
    if (typeof title === 'string') p.script.title = title.slice(0, 60);
    for (const s of scenes) {
      if (p.script.scenes[s.index] && typeof s.narration === 'string') p.script.scenes[s.index].narration = s.narration.slice(0, 200);
      if (p.script.scenes[s.index] && typeof s.headline === 'string') p.script.scenes[s.index].headline = s.headline.trim().slice(0, 12);
    }
    for (const r of rewrites) p.script.scenes[r.index].narration = r.narration;
  });
  res.json(publicView(p));
}));

/* ---------- 素材 ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(projectDir(req.params.id), 'assets')),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/.test(file.mimetype) || /^audio\/(mpeg|mp3|wav|x-wav|aac|mp4|x-m4a)$/.test(file.mimetype);
    cb(ok ? null : httpError(400, `不支援的檔案格式：${file.originalname}`), ok);
  }
});

app.post('/api/projects/:id/assets', wrap(async (req, res, next) => {
  await getProject(req.params.id);
  upload.array('files', 30)(req, res, async (err) => {
    try {
      if (err) throw err.status ? err : httpError(400, err.message);
      const p = await updateProject(req.params.id, (p) => {
        for (const f of req.files || []) {
          p.assets.push({ id: crypto.randomUUID(), file: f.filename, originalName: f.originalname, mime: f.mimetype, size: f.size });
          // 上傳音樂就自動選用它
          if (f.mimetype.startsWith('audio/')) p.settings.bgmAssetId = p.assets.at(-1).id;
        }
        if (p.script && !p.versions.length) {
          // 新圖片自動補到還沒指定素材的場景
          const images = p.assets.filter((a) => a.mime.startsWith('image/'));
          ensureScenes(p);
          const used = new Set(p.scenes.map((s) => s.assetId));
          const fresh = images.filter((a) => !used.has(a.id));
          p.scenes.forEach((s, i) => {
            if (!s.assetId && images.length) s.assetId = images[i % images.length].id;
          });
          // 原本重複用圖的場景，優先換成新圖
          const seen = new Set();
          for (const s of p.scenes) {
            if (seen.has(s.assetId) && fresh.length) s.assetId = fresh.shift().id;
            seen.add(s.assetId);
          }
        }
      });
      res.json(publicView(p));
    } catch (e) {
      next(e);
    }
  });
}));

app.delete('/api/projects/:id/assets/:assetId', wrap(async (req, res) => {
  const p = await updateProject(req.params.id, (p) => {
    if (p.versions.length) throw httpError(409, '影片已產生，素材無法刪除');
    p.assets = p.assets.filter((a) => a.id !== req.params.assetId);
    p.scenes.forEach((s) => s.assetId === req.params.assetId && (s.assetId = null));
    if (p.settings.bgmAssetId === req.params.assetId) p.settings.bgmAssetId = null;
  });
  res.json(publicView(p));
}));

app.get('/api/projects/:id/assets/:file', wrap(async (req, res) => {
  const file = path.basename(req.params.file);
  res.sendFile(path.join(projectDir(req.params.id), 'assets', file));
}));

/* ---------- AI 補圖（影片產生前；之後請用修改功能） ---------- */
async function addAiImages(id, indexes, extra) {
  const cur = await getProject(id);
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, indexes.length) }, async () => {
      while (next < indexes.length) {
        const i = indexes[next++];
        results.push({ i, ...(await generateSceneImage(cur, i, extra)) });
      }
    })
  );
  return updateProject(id, (p) => {
    for (const r of results) {
      p.assets.push(r.asset);
      if (p.scenes[r.i]) p.scenes[r.i].assetId = r.asset.id;
      p.cost.usd = Math.round((p.cost.usd + r.cost.usd) * 1000) / 1000;
      p.cost.items.push({ ...r.cost, version: p.versions.length + 1 });
    }
  });
}

app.post('/api/projects/:id/scenes/:idx/ai-image', wrap(async (req, res) => {
  const cur = await getProject(req.params.id);
  if (cur.versions.length) throw httpError(409, '影片已產生，請在修改頁選「換畫面」並選 AI 新生成');
  const i = Number(req.params.idx);
  if (!cur.script?.scenes[i]) throw httpError(400, '場景編號錯誤');
  const p = await addAiImages(cur.id, [i], String(req.body?.extra || '').slice(0, 200));
  res.json(publicView(p));
}));

// 一鍵補齊：只補沒有圖的場景；all=true 則全部重新生成
app.post('/api/projects/:id/ai-fill', wrap(async (req, res) => {
  const cur = await getProject(req.params.id);
  if (!cur.script) throw httpError(400, '請先產生文案');
  if (cur.versions.length) throw httpError(409, '影片已產生，請用修改功能');
  const used = new Map();
  cur.scenes.forEach((s) => s.assetId && used.set(s.assetId, (used.get(s.assetId) || 0) + 1));
  // 沒有圖，或跟別的場景共用同一張圖的，都補一張新的
  const seen = new Set();
  const idx = cur.scenes
    .map((s, i) => {
      if (req.body?.all) return i;
      if (!s.assetId) return i;
      if (seen.has(s.assetId)) return i;
      seen.add(s.assetId);
      return null;
    })
    .filter((x) => x !== null);
  if (!idx.length) return res.json(publicView(cur));
  const p = await addAiImages(cur.id, idx);
  res.json(publicView(p));
}));

/* ---------- 分鏡與方案 ---------- */
app.put('/api/projects/:id/scenes', wrap(async (req, res) => {
  const { scenes, settings } = req.body || {};
  const p = await updateProject(req.params.id, (p) => {
    if (p.versions.length) throw httpError(409, '影片已產生，請用修改功能調整');
    if (!p.script) throw httpError(400, '請先產生文案');
    const tierChanged = settings?.tier && settings.tier !== p.settings.tier;
    if (settings) {
      if (settings.tier && config.tiers[settings.tier]) p.settings.tier = settings.tier;
      if (settings.voice && validVoice(settings.voice)) p.settings.voice = settings.voice;
      if (settings.subtitle && config.subtitleStyles[settings.subtitle]) p.settings.subtitle = settings.subtitle;
      if (settings.speed !== undefined && validSpeed(settings.speed)) p.settings.speed = validSpeed(settings.speed);
      if (settings.transition && config.transitions[settings.transition]) p.settings.transition = settings.transition;
      if (typeof settings.headlines === 'boolean') p.settings.headlines = settings.headlines;
      if ('bgmAssetId' in settings) p.settings.bgmAssetId = validBgm(p, settings.bgmAssetId);
    }
    ensureScenes(p);
    if (tierChanged && !scenes) applyMotion(p);
    if (Array.isArray(scenes)) {
      scenes.forEach((s, i) => {
        if (!p.scenes[i] || !s) return;
        if (s.assetId === null || p.assets.some((a) => a.id === s.assetId)) p.scenes[i].assetId = s.assetId;
        if (['ai', 'kenburns'].includes(s.motion)) p.scenes[i].motion = s.motion;
        if (typeof s.narrator === 'boolean') p.scenes[i].narrator = s.narrator;
      });
    }
    enforceAiCap(p);
  });
  res.json(publicView(p));
}));

/* ---------- 產生影片 ---------- */
function startRender(id, opts, onFail) {
  enqueue(() => render(id, opts)).catch(async (e) => {
    console.error('[render]', id, e);
    await updateProject(id, (p) => {
      p.job = { status: 'error', step: '失敗', progress: 0, error: e.message, updatedAt: new Date().toISOString() };
      onFail?.(p);
    }).catch(() => {});
  });
}

app.post('/api/projects/:id/render', wrap(async (req, res) => {
  const hasNarrator = Boolean(narratorPath(await getBrand()));
  const p = await updateProject(req.params.id, (p) => {
    assertIdle(p);
    if (!p.script) throw httpError(400, '請先產生文案');
    if (p.versions.length) throw httpError(409, '初版已產生，請用修改功能');
    ensureScenes(p);
    enforceAiCap(p);
    const missing = p.scenes.map((s, i) => (s.motion !== 'ai' && !s.assetId && !(s.narrator && hasNarrator) ? i + 1 : null)).filter(Boolean);
    if (missing.length) throw httpError(400, `場景 ${missing.join('、')} 是「鏡頭推移」但沒有圖片：請上傳、按「AI 補圖」，或改成 AI 動態`);
    p.job = { status: 'queued', step: `排隊中（前面 ${queueLength()} 支）`, progress: 0, updatedAt: new Date().toISOString() };
  });
  startRender(p.id, { isRevision: false });
  res.status(202).json(publicView(p));
}));

/* ---------- 說書人錄音：每個場景可錄音或上傳音檔，取代 AI 配音 ---------- */
const voiceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(projectDir(req.params.id), 'assets')),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || (file.mimetype.includes('webm') ? '.webm' : '.m4a');
      cb(null, `voice-${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || /^video\/(webm|mp4)$/.test(file.mimetype);
    cb(ok ? null : httpError(400, '請上傳音檔（MP3、M4A、WAV、WebM）'), ok);
  }
});

app.post('/api/projects/:id/scenes/:idx/voice', (req, res, next) =>
  voiceUpload.single('voice')(req, res, async (err) => {
    try {
      if (err) throw err.status ? err : httpError(400, err.message);
      if (!req.file) throw httpError(400, '沒有收到音檔');
      const i = Number(req.params.idx);
      const cur = await getProject(req.params.id);
      if (!cur.script?.scenes[i]) throw httpError(400, '場景編號錯誤');
      const asset = { id: crypto.randomUUID(), file: req.file.filename, originalName: `說書人錄音-場景${String(i + 1).padStart(2, '0')}`, mime: req.file.mimetype, size: req.file.size, voice: true, scene: i };
      const p = await updateProject(cur.id, (p) => {
        p.assets.push(asset);
        // 影片還沒做：直接套用；已經有影片：要透過修改套用（才會算一次修改）
        if (!p.versions.length) p.scenes[i].voiceAssetId = asset.id;
      });
      res.json({ ...publicView(p), voiceAssetId: asset.id });
    } catch (e) {
      next(e);
    }
  })
);

app.delete('/api/projects/:id/scenes/:idx/voice', wrap(async (req, res) => {
  const i = Number(req.params.idx);
  const p = await updateProject(req.params.id, (p) => {
    if (p.versions.length) throw httpError(409, '影片已產生，請用修改功能（改旁白）換回 AI 配音');
    if (p.scenes[i]) p.scenes[i].voiceAssetId = null;
  });
  res.json(publicView(p));
}));

/* ---------- 一句話改全片：先規劃（不扣次數），確認後才套用 ---------- */
app.post('/api/projects/:id/revise-plan', wrap(async (req, res) => {
  const cur = await getProject(req.params.id);
  assertIdle(cur);
  if (!cur.versions.length) throw httpError(400, '還沒有影片可以修改');
  const instruction = String(req.body?.instruction || '').trim().slice(0, 500);
  if (!instruction) throw httpError(400, '請輸入要怎麼改');
  const plan = await gemini.planRevision({
    brief: cur.brief,
    script: cur.script,
    settings: cur.settings,
    instruction,
    options: {
      maxVisual: config.maxScenesPerRevision,
      transitions: Object.keys(config.transitions).join('/'),
      subtitles: Object.keys(config.subtitleStyles).join('/'),
      music: Object.keys(config.builtinMusic).map((k) => `builtin:${k}`).join('/')
    }
  });
  const visualCount = new Set(plan.visuals.map((x) => x.index)).size;
  plan.cost = visualCount > config.maxScenesPerRevision ? config.fullRedoCost : 1;
  plan.id = crypto.randomUUID();
  plan.instruction = instruction;
  plan.createdAt = new Date().toISOString();
  await updateProject(cur.id, (p) => (p.pendingPlan = plan));
  res.json({ plan, revisionsLeft: config.maxRevisions - cur.revisionsUsed });
}));

async function applyPlan(req, res) {
  const cur = await getProject(req.params.id);
  assertIdle(cur);
  const plan = cur.pendingPlan;
  if (!plan || plan.id !== req.body.planId) throw httpError(400, '這個修改計畫已失效，請重新規劃');
  if (cur.revisionsUsed + plan.cost > config.maxRevisions) throw httpError(403, `修改次數不足：剩 ${config.maxRevisions - cur.revisionsUsed} 次，這次需要 ${plan.cost} 次`);
  const aiImg = [];
  for (const v of plan.visuals) if (v.newImage) aiImg.push({ i: v.index, ...(await generateSceneImage(cur, v.index, plan.instruction)) });
  const p = await updateProject(cur.id, (p) => {
    assertIdle(p);
    for (const r of plan.narration) p.script.scenes[r.index].narration = r.narration.slice(0, 200);
    for (const r of plan.headlines) p.script.scenes[r.index].headline = r.headline;
    for (const r of aiImg) {
      p.assets.push(r.asset);
      p.scenes[r.i].assetId = r.asset.id;
      p.cost.usd = Math.round((p.cost.usd + r.cost.usd) * 1000) / 1000;
      p.cost.items.push({ ...r.cost, version: p.versions.length + 1 });
    }
    for (const r of plan.visuals) {
      p.script.scenes[r.index].motionPrompt = r.motionPrompt;
      p.scenes[r.index].variant = (p.scenes[r.index].variant || 0) + 1;
    }
    const s = plan.settings || {};
    if (s.speed !== undefined && validSpeed(s.speed)) p.settings.speed = validSpeed(s.speed);
    if (config.transitions[s.transition]) p.settings.transition = s.transition;
    if (config.subtitleStyles[s.subtitle]) p.settings.subtitle = s.subtitle;
    if (typeof s.headlines === 'boolean') p.settings.headlines = s.headlines;
    if (s.music === 'none') p.settings.bgmAssetId = null;
    else if (s.music && validBgm(p, s.music)) p.settings.bgmAssetId = s.music;
    p.revisionsUsed += plan.cost;
    p.pendingPlan = null;
    p.job = { status: 'queued', step: '排隊中', progress: 0, revisionCost: plan.cost, updatedAt: new Date().toISOString() };
  });
  const touched = [...new Set([...plan.visuals.map((x) => x.index), ...plan.narration.map((x) => x.index)])].sort((a, b) => a - b);
  startRender(p.id, { isRevision: true, note: `一句話：${plan.instruction}`, regenerated: touched.length ? touched : ['global'] }, (proj) => {
    proj.revisionsUsed -= plan.cost;
  });
  res.status(202).json(publicView(p));
}

/* ---------- 修改（最多 5 次） ---------- */
app.post('/api/projects/:id/revise', wrap(async (req, res) => {
  if (req.body?.planId) return applyPlan(req, res);
  const { scenes: sel = [], types = [], note = '', sceneEdits = {}, settings = {}, full = false } = req.body || {};
  const cur = await getProject(req.params.id);
  assertIdle(cur);
  if (!cur.versions.length) throw httpError(400, '還沒有影片可以修改');
  const cost = full ? config.fullRedoCost : 1;
  if (cur.revisionsUsed + cost > config.maxRevisions) {
    throw httpError(403, `修改次數不足：剩 ${config.maxRevisions - cur.revisionsUsed} 次，這次需要 ${cost} 次`);
  }
  const n = cur.script.scenes.length;
  const indexes = full ? [...Array(n).keys()] : [...new Set(sel.map(Number))].filter((i) => i >= 0 && i < n);
  const sceneTypes = ['visual', 'narration'];
  const globalTypes = ['voice', 'subtitle', 'bgm'];
  if (!full) {
    if (!types.length) throw httpError(400, '請選擇要修改的項目');
    if (types.some((t) => sceneTypes.includes(t)) && !indexes.length) throw httpError(400, '請在時間軸選擇要修改的場景');
    if (indexes.length > config.maxScenesPerRevision) throw httpError(400, `每次最多修改 ${config.maxScenesPerRevision} 個場景；要大改請用「全片重做」`);
  }

  // 要求 AI 新生成圖片的場景，先把圖做好
  const aiImg = [];
  for (const i of indexes) {
    if (sceneEdits[i]?.assetId === '__ai__') aiImg.push({ i, ...(await generateSceneImage(cur, i, note)) });
  }

  // AI 改寫旁白（有填修改說明、又沒有手動給新旁白的場景）
  let rewrites = [];
  const wantsNarration = full ? Boolean(note) : types.includes('narration');
  if (wantsNarration) {
    const need = indexes.filter((i) => !sceneEdits[i]?.narration);
    if (need.length && note) rewrites = await gemini.rewriteScenes(cur.brief, cur.script.scenes, need, note);
  }

  const p = await updateProject(req.params.id, (p) => {
    assertIdle(p);
    if (p.revisionsUsed + cost > config.maxRevisions) throw httpError(403, '修改次數不足');
    if (full || types.includes('narration')) {
      for (const i of indexes) {
        const t = sceneEdits[i]?.narration;
        if (typeof t === 'string' && t.trim()) p.script.scenes[i].narration = t.trim().slice(0, 200);
        const h = sceneEdits[i]?.headline;
        if (typeof h === 'string') p.script.scenes[i].headline = h.trim().slice(0, 12);
        const va = sceneEdits[i]?.voiceAssetId;
        if (va === null || va === '') p.scenes[i].voiceAssetId = null;
        else if (va && p.assets.some((a) => a.id === va && a.voice)) p.scenes[i].voiceAssetId = va;
      }
      for (const r of rewrites) p.script.scenes[r.index].narration = r.narration;
    }
    for (const r of aiImg) {
      p.assets.push(r.asset);
      p.cost.usd = Math.round((p.cost.usd + r.cost.usd) * 1000) / 1000;
      p.cost.items.push({ ...r.cost, version: p.versions.length + 1 });
      sceneEdits[r.i] = { ...(sceneEdits[r.i] || {}), assetId: r.asset.id };
    }
    if (full || types.includes('visual')) {
      for (const i of indexes) {
        const e = sceneEdits[i] || {};
        if (e.assetId && p.assets.some((a) => a.id === e.assetId)) p.scenes[i].assetId = e.assetId;
        if (['ai', 'kenburns'].includes(e.motion)) p.scenes[i].motion = e.motion;
        p.scenes[i].variant = (p.scenes[i].variant || 0) + 1;
        if (note && !full) p.script.scenes[i].motionPrompt = `${p.script.scenes[i].motionPrompt.split('; adjustment:')[0]}; adjustment: ${note}`.slice(0, 600);
      }
      enforceAiCap(p);
    }
    if (types.includes('voice') && validVoice(settings.voice)) p.settings.voice = settings.voice;
    if (types.includes('voice') && settings.speed !== undefined && validSpeed(settings.speed)) p.settings.speed = validSpeed(settings.speed);
    if (types.includes('subtitle') && config.subtitleStyles[settings.subtitle]) p.settings.subtitle = settings.subtitle;
    if (types.includes('subtitle') && config.transitions[settings.transition]) p.settings.transition = settings.transition;
    if (types.includes('subtitle') && typeof settings.headlines === 'boolean') p.settings.headlines = settings.headlines;
    if (types.includes('bgm')) p.settings.bgmAssetId = validBgm(p, settings.bgmAssetId);
    if (full) p.scenes.forEach((s) => (s.ttsVariant = (s.ttsVariant || 0) + 1));
    p.revisionsUsed += cost;
    p.job = { status: 'queued', step: '排隊中', progress: 0, revisionCost: cost, updatedAt: new Date().toISOString() };
  });

  const touched = full ? 'all' : [...new Set([...indexes, ...(types.some((t) => globalTypes.includes(t)) ? ['global'] : [])])];
  startRender(p.id, { isRevision: true, note: note || types.join('、'), regenerated: touched }, (proj) => {
    proj.revisionsUsed -= cost; // 產生失敗就把次數還給使用者
  });
  res.status(202).json(publicView(p));
}));

/* ---------- AI 一鍵成片：文案 → 生圖 → 產生影片，一次完成 ---------- */
app.post('/api/projects/:id/auto', wrap(async (req, res) => {
  const tier = config.tiers[req.body?.tier] ? req.body.tier : 'premium';
  const brandNow = await getBrand();
  const p = await updateProject(req.params.id, (p) => {
    assertIdle(p);
    if (p.versions.length) throw httpError(409, '這個專案已經有影片了，請用修改功能');
    p.settings.tier = tier;
    if (validVoice(req.body?.voice)) p.settings.voice = req.body.voice;
    if (req.body && 'bgm' in req.body) p.settings.bgmAssetId = validBgm(p, req.body.bgm);
    if (p.settings.voice === 'narrator' && !brandNow.narratorVoice) p.settings.voice = 'female-warm';
    p.job = { status: 'queued', step: 'AI 一鍵成片：排隊中', progress: 0, auto: true, updatedAt: new Date().toISOString() };
  });
  const id = p.id;
  enqueue(async () => {
    const setJob = (patch) => updateProject(id, (x) => (x.job = { ...x.job, ...patch, updatedAt: new Date().toISOString() }));
    let cur = await getProject(id);
    if (!cur.script) {
      await setJob({ status: 'running', step: 'AI 撰寫文案中', progress: 2 });
      const script = await gemini.generateScript(cur.brief, '', sceneCountOf(cur));
      script.title = script.titles[0];
      cur = await updateProject(id, (x) => {
        x.script = script;
        x.scenes = [];
        ensureScenes(x);
      });
    }
    // 沒有圖的場景用 AI 生圖（有上傳的照用）
    cur = await updateProject(id, (x) => {
      ensureScenes(x);
      markNarrator(x);
      applyMotion(x);
    });
    const hasNarrator = Boolean(narratorPath(await getBrand()));
    const need = cur.scenes.map((s, i) => (s.assetId || (s.narrator && hasNarrator) ? null : i)).filter((x) => x !== null);
    if (need.length) {
      await setJob({ status: 'running', step: `AI 生成 ${need.length} 張場景圖片`, progress: 4 });
      await addAiImages(id, need);
    }
    await render(id, { isRevision: false, note: 'AI 一鍵成片' });
  }).catch(async (e) => {
    console.error('[auto]', id, e);
    await updateProject(id, (x) => {
      x.job = { status: 'error', step: '失敗', progress: 0, error: e.message, updatedAt: new Date().toISOString() };
    }).catch(() => {});
  });
  res.status(202).json(publicView(p));
}));

/* ---------- 失敗後重試（不扣次數） ---------- */
app.post('/api/projects/:id/retry', wrap(async (req, res) => {
  const p = await updateProject(req.params.id, (p) => {
    if (p.job?.status !== 'error') throw httpError(400, '目前沒有失敗的任務');
    if (p.versions.length) throw httpError(400, '修改失敗時次數已退回，請重新送出修改');
    p.job = { status: 'queued', step: '排隊中', progress: 0, updatedAt: new Date().toISOString() };
  });
  startRender(p.id, { isRevision: false });
  res.status(202).json(publicView(p));
}));

/* ---------- 配音試聽（不扣修改次數） ---------- */
app.post('/api/projects/:id/tts-preview', wrap(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p.script) throw httpError(400, '請先產生文案');
  const index = Number(req.body?.index ?? 0);
  if (!(index >= 0 && index < p.script.scenes.length)) throw httpError(400, '場景編號錯誤');
  // 可順便帶入要試聽的聲線／語速（不會存檔）
  const tmp = { ...p.settings };
  if (validVoice(req.body?.voice)) tmp.voice = req.body.voice;
  if (req.body?.speed !== undefined && validSpeed(req.body.speed)) tmp.speed = validSpeed(req.body.speed);
  const name = await previewNarration(p.id, index, req.body?.text, tmp);
  res.json({ url: `/api/projects/${p.id}/preview/${name}` });
}));

app.get('/api/projects/:id/preview/:file', wrap(async (req, res) => {
  const file = path.basename(req.params.file);
  if (!/^prev-[a-f0-9]+-[\d.]+\.wav$/.test(file)) throw httpError(404, '找不到試聽檔');
  res.sendFile(path.join(projectDir(req.params.id), 'cache', file));
}));

/* ---------- 封面：用指定時間的畫面重做（免費） ---------- */
app.post('/api/projects/:id/cover', wrap(async (req, res) => {
  const p = await getProject(req.params.id);
  const n = Number(req.body?.version) || p.versions.at(-1)?.n;
  if (!n) throw httpError(400, '還沒有影片');
  const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 40) : undefined;
  await remakeCover(p.id, n, req.body?.time, title);
  res.json(publicView(await getProject(p.id)));
}));

/* ---------- 品牌設定 ---------- */
app.get('/api/brand', wrap(async (req, res) => {
  const b = await getBrand();
  res.json({ ...b, logoUrl: b.logoFile ? `/api/brand/logo?v=${encodeURIComponent(b.logoFile)}` : null, narratorUrl: b.narratorPhoto ? `/api/brand/narrator?v=${encodeURIComponent(b.narratorPhoto)}` : null });
}));
app.put('/api/brand', wrap(async (req, res) => {
  const b = await saveBrand(req.body || {});
  res.json({ ...b, logoUrl: b.logoFile ? `/api/brand/logo?v=${encodeURIComponent(b.logoFile)}` : null, narratorUrl: b.narratorPhoto ? `/api/brand/narrator?v=${encodeURIComponent(b.narratorPhoto)}` : null });
}));
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await fs.mkdir(brandDir, { recursive: true });
      cb(null, brandDir);
    },
    filename: (req, file, cb) => cb(null, `logo-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z]/g, '') || '.png'}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpeg|webp)$/.test(file.mimetype);
    cb(ok ? null : httpError(400, 'Logo 請用 PNG（建議透明背景）、JPG 或 WebP'), ok);
  }
});
app.post('/api/brand/logo', (req, res, next) =>
  logoUpload.single('logo')(req, res, async (err) => {
    try {
      if (err) throw err.status ? err : httpError(400, err.message);
      if (!req.file) throw httpError(400, '請選擇 Logo 檔案');
      const old = await getBrand();
      if (old.logoFile) await fs.unlink(logoPath(old)).catch(() => {});
      const b = await saveBrand({ logoFile: req.file.filename });
      res.json({ ...b, logoUrl: `/api/brand/logo?v=${encodeURIComponent(b.logoFile)}` });
    } catch (e) {
      next(e);
    }
  })
);
app.post('/api/brand/narrator', (req, res, next) =>
  logoUpload.single('photo')(req, res, async (err) => {
    try {
      if (err) throw err.status ? err : httpError(400, err.message);
      if (!req.file) throw httpError(400, '請選擇說書人照片');
      const old = await getBrand();
      if (old.narratorPhoto) await fs.unlink(narratorPath(old)).catch(() => {});
      const b = await saveBrand({ narratorPhoto: req.file.filename });
      res.json(b);
    } catch (e) {
      next(e);
    }
  })
);
/* ---------- 內建虛擬說書人、說書人聲音 ---------- */
app.get('/api/narrator/presets', wrap(async (req, res) => res.json(await narr.presetsView())));
app.get('/api/narrator/preset-photo/:id', wrap(async (req, res) => {
  const f = await narr.presetPhotoPath(req.params.id);
  if (!f) throw httpError(404, '還沒生成');
  res.sendFile(f);
}));
app.post('/api/brand/narrator/preset', wrap(async (req, res) => res.json(await narr.usePresetPhoto(String(req.body?.id || '')))));
app.post('/api/brand/voice/preset', wrap(async (req, res) => res.json(await narr.usePresetVoice(String(req.body?.id || '')))));
app.delete('/api/brand/voice', wrap(async (req, res) => res.json(await saveBrand({ narratorVoice: null }))));

const cloneUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      const d = path.join(config.dataDir, 'library', 'uploads');
      await fs.mkdir(d, { recursive: true });
      cb(null, d);
    },
    filename: (req, file, cb) => cb(null, `${file.fieldname}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.webm'}`)
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || /^video\/(webm|mp4)$/.test(file.mimetype);
    cb(ok ? null : httpError(400, '請上傳音檔（MP3、M4A、WAV、WebM）'), ok);
  }
});
app.post('/api/brand/voice/clone', (req, res, next) =>
  cloneUpload.fields([{ name: 'source', maxCount: 1 }, { name: 'consent', maxCount: 1 }])(req, res, async (err) => {
    const files = [req.files?.source?.[0], req.files?.consent?.[0]].filter(Boolean);
    try {
      if (err) throw err.status ? err : httpError(400, err.message);
      if (!req.files?.source?.[0]) throw httpError(400, '請錄製或上傳 10–30 秒的聲音樣本');
      if (!req.files?.consent?.[0]) throw httpError(400, '請錄製同意聲明');
      res.json(await narr.cloneVoice(req.files.source[0].path, req.files.consent[0].path, String(req.body?.label || '說書人的聲音').slice(0, 20)));
    } catch (e) {
      next(e);
    } finally {
      for (const f of files) await fs.unlink(f.path).catch(() => {});
    }
  })
);

// 試聽說書人的聲音
app.post('/api/brand/voice/test', wrap(async (req, res) => {
  const b = await getBrand();
  if (!b.narratorVoice) throw httpError(400, '還沒有設定說書人的聲音');
  const text = String(req.body?.text || '大家好，我是今天的說書人。接下來，我想跟你分享一個溫暖的故事。').slice(0, 120);
  const dir = path.join(config.dataDir, 'library');
  await fs.mkdir(dir, { recursive: true });
  const name = `test-${crypto.createHash('sha1').update(b.narratorVoice.id + text).digest('hex').slice(0, 12)}.wav`;
  const out = path.join(dir, name);
  try {
    await fs.access(out);
  } catch {
    if (config.mock) {
      const { mockSpeech } = await import('./media.js');
      await mockSpeech(text, out);
    } else {
      const { speechToWav } = await import('./media.js');
      await speechToWav(await providers.synthesizeSpeech(text, b.narratorVoice.id), out);
    }
  }
  res.json({ url: `/api/narrator/test/${name}` });
}));
app.get('/api/narrator/test/:file', wrap(async (req, res) => {
  const f = path.basename(req.params.file);
  if (!/^test-[a-f0-9]+\.wav$/.test(f)) throw httpError(404, '找不到');
  res.sendFile(path.join(config.dataDir, 'library', f));
}));

app.delete('/api/brand/narrator', wrap(async (req, res) => {
  const old = await getBrand();
  if (old.narratorPhoto) await fs.unlink(narratorPath(old)).catch(() => {});
  res.json(await saveBrand({ narratorPhoto: null }));
}));
app.get('/api/brand/narrator', wrap(async (req, res) => {
  const f = narratorPath(await getBrand());
  if (!f) throw httpError(404, '尚未上傳說書人照片');
  res.sendFile(f);
}));
app.delete('/api/brand/logo', wrap(async (req, res) => {
  const old = await getBrand();
  if (old.logoFile) await fs.unlink(logoPath(old)).catch(() => {});
  res.json(await saveBrand({ logoFile: null }));
}));
app.get('/api/brand/logo', wrap(async (req, res) => {
  const b = await getBrand();
  const f = logoPath(b);
  if (!f) throw httpError(404, '尚未上傳 Logo');
  res.sendFile(f);
}));

/* ---------- 影片檔 ---------- */
app.get('/api/projects/:id/versions/:file', wrap(async (req, res) => {
  const file = path.basename(req.params.file);
  if (!/^v\d+(\.mp4|-cover\.jpg)$/.test(file)) throw httpError(404, '找不到影片');
  if (req.query.download) res.attachment(`video-${file}`);
  res.sendFile(path.join(projectDir(req.params.id), 'versions', file));
}));

/* ---------- 錯誤處理 ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: '找不到這個 API' }));
app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '檔案超過 20MB' : err.message || '伺服器錯誤' });
});

/* ---------- 啟動：把重啟前中斷的任務標成失敗 ---------- */
async function recoverJobs() {
  await fs.mkdir(projectsDir, { recursive: true });
  for (const id of await fs.readdir(projectsDir)) {
    try {
      await updateProject(id, (p) => {
        if (p.job && ['queued', 'running'].includes(p.job.status)) {
          const refund = p.job.revisionCost || 0;
          p.job = { status: 'error', step: '失敗', progress: 0, error: '伺服器重新啟動，任務中斷，請重新送出（修改次數已退回）', updatedAt: new Date().toISOString() };
          p.revisionsUsed = Math.max(0, p.revisionsUsed - refund);
        }
      });
    } catch {
      /* 略過 */
    }
  }
}

await recoverJobs();
app.listen(config.port, () => {
  console.log(`短影工坊已啟動：http://localhost:${config.port}  ${config.mock ? '（模擬模式：不呼叫 AI、不花錢）' : `（文案 ${config.textProvider}／配音 ${config.ttsProvider}／畫面 ${config.videoProvider}／補圖 ${config.imageProvider}／對嘴 ${config.lipsyncProvider}）`}`);
});
