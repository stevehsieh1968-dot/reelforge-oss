// 短影工坊前端：不需編譯的原生 JavaScript
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const app = $('#app');
let cfg = null;
let project = null;
let pollTimer = null;
const revise = { scenes: new Set(), types: new Set(), full: false };

/* ---------- API ---------- */
async function api(method, url, body, isForm = false) {
  const res = await fetch(url, {
    method,
    headers: isForm || !body ? {} : { 'Content-Type': 'application/json' },
    body: isForm ? body : body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `發生錯誤（${res.status}）`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), isErr ? 6000 : 2800);
}

async function busy(btn, label, fn) {
  const old = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(label)}`;
  }
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn && document.body.contains(btn)) {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }
}

// 背景音樂選單：不使用＋內建 5 首＋自己上傳的
function bgmOptions(selected, audios) {
  return `<option value="">不使用</option>
    <optgroup label="內建免費配樂">${cfg.music.map((m, i) => `<option value="${m.id}" ${selected === m.id ? 'selected' : ''}>${i + 1}. ${esc(m.label)}</option>`).join('')}</optgroup>
    ${selected?.startsWith('builtin:') && !cfg.music.some((m) => m.id === selected) ? `<option value="${selected}" selected>（舊版配樂）${esc(selected.slice(8))}</option>` : ''}
    ${audios.length ? `<optgroup label="我上傳的">${audios.map((x) => `<option value="${x.id}" ${selected === x.id ? 'selected' : ''}>${esc(x.originalName)}</option>`).join('')}</optgroup>` : ''}`;
}

let brandInfo = {};
async function loadBrand() {
  try {
    brandInfo = await api('GET', '/api/brand');
  } catch {}
}

// 說書人錄音：按一下開始、再按一下停止，自動上傳
let recorder = null;
async function toggleRecord(btn, onDone) {
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return toast('無法使用麥克風：請在瀏覽器網址列允許麥克風權限', true);
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || 'audio/webm';
    recorder = null;
    btn.classList.remove('rec');
    btn.textContent = '🎙';
    await onDone(new Blob(chunks, { type }), type.includes('mp4') ? 'rec.m4a' : 'rec.webm');
  };
  recorder.start();
  btn.classList.add('rec');
  btn.textContent = '⏹';
  toast('錄音中…照著這一場的旁白唸，唸完再按一次 ⏹');
}
async function uploadVoice(index, blob, name) {
  const fd = new FormData();
  fd.append('voice', blob, name);
  return api('POST', `/api/projects/${project.id}/scenes/${index}/voice`, fd, true);
}

/* ---------- 說書人面板（照片＋聲音），一鍵成片與品牌設定共用 ---------- */
const SAMPLE_TEXT = '大家好，很高興認識你。我想跟你分享一個故事，關於一個平凡的人，如何在忙碌的生活裡，找到溫暖和力量。每個人都有自己的故事，而一個好的故事，總能讓我們重新相信美好，也讓我們更願意去關心身邊的人。';
const cloneState = { source: null, consent: null };

function voiceOptions(selected) {
  const ai = Object.entries(cfg.voices).map(([k, v]) => `<option value="${k}" ${selected === k ? 'selected' : ''}>AI 聲線：${esc(v)}</option>`).join('');
  const nv = brandInfo.narratorVoice ? `<option value="narrator" ${selected === 'narrator' ? 'selected' : ''}>🎙 說書人的聲音（${esc(brandInfo.narratorVoice.label)}）</option>` : '';
  return nv + ai;
}

function narratorPanel() {
  const P = cfg.narrPresets || { photos: [], voices: [] };
  const nv = brandInfo.narratorVoice;
  return `<div class="narrpanel">
    <div class="field"><span class="label">說書人照片</span>
      <div class="row" style="gap:10px;align-items:flex-start">
        ${brandInfo.narratorUrl ? `<img src="${brandInfo.narratorUrl}" alt="目前的說書人照片" class="narrthumb">` : '<div class="narrthumb ph small">尚未設定</div>'}
        <div style="display:flex;flex-direction:column;gap:8px;flex:1;min-width:0">
          <label class="btn" style="cursor:pointer">⬆ 上傳照片<input type="file" accept="image/png,image/jpeg,image/webp" id="npUpload" class="sr"></label>
          <div class="row" style="gap:6px;flex-wrap:nowrap"><select id="npPreset" aria-label="選內建說書人">${P.photos.map((p) => `<option value="${p.id}">內建：${esc(p.label)}</option>`).join('')}</select>
          <button type="button" class="btn" id="npUsePreset">使用</button></div>
        </div>
      </div>
      <span class="small muted">內建說書人是 AI 生成的虛構人物，沒有肖像權問題（第一次使用約 NT$1）。</span>
    </div>
    <div class="field"><span class="label">說書人聲音</span>
      <div class="row small">${nv ? `目前：<strong>${esc(nv.label)}</strong> <button type="button" class="btn" id="nvTest" style="min-height:36px">▶ 試聽</button> <button type="button" class="linkbtn" id="nvDel">移除</button>` : '<span class="muted">尚未設定（會用 AI 聲線）</span>'}</div>
      <div class="row" style="gap:6px;flex-wrap:nowrap"><select id="nvPreset" aria-label="內建說書人聲音">${P.voices.map((v) => `<option value="${v.id}">內建：${esc(v.label)}</option>`).join('')}</select>
        <button type="button" class="btn" id="nvUsePreset">使用</button></div>
      <details class="clonebox"><summary><strong>用說書人自己的聲音</strong>（錄音或上傳，約 1 分鐘完成）</summary>
        <ol class="small">
          <li><strong>聲音樣本（10–30 秒）</strong>：請用自然的語氣唸這段：<div class="readme">${SAMPLE_TEXT}</div>
            <div class="row" style="gap:6px"><button type="button" class="btn" id="cvRecSrc">🎙 錄音</button><label class="btn" style="cursor:pointer">⬆ 上傳<input type="file" accept="audio/*" id="cvUpSrc" class="sr"></label><span id="cvSrcStat">${cloneState.source ? '✓ 已準備' : ''}</span></div></li>
          <li><strong>同意聲明</strong>：同一個人、同一支麥克風，用國語清楚唸：<div class="readme">${esc(P.consent || '')}</div>
            <div class="row" style="gap:6px"><button type="button" class="btn" id="cvRecCon">🎙 錄音</button><label class="btn" style="cursor:pointer">⬆ 上傳<input type="file" accept="audio/*" id="cvUpCon" class="sr"></label><span id="cvConStat">${cloneState.consent ? '✓ 已準備' : ''}</span></div></li>
        </ol>
        <button type="button" class="btn primary" id="cvCreate">建立說書人的聲音</button>
        <p class="small muted" style="margin:0">只能複製你本人或已取得同意者的聲音。${cfg.providers?.tts === 'gemini' ? '這是 Google 的規定，同意聲明會被自動比對。' : '本機版用 BreezyVoice 在你的電腦上複製（需在 .env 設 TTS_ENGINE=breezy），聲音不會上傳。'}</p>
      </details>
    </div>
    ${lipsyncField()}
  </div>`;
}

function lipsyncField() {
  if (cfg.providers && cfg.providers.lipsync !== 'gemini') {
    return `<div class="field"><span class="small muted">說書人出鏡：目前用「照片＋鏡頭推移＋配音」（免費）。要真人對嘴，請在 .env 設 LIPSYNC_PROVIDER=gemini（付費）。</span></div>`;
  }
  const on = !!brandInfo.narratorLipsync;
  const rate = cfg.pricing?.lipsyncPerSecond ?? 0.07;
  const twd45 = Math.round(45 * rate * (cfg.pricing?.usdToTwd || 32));
  const voices = cfg.lipsyncVoices || {};
  return `<div class="field lipbox${on ? ' on' : ''}">
      <label class="row" style="gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="lipOn" ${on ? 'checked' : ''}> <strong>真人對嘴（Omni）</strong></label>
      <span class="small muted">說書人出鏡的場景，由 Google Gemini 影片模型依照片和台詞一次做出「說話的畫面＋聲音」，嘴型會對上。
        聲音由 AI 依下方類型產生（Google 目前不開放用自己的聲音對嘴），自己錄音的場景不受影響。
        費用約 US$${rate}／秒，例如說書人出鏡 45 秒約 NT$${twd45}。</span>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <select id="lipVoice" aria-label="對嘴聲音類型" ${on ? '' : 'disabled'}>${Object.entries(voices).map(([k, v]) => `<option value="${k}" ${brandInfo.lipsyncVoice === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <input id="lipNote" maxlength="60" placeholder="補充（選填），例如：語速慢一點、帶點笑意" value="${esc(brandInfo.lipsyncVoiceNote || '')}" ${on ? '' : 'disabled'} style="flex:1;min-width:180px">
      </div>
      <span class="small muted">中文對嘴效果 Google 尚未正式評估，建議先用 1 分鐘影片試做。</span>
    </div>`;
}

function bindNarratorPanel(rerender) {
  const after = async (msg) => {
    await loadBrand();
    toast(msg);
    rerender();
  };
  const saveLip = async (msg) => {
    const on = $('#lipOn').checked;
    await api('PUT', '/api/brand', { narratorLipsync: on, lipsyncVoice: $('#lipVoice').value, lipsyncVoiceNote: $('#lipNote').value })
      .then(async () => {
        await loadBrand();
        $('#lipVoice').disabled = !on;
        $('#lipNote').disabled = !on;
        $('#lipOn').closest('.lipbox').classList.toggle('on', on);
        if (msg) toast(msg);
      })
      .catch((err) => toast(err.message, true));
  };
  $('#lipOn').onchange = () => saveLip($('#lipOn').checked ? (brandInfo.narratorUrl ? '已開啟真人對嘴' : '已開啟真人對嘴，請記得設定說書人照片') : '已關閉真人對嘴');
  $('#lipVoice').onchange = () => saveLip('已更新對嘴聲音');
  $('#lipNote').onchange = () => saveLip('已更新聲音補充');
  $('#npUpload').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('photo', f);
    await api('POST', '/api/brand/narrator', fd, true).then(() => after('說書人照片已更新')).catch((err) => toast(err.message, true));
  };
  $('#npUsePreset').onclick = (e) =>
    busy(e.currentTarget, '生成中…', async () => {
      await api('POST', '/api/brand/narrator/preset', { id: $('#npPreset').value });
      cfg.narrPresets = await api('GET', '/api/narrator/presets');
      await after('已換成內建說書人');
    });
  $('#nvUsePreset').onclick = (e) =>
    busy(e.currentTarget, '建立中…', async () => {
      await api('POST', '/api/brand/voice/preset', { id: $('#nvPreset').value });
      await after('已設定說書人聲音，按 ▶ 試聽');
    });
  if ($('#nvTest')) $('#nvTest').onclick = (e) =>
    busy(e.currentTarget, '產生中…', async () => {
      const r = await api('POST', '/api/brand/voice/test', {});
      if (previewAudio) previewAudio.pause();
      previewAudio = new Audio(r.url);
      previewAudio.play().catch(() => {});
    });
  if ($('#nvDel')) $('#nvDel').onclick = () => api('DELETE', '/api/brand/voice').then(() => after('已移除說書人聲音'));
  const setClip = (key, blob, name) => {
    cloneState[key] = { blob, name };
    $(key === 'source' ? '#cvSrcStat' : '#cvConStat').textContent = '✓ 已準備';
  };
  $('#cvRecSrc').onclick = (e) => toggleRecord(e.currentTarget, async (b, n) => setClip('source', b, n));
  $('#cvRecCon').onclick = (e) => toggleRecord(e.currentTarget, async (b, n) => setClip('consent', b, n));
  $('#cvUpSrc').onchange = (e) => e.target.files[0] && setClip('source', e.target.files[0], e.target.files[0].name);
  $('#cvUpCon').onchange = (e) => e.target.files[0] && setClip('consent', e.target.files[0], e.target.files[0].name);
  $('#cvCreate').onclick = (e) => {
    if (!cloneState.source || !cloneState.consent) return toast('請先準備聲音樣本和同意聲明兩段錄音', true);
    busy(e.currentTarget, '建立中，約 1 分鐘…', async () => {
      const fd = new FormData();
      fd.append('source', cloneState.source.blob, cloneState.source.name);
      fd.append('consent', cloneState.consent.blob, cloneState.consent.name);
      await api('POST', '/api/brand/voice/clone', fd, true);
      cloneState.source = cloneState.consent = null;
      await after('已建立說書人的聲音，按 ▶ 試聽');
    });
  };
}

let previewAudio = null;
async function listen(btn, index, extra = {}) {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  await busy(btn, '產生中…', async () => {
    const r = await api('POST', `/api/projects/${project.id}/tts-preview`, { index, ...extra });
    previewAudio = new Audio(r.url);
    previewAudio.play().catch(() => {});
  });
}
// 語速滑桿 0.8–1.5 倍
function speedSlider(id, value, disabled = false) {
  const r = cfg.speedRange || { min: 0.8, max: 1.5, step: 0.05 };
  const v = Number(value || 1);
  return `<div class="speed"><input type="range" id="${id}" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}" ${disabled ? 'disabled' : ''} aria-label="語速">
    <output for="${id}" id="${id}Val" class="num">${v.toFixed(2)}×</output></div>`;
}
function bindSpeed(id, onChange) {
  const el = $('#' + id);
  if (!el) return;
  el.oninput = () => ($('#' + id + 'Val').textContent = `${Number(el.value).toFixed(2)}×`);
  if (onChange) el.onchange = () => onChange(Number(el.value));
}
function previewBgm(id) {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  if (!id) return;
  const m = cfg.music.find((x) => x.id === id);
  const a = project?.assets.find((x) => x.id === id);
  const src = m ? m.url : id?.startsWith('builtin:') ? `/music/${id.slice(8)}.mp3` : a ? `/api/projects/${project.id}/assets/${a.file}` : null;
  if (!src) return;
  previewAudio = new Audio(src);
  previewAudio.volume = 0.6;
  previewAudio.play().catch(() => {});
  setTimeout(() => previewAudio?.pause(), 15000);
}

// 這支影片的長度（秒）：需求選的 1／2／3 分鐘
const tgt = (b = project?.brief) => (cfg.durations.includes(Number(b?.duration)) ? Number(b.duration) : cfg.targetSeconds);
const recommendScenes = (secs) => ({ 60: 6, 120: 8, 180: 10 })[secs] || cfg.sceneCount;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// 方案的 AI 動態場景數（依場景數比例）
const aiCount = (tier, n) => Math.max(1, Math.min(n, Math.round(n * (cfg.tiers[tier]?.aiRatio ?? 1))));
// 一支影片（初版）的 AI 費用預估（新台幣）
function estimateTwd(tier, n, secs = tgt()) {
  const pr = cfg.pricing || { videoPerSecond: 0.1, image: 0.034, usdToTwd: 32.4 };
  const aiSecs = (secs * aiCount(tier, n)) / n;
  const usd = aiSecs * pr.videoPerSecond + n * pr.image + 0.1;
  return Math.round(usd * pr.usdToTwd);
}

/* ---------- 路由 ---------- */
const STEPS = [
  { key: 'brief', label: '1 需求' },
  { key: 'script', label: '2 文案' },
  { key: 'assets', label: '3 素材' },
  { key: 'video', label: '4 預覽修改' }
];

function go(step) {
  location.hash = project ? `#/p/${project.id}/${step}` : '#/';
}

function renderSteps(active) {
  const can = {
    brief: true,
    script: Boolean(project?.script),
    assets: Boolean(project?.script),
    video: Boolean(project?.versions?.length || project?.job)
  };
  $('#steps').innerHTML = STEPS.map(
    (s) =>
      `<a href="${project ? `#/p/${project.id}/${s.key}` : '#/'}" ${s.key === active ? 'aria-current="step"' : ''} ${can[s.key] ? '' : 'aria-disabled="true"'}>${s.label}</a>`
  ).join('');
  $('#steps').insertAdjacentHTML('beforeend', `<a href="#/brand" ${active === 'brandkit' ? 'aria-current="step"' : ''}>品牌設定</a>`);
  $('#who').textContent = project ? `${project.brief.brand || '未命名'} · 剩 ${project.revisionsLeft} 次修改` : '';
}

async function route() {
  clearInterval(pollTimer);
  if (location.hash === '#/brand') {
    renderSteps('brandkit');
    return viewBrandKit();
  }
  const m = location.hash.match(/^#\/p\/([a-f0-9-]{36})\/(\w+)/);
  if (!m) {
    project = null;
    renderSteps('brief');
    return viewHome();
  }
  try {
    if (!project || project.id !== m[1]) project = await api('GET', `/api/projects/${m[1]}`);
  } catch (e) {
    toast(e.message, true);
    location.hash = '#/';
    return;
  }
  localStorage.setItem('lastProject', project.id);
  const step = m[2];
  renderSteps(step);
  ({ brief: viewBrief, script: viewScript, assets: viewAssets, video: viewVideo }[step] || viewBrief)();
}

/* ---------- 品牌設定（全部影片共用） ---------- */
async function viewBrandKit() {
  const b = await api('GET', '/api/brand');
  const chk = (k, label, desc) =>
    `<label class="option"><input type="checkbox" data-bk="${k}" ${b[k] ? 'checked' : ''}><span><strong>${label}</strong><br><span class="small muted">${desc}</span></span></label>`;
  app.innerHTML = `
  <div class="layout">
    <section class="main">
      <div>
        <p class="eyebrow">品牌設定</p>
        <h1>設定一次，每支影片自動套用</h1>
        <p class="lead">Logo、品牌色、片頭片尾。已經做好的影片要套用新設定，請在修改頁選「字幕／轉場／大字」重新產生。</p>
      </div>
      <div class="card">
        <div class="grid2">
          <div class="field"><label for="bkName">品牌名稱（片尾、封面顯示）</label><input id="bkName" type="text" maxlength="30" value="${esc(b.name)}" placeholder="例：你的品牌名稱"></div>
          <div class="field"><label for="bkColor">品牌色（重點大字、字幕底色、封面）</label><input id="bkColor" type="color" value="${esc(b.color)}" style="height:46px;padding:4px"></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="bkCta">片尾行動呼籲（大字）</label><input id="bkCta" type="text" maxlength="24" value="${esc(b.ctaText)}" placeholder="例：立即私訊預約"></div>
          <div class="field"><label for="bkSub">片尾小字</label><input id="bkSub" type="text" maxlength="40" value="${esc(b.ctaSub)}" placeholder="例：LINE ID @yourbrand"></div>
        </div>
      </div>
      <div class="card">
        <h2>說書人</h2>
        <p class="small muted" style="margin:0">用「說書人」範本時，說書人會在開場、價值主張、結尾等場景出鏡講故事，其他場景以左下角圓形小頭像陪著。建議用正面、光線好的半身照。</p>
        <div class="grid2">
          <div class="field"><label for="bkNarr">說書人名字（小頭像下方顯示，可留白）</label><input id="bkNarr" type="text" maxlength="20" value="${esc(b.narratorName)}" placeholder="例：王老師"></div>
          <label class="option" style="align-self:end"><input type="checkbox" data-bk="narratorPip" ${b.narratorPip ? 'checked' : ''}><span><strong>顯示圓形小頭像</strong><br><span class="small muted">說書人沒出鏡的場景顯示在左下角</span></span></label>
        </div>
        ${narratorPanel()}
        ${b.narratorUrl ? '<button type="button" class="btn" id="bkNarrDel" style="align-self:flex-start">移除說書人照片</button>' : ''}
        <p class="small muted" style="margin:0">提醒：出鏡畫面是 AI 讓照片動起來（表情、手勢），嘴型不會完全對上錄音；真人照片也較容易被 Google 安全過濾，被擋的場景會改用鏡頭推移。</p>
      </div>
      <div class="card">
        <h2>要顯示哪些</h2>
        <div class="grid3">
          ${chk('watermark', 'Logo 浮水印', '右上角小 Logo，全片顯示')}
          ${chk('intro', '片頭 Logo', '開頭 1.5 秒 Logo 淡入淡出')}
          ${chk('outro', '片尾卡', '最後 3 秒畫面變暗，顯示 Logo、品牌名、行動呼籲')}
        </div>
        <p class="small muted" style="margin:0">浮水印、片頭需要上傳 Logo；片尾卡沒有 Logo 也會顯示文字。</p>
      </div>
    </section>
    <aside class="side">
      <div class="card">
        <h2>Logo</h2>
        <div style="background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/20px 20px;border-radius:12px;min-height:160px;display:flex;align-items:center;justify-content:center;padding:16px">
          ${b.logoUrl ? `<img src="${b.logoUrl}" alt="目前的 Logo" style="max-width:100%;max-height:160px">` : '<span class="muted">尚未上傳</span>'}
        </div>
        <label class="btn primary" for="bkLogo" style="cursor:pointer">${b.logoUrl ? '更換 Logo' : '上傳 Logo'}</label>
        <input id="bkLogo" type="file" accept="image/png,image/jpeg,image/webp" class="sr">
        ${b.logoUrl ? '<button type="button" class="btn" id="bkLogoDel">移除 Logo</button>' : ''}
        <p class="small muted" style="margin:0">建議用<strong>透明背景的 PNG</strong>，5MB 內。</p>
      </div>
      ${project ? `<a class="btn block" href="#/p/${project.id}/video">回到目前的專案</a>` : '<a class="btn block" href="#/">回到首頁</a>'}
    </aside>
  </div>`;
  const save = (patch) => api('PUT', '/api/brand', patch).then(loadBrand).then(() => toast('已儲存')).catch((e) => toast(e.message, true));
  $('#bkName').onchange = (e) => save({ name: e.target.value });
  $('#bkColor').onchange = (e) => save({ color: e.target.value });
  $('#bkCta').onchange = (e) => save({ ctaText: e.target.value });
  $('#bkSub').onchange = (e) => save({ ctaSub: e.target.value });
  $('#bkNarr').onchange = (e) => save({ narratorName: e.target.value });
  bindNarratorPanel(viewBrandKit);
  if ($('#bkNarrDel')) $('#bkNarrDel').onclick = () => api('DELETE', '/api/brand/narrator').then(loadBrand).then(viewBrandKit);
  $$('[data-bk]').forEach((c) => (c.onchange = () => save({ [c.dataset.bk]: c.checked })));
  $('#bkLogo').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('logo', f);
    try {
      await api('POST', '/api/brand/logo', fd, true);
      toast('Logo 已上傳');
      viewBrandKit();
    } catch (err) {
      toast(err.message, true);
    }
  };
  if ($('#bkLogoDel')) $('#bkLogoDel').onclick = () => api('DELETE', '/api/brand/logo').then(viewBrandKit);
}

/* ---------- 首頁＋步驟 1：需求 ---------- */
async function viewHome() {
  let list = [];
  try {
    list = await api('GET', '/api/projects');
  } catch {}
  viewBrief(list);
}

function viewBrief(list = []) {
  const b = project?.brief || {};
  const locked = Boolean(project?.versions?.length);
  const purposes = ['產品介紹', '品牌故事', '活動／促銷', '教學／知識', '店家／門市'];
  app.innerHTML = `
  <div class="layout">
    <section class="main">
      <div>
        <p class="eyebrow">步驟 1 / 4</p>
        <h1>告訴我們你要做什麼影片</h1>
        <p class="lead">填得越具體，AI 產生的文案越貼近需求。直式 9:16，長度可選 1／2／3 分鐘。</p>
      </div>
      <form class="card" id="briefForm">
        <div class="grid2">
          <div class="field"><label for="brand">品牌／產品名稱 *</label><input id="brand" name="brand" type="text" required maxlength="60" value="${esc(b.brand)}" placeholder="例：你的品牌名稱"></div>
          <div class="field"><label for="audience">目標受眾 *</label><input id="audience" name="audience" type="text" required maxlength="120" value="${esc(b.audience)}" placeholder="例：25–40 歲上班族、新手爸媽"></div>
        </div>
        <fieldset style="border:0;margin:0;padding:0">
          <legend class="label" style="margin-bottom:6px">影片範本（選一個，AI 會照這個結構寫）</legend>
          <div class="tpls">
            <label class="tpl"><input type="radio" name="template" value="" ${!b.template ? 'checked' : ''}><span><strong>AI 自由發揮</strong><small>依需求自動安排結構</small></span></label>
            ${cfg.templates.map((t) => `<label class="tpl"><input type="radio" name="template" value="${t.id}" ${b.template === t.id ? 'checked' : ''}><span><strong>${esc(t.name)}</strong><small>${esc(t.desc)}</small></span></label>`).join('')}
          </div>
          <div id="tplPreview"></div>
        </fieldset>
        <fieldset style="border:0;margin:0;padding:0">
          <legend class="label" style="margin-bottom:10px">影片目的 *</legend>
          <div class="pills">${purposes
            .map((p, i) => `<label class="pill"><input type="radio" name="purpose" value="${p}" ${(b.purpose || purposes[0]) === p ? 'checked' : ''}><span>${p}</span></label>`)
            .join('')}</div>
        </fieldset>
        <div class="field"><label for="points">核心賣點與必須提到的內容 *</label><textarea id="points" name="points" rows="5" required maxlength="2000" placeholder="例：1. 主要特色…  2. 價格／優惠…  3. 購買方式…">${esc(b.points)}</textarea></div>
        <div class="grid3">
          <div class="field"><label for="tone">語氣風格</label><select id="tone" name="tone">${['親切口語', '專業可信', '活潑幽默', '質感高級'].map((t) => `<option ${b.tone === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="field"><label for="language">旁白語言</label><select id="language" name="language">${['國語（台灣）', '台語', '英文'].map((t) => `<option ${b.language === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="field"><label for="platform">發佈平台</label><select id="platform" name="platform">${['YouTube Shorts', 'Instagram Reels', 'TikTok', 'Facebook'].map((t) => `<option ${b.platform === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="duration">影片長度</label>
            <select id="duration" name="duration">${cfg.durations.map((d) => `<option value="${d}" ${tgt(b) === d ? 'selected' : ''}>${d / 60} 分鐘</option>`).join('')}</select></div>
          <div class="field"><label for="sceneCount">場景數</label>
            <select id="sceneCount" name="sceneCount"></select>
            <span class="small muted" id="sceneHint"></span></div>
        </div>
        <div class="field"><label for="reference">參考影片或網址（選填）</label><input id="reference" name="reference" type="url" value="${esc(b.reference)}" placeholder="https://"></div>
      </form>
    </section>
    <aside class="side">
      <div class="card dark">
        <h2>這支影片的規格</h2>
        <dl class="spec">
          <div><dt>長度</dt><dd class="num" id="specLen">${mmss(tgt(b))}</dd></div>
          <div><dt>比例</dt><dd class="num">9:16</dd></div>
          <div><dt>場景數</dt><dd class="num" id="specScenes">${Number(b.sceneCount || cfg.sceneCount)}</dd></div>
          <div><dt>可修改</dt><dd class="num">${cfg.maxRevisions} 次</dd></div>
        </dl>
        <p class="muted small" style="margin:0">文案階段可無限次調整，不計入影片修改次數。</p>
        <button class="btn primary block" id="toScript" ${locked ? 'disabled' : ''}>${project?.script ? '儲存並重新產生文案' : '產生文案 →'}</button>
        ${project?.script ? `<a class="btn block" href="#/p/${project.id}/script">直接看目前文案</a>` : ''}
        ${locked ? '<p class="small muted" style="margin:0">影片已產生，需求已鎖定。</p>' : ''}
      </div>
      ${locked ? '' : `<div class="card" style="border:1.5px solid var(--accent)">
        <h2>✨ AI 一鍵成片</h2>
        <p class="small muted" style="margin:0">填好需求按一下：AI 自動寫文案、生成每個場景的圖、讓畫面動起來、配音、上字幕與音樂，直接做到影片（約 10–20 分鐘）。之後一樣可以修改 ${cfg.maxRevisions} 次。</p>
        <div class="field"><label for="autoTier">畫面方案</label>
          <select id="autoTier">${Object.entries(cfg.tiers).map(([k, t]) => `<option value="${k}" ${k === 'premium' ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="autoBgm">配樂（免費）</label>
          <div class="row" style="flex-wrap:nowrap;gap:6px"><select id="autoBgm">${bgmOptions(project?.settings?.bgmAssetId ?? 'builtin:piano', [])}</select>
          <button type="button" class="btn" id="autoBgmPlay" style="min-width:76px">▶ 試聽</button></div></div>
        <div class="field"><label for="autoVoice">旁白聲音</label><select id="autoVoice">${voiceOptions(brandInfo.narratorVoice ? 'narrator' : 'female-warm')}</select></div>
        <details class="narrdetails" id="autoNarr"><summary><strong>說書人</strong>（照片、聲音：上傳或內建）${brandInfo.narratorUrl || brandInfo.narratorVoice ? ' · 已設定' : ''}</summary>${narratorPanel()}</details>
        <p class="small" style="margin:0" id="autoEst"></p>
        <button class="btn primary block" id="autoBtn">✨ AI 一鍵成片</button>
      </div>`}
      ${list.length ? `<div class="card"><h2>最近的專案</h2><ul class="projects">${list
        .slice(0, 8)
        .map((p) => `<li><a href="#/p/${p.id}/${p.versions ? 'video' : 'script'}"><span>${esc(p.name || '未命名')}</span><span class="muted small">${p.versions ? `v${p.versions}` : '草稿'}</span></a></li>`)
        .join('')}</ul></div>` : ''}
    </aside>
  </div>`;

  const showTpl = () => {
    const id = $('input[name=template]:checked')?.value;
    const t = cfg.templates.find((x) => x.id === id);
    $('#tplPreview').innerHTML = t
      ? `<details open class="tplbox"><summary><strong>「${esc(t.name)}」的 ${t.scenes.length} 個場景</strong>（場景數不是 ${t.scenes.length} 時，AI 會自動合併或拆開）</summary>
          <ol>${t.scenes.map((s) => `<li><strong>${esc(s.section)}</strong>：${esc(s.goal)}<span class="muted">（畫面：${esc(s.visual)}）</span></li>`).join('')}</ol></details>`
      : '';
  };
  $$('input[name=template]').forEach((r) => (r.onchange = () => {
    const t = cfg.templates.find((x) => x.id === r.value);
    if (t) {
      // 範本會順便帶入建議的目的與語氣（可以再改）
      const pr = $(`input[name=purpose][value="${t.purpose}"]`);
      if (pr) pr.checked = true;
      $('#tone').value = t.tone;
    }
    showTpl();
  }));
  showTpl();
  if ($('#autoBgmPlay')) $('#autoBgmPlay').onclick = () => (previewAudio ? previewBgm(null) : previewBgm($('#autoBgm').value));
  if ($('#autoNarr')) {
    const refresh = () => {
      $('#autoNarr').innerHTML = `<summary><strong>說書人</strong>（照片、聲音：上傳或內建） · 已更新</summary>${narratorPanel()}`;
      $('#autoNarr').open = true;
      const cur = $('#autoVoice').value;
      $('#autoVoice').innerHTML = voiceOptions(brandInfo.narratorVoice && cur !== 'narrator' && !cfg.voices[cur] ? 'narrator' : cur);
      bindNarratorPanel(refresh);
    };
    bindNarratorPanel(refresh);
  }
  const n = () => Number($('#sceneCount').value);
  const dur = () => Number($('#duration').value);
  // 場景數選單依長度更新（1 分鐘建議 6 場、2 分鐘 8 場、3 分鐘 10 場）
  const fillScenes = (keep) => {
    const rec = recommendScenes(dur());
    const cur = keep ? Number(keep) : rec;
    $('#sceneCount').innerHTML = cfg.sceneCountOptions
      .map((k) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${k} 個場景（每場約 ${Math.round(dur() / k)} 秒）${k === rec ? '・建議' : ''}</option>`)
      .join('');
    $('#sceneHint').textContent = `建議 ${rec} 個：每場約 ${Math.round(dur() / rec)} 秒，節奏剛好。`;
    $('#specScenes').textContent = n();
    $('#specLen').textContent = mmss(dur());
  };
  fillScenes(b.sceneCount);
  const est = () => {
    if (!$('#autoEst')) return;
    const t = $('#autoTier').value;
    $('#autoEst').textContent = `AI 動態 ${aiCount(t, n())}/${n()} 場 · 預估 AI 費用約 NT$${estimateTwd(t, n(), dur())}（初版）`;
  };
  $('#duration').onchange = () => (fillScenes(), est());
  $('#sceneCount').onchange = () => (($('#specScenes').textContent = n()), est());
  if ($('#autoTier')) $('#autoTier').onchange = est;
  est();
  if ($('#autoBtn'))
    $('#autoBtn').onclick = (e) => {
      const form = $('#briefForm');
      if (!form.reportValidity()) return;
      const brief = Object.fromEntries(new FormData(form).entries());
      brief.sceneCount = Number(brief.sceneCount);
      brief.duration = Number(brief.duration);
      const tier = $('#autoTier').value;
      if (!confirm(`AI 會自動完成整支 ${brief.duration / 60} 分鐘影片，預估 AI 費用約 NT$${estimateTwd(tier, brief.sceneCount, brief.duration)}。確定開始？`)) return;
      const voice = $('#autoVoice').value;
      const tpl = cfg.templates.find((x) => x.id === brief.template);
      if (tpl?.story && !brandInfo.narratorUrl && !confirm('你選了說書人範本，但還沒設定說書人照片：說書人出鏡的場景會改用 AI 生成的畫面。要繼續嗎？')) return;
      busy(e.currentTarget, '送出中…', async () => {
        if (!project) project = await api('POST', '/api/projects', { brief });
        else project = await api('PUT', `/api/projects/${project.id}/brief`, { brief });
        project = await api('POST', `/api/projects/${project.id}/auto`, { tier, voice, bgm: $('#autoBgm').value || null });
        go('video');
      });
    };
  $('#toScript').onclick = (e) => {
    const form = $('#briefForm');
    if (!form.reportValidity()) return;
    const brief = Object.fromEntries(new FormData(form).entries());
    brief.sceneCount = Number(brief.sceneCount);
    brief.duration = Number(brief.duration);
    busy(e.currentTarget, 'AI 撰寫文案中…', async () => {
      if (!project) project = await api('POST', '/api/projects', { brief });
      else project = await api('PUT', `/api/projects/${project.id}/brief`, { brief });
      project = await api('POST', `/api/projects/${project.id}/script`, {});
      go('script');
    });
  };
}

/* ---------- 步驟 2：文案 ---------- */
function viewScript() {
  if (!project.script) return go('brief');
  const s = project.script;
  const locked = Boolean(project.versions.length);
  const fmt = (i) => {
    const per = tgt() / s.scenes.length;
    const t = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
    return `${t(i * per)}–${t((i + 1) * per)}`;
  };
  const chars = s.scenes.reduce((a, x) => a + [...x.narration].length, 0);
  app.innerHTML = `
  <div class="row between" style="margin-bottom:20px;align-items:flex-end">
    <div>
      <p class="eyebrow">步驟 2 / 4</p>
      <h1>AI 文案與分鏡腳本</h1>
      <p class="lead">每場可以按 🎙 由說書人親自錄音（或 ⬆ 上傳音檔），就會用真人聲音取代 AI 配音，請照著旁白唸。「重點大字」會在每個場景開頭以大字出現在畫面上方，留白就不顯示。共 ${s.scenes.length} 個場景、<span id="chars">${chars}</span> 字旁白（建議 ≤ ${tgt() * 4} 字才會剛好 ${tgt() / 60} 分鐘）。直接點文字即可修改，離開欄位自動儲存。</p>
      <p class="small error" id="tooLong" style="margin:6px 0 0" ${chars > tgt() * 4.4 ? '' : 'hidden'}>旁白偏長，影片會超過 ${tgt() / 60} 分鐘或語速變快，建議精簡。</p>
    </div>
    <div class="row">
      <label class="small" for="sp2" style="font-weight:500">旁白語速</label>${speedSlider('sp2', project.settings.speed, locked)}
      <button class="btn" id="regen" ${locked ? 'disabled' : ''}>重新產生全部</button>
      <a class="btn primary" href="#/p/${project.id}/assets">確認文案，下一步 →</a>
    </div>
  </div>
  <div class="layout">
    <section class="main">
      <div class="tablebox">
        <table>
          <thead><tr><th scope="col" style="width:40px"><span class="sr">選</span></th><th scope="col">場景</th><th scope="col">時間</th><th scope="col" style="width:150px">重點大字</th><th scope="col">旁白／字幕</th><th scope="col" style="width:200px">畫面建議</th><th scope="col" style="width:150px">試聽／說書人錄音</th></tr></thead>
          <tbody>${s.scenes
            .map(
              (x, i) => `<tr>
              <td><input type="checkbox" class="pick" value="${i}" aria-label="選取場景 ${i + 1}" style="width:18px;height:18px" ${locked ? 'disabled' : ''}></td>
              <td class="sec">${String(i + 1).padStart(2, '0')} ${esc(x.section)}</td>
              <td class="num muted">${fmt(i)}</td>
              <td><input type="text" class="hl" data-i="${i}" maxlength="12" value="${esc(x.headline || '')}" placeholder="（不顯示）" aria-label="場景 ${i + 1} 重點大字" ${locked ? 'readonly' : ''}></td>
              <td><textarea class="narr" data-i="${i}" aria-label="場景 ${i + 1} 旁白" ${locked ? 'readonly' : ''}>${esc(x.narration)}</textarea></td>
              <td class="muted small">${esc(x.visual)}</td>
              <td><div class="row" style="gap:6px;flex-wrap:nowrap">
                <button type="button" class="btn" data-listen="${i}" aria-label="試聽場景 ${i + 1} 旁白" style="min-height:40px;padding:0 12px">▶</button>
                ${locked ? '' : `<button type="button" class="btn" data-rec="${i}" aria-label="錄製場景 ${i + 1} 說書人聲音" style="min-height:40px;padding:0 12px">🎙</button>
                <label class="btn" style="min-height:40px;padding:0 10px;cursor:pointer" aria-label="上傳場景 ${i + 1} 音檔">⬆<input type="file" accept="audio/*" data-upv="${i}" class="sr"></label>`}
              </div>
              ${project.scenes[i]?.voiceAssetId ? `<div class="small" style="margin-top:6px;color:var(--accent-ink)">🎙 用說書人錄音 ${locked ? '' : `<button type="button" class="linkbtn" data-delv="${i}">改回 AI</button>`}</div>` : ''}</td></tr>`
            )
            .join('')}</tbody>
        </table>
      </div>
    </section>
    <aside class="side">
      <fieldset class="card" style="margin:0">
        <legend class="label" style="font-size:17px;font-weight:700">影片標題（選一個）</legend>
        ${s.titles.map((t) => `<label class="option"><input type="radio" name="title" value="${esc(t)}" ${s.title === t ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${esc(t)}</span></label>`).join('')}
      </fieldset>
      <div class="card">
        <h2>貼文說明＋Hashtag</h2>
        <p class="muted" style="margin:0">${esc(s.caption)}</p>
        <p class="small" style="margin:0">${s.hashtags.map((h) => `#${esc(h)}`).join(' ')}</p>
        <button class="btn" id="copyCaption">複製貼文</button>
      </div>
      <div class="card">
        <label for="ask" style="font-size:17px;font-weight:700">用一句話叫 AI 改</label>
        <textarea id="ask" rows="3" placeholder="例：開場更有梗、第 3 段加入價格" ${locked ? 'disabled' : ''}></textarea>
        <p class="small muted" style="margin:0">有勾選場景就只改勾選的，沒勾就全部一起調整。</p>
        <button class="btn dark" id="askBtn" ${locked ? 'disabled' : ''}>送出調整（不計次）</button>
      </div>
    </aside>
  </div>`;

  $$('.narr').forEach((ta) => {
    ta.onchange = async () => {
      try {
        project = await api('PATCH', `/api/projects/${project.id}/script`, { scenes: [{ index: Number(ta.dataset.i), narration: ta.value }] });
        const c = project.script.scenes.reduce((a, x) => a + [...x.narration].length, 0);
        $('#chars').textContent = c;
        $('#tooLong').hidden = c <= tgt() * 4.4;
        toast('已儲存');
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
  bindSpeed('sp2', (v) =>
    api('PUT', `/api/projects/${project.id}/scenes`, { settings: { speed: v } })
      .then((p) => ((project = p), toast(`語速 ${v.toFixed(2)} 倍，按 ▶ 試聽`)))
      .catch((e) => toast(e.message, true))
  );
  $$('.hl').forEach((inp) => {
    inp.onchange = () =>
      api('PATCH', `/api/projects/${project.id}/script`, { scenes: [{ index: Number(inp.dataset.i), headline: inp.value }] })
        .then((p) => ((project = p), toast('已儲存')))
        .catch((e) => toast(e.message, true));
  });
  const afterVoice = (p) => {
    project = p;
    viewScript();
    toast('已套用說書人錄音，按 ▶ 試聽');
  };
  $$('[data-rec]').forEach((b) => (b.onclick = () =>
    toggleRecord(b, (blob, name) => uploadVoice(Number(b.dataset.rec), blob, name).then(afterVoice).catch((e) => toast(e.message, true)))));
  $$('[data-upv]').forEach((inp) => (inp.onchange = () => {
    const f = inp.files[0];
    if (f) uploadVoice(Number(inp.dataset.upv), f, f.name).then(afterVoice).catch((e) => toast(e.message, true));
  }));
  $$('[data-delv]').forEach((b) => (b.onclick = () =>
    api('DELETE', `/api/projects/${project.id}/scenes/${b.dataset.delv}/voice`).then((p) => ((project = p), viewScript())).catch((e) => toast(e.message, true))));
  $$('[data-listen]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.listen);
    listen(b, i, { text: $(`.narr[data-i="${i}"]`).value });
  }));
  $$('input[name=title]').forEach((r) => (r.onchange = () => api('PATCH', `/api/projects/${project.id}/script`, { title: r.value }).then((p) => (project = p)).catch((e) => toast(e.message, true))));
  $('#copyCaption').onclick = () => navigator.clipboard.writeText(`${s.caption}\n${s.hashtags.map((h) => '#' + h).join(' ')}`).then(() => toast('已複製'));
  $('#regen').onclick = (e) =>
    confirm('會覆蓋目前所有文案，確定重新產生？') &&
    busy(e.currentTarget, '產生中…', async () => {
      project = await api('POST', `/api/projects/${project.id}/script`, {});
      viewScript();
    });
  $('#askBtn').onclick = (e) => {
    const instruction = $('#ask').value.trim();
    if (!instruction) return toast('請輸入要怎麼改', true);
    const indexes = $$('.pick:checked').map((c) => Number(c.value));
    busy(e.currentTarget, 'AI 改寫中…', async () => {
      project = await api('PATCH', `/api/projects/${project.id}/script`, { instruction, indexes });
      viewScript();
      toast('已依指示調整');
    });
  };
}

/* ---------- 步驟 3：素材與分鏡 ---------- */
function viewAssets() {
  if (!project.script) return go('brief');
  const locked = Boolean(project.versions.length);
  const images = project.assets.filter((a) => a.mime.startsWith('image/'));
  const audios = project.assets.filter((a) => a.mime.startsWith('audio/') && !a.voice);
  const url = (a) => `/api/projects/${project.id}/assets/${a.file}`;
  const cap = aiCount(project.settings.tier, project.scenes.length);
  const aiNow = project.scenes.filter((s) => s.motion === 'ai').length;
  const tiers = Object.entries(cfg.tiers);
  const tierDesc = { economy: '720p 輸出放大，其餘鏡頭推移', standard: '約一半場景 AI 動態', premium: '全片 AI 動態' };

  app.innerHTML = `
  <div class="layout">
    <section class="main">
      <div>
        <p class="eyebrow">步驟 3 / 4</p>
        <h1>上傳圖片素材，對應到分鏡</h1>
        <p class="lead">建議 8–18 張，直式最好。系統會自動配對，你可以逐一調整。</p>
      </div>
      <label class="drop" id="drop" for="upload" ${locked ? 'hidden' : ''}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2F55E4" stroke-width="2" aria-hidden="true"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
        <strong>拖曳圖片到這裡，或點擊選擇檔案</strong>
        <span class="small muted">JPG／PNG／WebP，單張 20MB 內 · 也可上傳 MP3 作為背景音樂</span>
        <input id="upload" type="file" multiple accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,audio/mp4">
      </label>
      ${project.assets.some((x) => !x.voice) ? `<div class="card"><h2>已上傳（${project.assets.filter((x) => !x.voice).length}）</h2><div class="assets">${project.assets
        .filter((x) => !x.voice)
        .map((a) => `<div class="asset">${a.mime.startsWith('image/') ? `<img src="${url(a)}" alt="${esc(a.originalName)}" loading="lazy">` : `<div class="audio">♪ ${esc(a.originalName)}</div>`}${locked ? '' : `<button type="button" data-del="${a.id}" aria-label="刪除 ${esc(a.originalName)}">×</button>`}</div>`)
        .join('')}</div></div>` : ''}
      ${locked ? '' : `<div class="card"><div class="row between"><div><h2>素材不夠？</h2><p class="small muted" style="margin:4px 0 0">AI 依每場的畫面建議生成 9:16 寫實照片，每張約 NT$1。</p></div>
        <div class="row"><button type="button" class="btn" id="aiFill">✨ AI 補齊缺的圖</button><button type="button" class="btn" id="aiAll">全部用 AI 生圖</button></div></div></div>`}
      <div class="card">
        <div class="row between"><h2>分鏡對應（${project.scenes.length} 個場景）</h2><span class="small muted">AI 動態 <strong id="aiCount">${aiNow}</strong> / 上限 ${cap}</span></div>
        <div class="scenes">${project.scenes
          .map((s, i) => {
            const a = project.assets.find((x) => x.id === s.assetId);
            return `<div class="scene">
              ${s.narrator && brandInfo.narratorUrl ? `<img src="${brandInfo.narratorUrl}" alt="說書人出鏡">` : a ? `<img src="${url(a)}" alt="場景 ${i + 1} 素材">` : `<div class="ph">${s.motion === 'ai' ? 'AI 直接生成真人畫面' : '待指定'}</div>`}
              ${locked ? '' : `<button type="button" class="btn" data-aiimg="${i}" style="min-height:36px;font-size:13px">✨ AI 生圖</button>`}
              <strong class="small">${String(i + 1).padStart(2, '0')} ${esc(project.script.scenes[i].section)}</strong>
              <label class="small muted" for="sa${i}">素材</label>
              <select id="sa${i}" data-scene="${i}" class="sceneAsset" ${locked ? 'disabled' : ''}>
                <option value="">（未指定）</option>
                ${images.map((im, k) => `<option value="${im.id}" ${im.id === s.assetId ? 'selected' : ''}>第 ${k + 1} 張 ${esc(im.originalName.slice(0, 14))}</option>`).join('')}
              </select>
              <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-narr="${i}" ${s.narrator ? 'checked' : ''} ${locked ? 'disabled' : ''}> 說書人出鏡${s.narrator && !brandInfo.narratorUrl ? '（請先到品牌設定上傳照片）' : ''}</label>
              <div class="seg" role="group" aria-label="場景 ${i + 1} 動態方式">
                <button type="button" data-scene="${i}" data-motion="ai" aria-pressed="${s.motion === 'ai'}" ${locked ? 'disabled' : ''}>AI 動態</button>
                <button type="button" data-scene="${i}" data-motion="kenburns" aria-pressed="${s.motion !== 'ai'}" ${locked ? 'disabled' : ''}>鏡頭推移</button>
              </div>
            </div>`;
          })
          .join('')}</div>
        <p class="small muted" style="margin:0">「AI 動態」讓畫面裡的人和物真的動起來（約 NT$3／秒）；沒有圖片的 AI 場景會依文案直接生成真人實拍感畫面。「鏡頭推移」只有推近／平移，免費。</p>
      </div>
    </section>
    <aside class="side">
      <fieldset class="card" style="margin:0">
        <legend class="label" style="font-size:17px;font-weight:700">畫面品質方案</legend>
        ${tiers
          .map(([k, t]) => `<label class="option"><input type="radio" name="tier" value="${k}" ${project.settings.tier === k ? 'checked' : ''} ${locked ? 'disabled' : ''}><span><strong>${esc(t.label)}</strong><br><span class="small muted">AI 動態 ${aiCount(k, project.scenes.length)}/${project.scenes.length} 場 · 約 NT$${estimateTwd(k, project.scenes.length)} · ${tierDesc[k] || ''}</span></span></label>`)
          .join('')}
      </fieldset>
      <div class="card">
        <div class="grid2">
          <div class="field"><label for="voice">配音聲線</label><select id="voice" ${locked ? 'disabled' : ''}>${voiceOptions(project.settings.voice)}</select></div>
          <div class="field"><label for="speed">語速</label>${speedSlider('speed', project.settings.speed, locked)}</div>
          <div class="field"><label class="label" for="listen1">試聽旁白</label><button type="button" class="btn" id="listen1">▶ 試聽</button></div>
          <div class="field"><label for="subtitle">字幕樣式</label><select id="subtitle" ${locked ? 'disabled' : ''}>${Object.entries(cfg.subtitleStyles).map(([k, v]) => `<option value="${k}" ${project.settings.subtitle === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          <div class="field"><label for="transition">場景轉場</label><select id="transition" ${locked ? 'disabled' : ''}>${Object.entries(cfg.transitions).map(([k, v]) => `<option value="${k}" ${(project.settings.transition || 'fade') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          <label class="check" style="align-self:end"><input type="checkbox" id="headlines" ${project.settings.headlines !== false ? 'checked' : ''} ${locked ? 'disabled' : ''}> 顯示重點大字</label>
        </div>
        <div class="field"><label for="bgm">背景音樂</label>
          <div class="row" style="flex-wrap:nowrap"><select id="bgm" ${locked ? 'disabled' : ''}>${bgmOptions(project.settings.bgmAssetId, audios)}</select>
          <button type="button" class="btn" id="bgmPlay" aria-label="試聽背景音樂" style="min-width:76px">▶ 試聽</button></div>
          <span class="small muted">內建 5 首可免費使用；也可上傳自己有授權的 MP3。旁白出現時音樂會自動變小聲。</span></div>
      </div>
      <div class="card small"><span>Logo、片頭片尾、品牌色在 <a href="#/brand">品牌設定</a> 設定一次就好。</span></div>
      <div class="card dark">
        <div class="row between small muted"><span>預計產生時間</span><span>約 5–15 分鐘</span></div>
        <div class="row between small muted"><span>包含</span><span>初版＋${cfg.maxRevisions} 次修改</span></div>
        ${locked ? `<a class="btn primary block" href="#/p/${project.id}/video">前往預覽 →</a>` : `<button class="btn primary block" id="renderBtn">產生影片 →</button>`}
      </div>
    </aside>
  </div>`;

  const input = $('#upload');
  const drop = $('#drop');
  const doUpload = (files) => {
    if (!files.length) return;
    const fd = new FormData();
    [...files].forEach((f) => fd.append('files', f));
    toast(`上傳 ${files.length} 個檔案中…`);
    api('POST', `/api/projects/${project.id}/assets`, fd, true)
      .then((p) => {
        project = p;
        viewAssets();
        toast('上傳完成，已自動配對到場景');
      })
      .catch((e) => toast(e.message, true));
  };
  if (input) input.onchange = () => doUpload(input.files);
  if (drop) {
    drop.ondragover = (e) => (e.preventDefault(), drop.classList.add('over'));
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => (e.preventDefault(), drop.classList.remove('over'), doUpload(e.dataTransfer.files));
  }
  $$('[data-del]').forEach((b) => (b.onclick = () => api('DELETE', `/api/projects/${project.id}/assets/${b.dataset.del}`).then((p) => ((project = p), viewAssets())).catch((e) => toast(e.message, true))));

  const save = (body) =>
    api('PUT', `/api/projects/${project.id}/scenes`, body)
      .then((p) => {
        project = p;
        viewAssets();
      })
      .catch((e) => toast(e.message, true));
  const scenesBody = () => ({ scenes: project.scenes.map((s) => ({ assetId: s.assetId, motion: s.motion, narrator: Boolean(s.narrator) })) });
  $$('[data-narr]').forEach((c) => (c.onchange = () => {
    project.scenes[c.dataset.narr].narrator = c.checked;
    save(scenesBody());
  }));

  $$('[data-aiimg]').forEach((b) => (b.onclick = () =>
    busy(b, '生成中…', async () => {
      project = await api('POST', `/api/projects/${project.id}/scenes/${b.dataset.aiimg}/ai-image`, {});
      viewAssets();
      toast('已生成並套用到這個場景');
    })));
  if ($('#aiFill')) $('#aiFill').onclick = (e) => busy(e.currentTarget, 'AI 生圖中，約 1 分鐘…', async () => {
    project = await api('POST', `/api/projects/${project.id}/ai-fill`, {});
    viewAssets();
    toast('已補齊');
  });
  if ($('#aiAll')) $('#aiAll').onclick = (e) => confirm(`會為 ${project.scenes.length} 個場景各生成一張圖（約 NT$${Math.ceil(project.scenes.length * 1.1)}），確定？`) &&
    busy(e.currentTarget, 'AI 生圖中，約 1–2 分鐘…', async () => {
      project = await api('POST', `/api/projects/${project.id}/ai-fill`, { all: true });
      viewAssets();
      toast('已全部生成');
    });
  $$('.sceneAsset').forEach((sel) => (sel.onchange = () => {
    project.scenes[sel.dataset.scene].assetId = sel.value || null;
    save(scenesBody());
  }));
  $$('[data-motion]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.scene);
    if (b.dataset.motion === 'ai' && project.scenes[i].motion !== 'ai' && project.scenes.filter((s) => s.motion === 'ai').length >= cap) {
      return toast(`此方案最多 ${cap} 個 AI 動態場景，請先把其他場景改成鏡頭推移，或升級方案`, true);
    }
    project.scenes[i].motion = b.dataset.motion;
    save(scenesBody());
  }));
  $$('input[name=tier]').forEach((r) => (r.onchange = () => save({ settings: { tier: r.value } })));
  if ($('#transition')) $('#transition').onchange = (e) => save({ settings: { transition: e.target.value } });
  if ($('#headlines')) $('#headlines').onchange = (e) => save({ settings: { headlines: e.target.checked } });
  bindSpeed('speed', (v) => save({ settings: { speed: v } }));
  if ($('#listen1')) $('#listen1').onclick = (e) => listen(e.currentTarget, 0);
  ['voice', 'subtitle'].forEach((k) => $('#' + k) && ($('#' + k).onchange = (e) => save({ settings: { [k]: e.target.value } })));
  if ($('#bgm')) $('#bgm').onchange = (e) => save({ settings: { bgmAssetId: e.target.value || null } });
  if ($('#bgmPlay')) $('#bgmPlay').onclick = () => (previewAudio ? previewBgm(null) : previewBgm($('#bgm').value));
  if ($('#renderBtn'))
    $('#renderBtn').onclick = (e) =>
      busy(e.currentTarget, '送出中…', async () => {
        project = await api('POST', `/api/projects/${project.id}/render`);
        go('video');
      });
}

/* ---------- 步驟 4：預覽與修改 ---------- */
function viewVideo() {
  const p = project;
  const running = p.job && ['queued', 'running'].includes(p.job.status);
  // 一鍵成片剛開始、文案還沒好：只顯示進度
  if (!p.script) {
    app.innerHTML = `<div class="layout"><section style="flex:0 1 380px;display:flex;flex-direction:column;align-items:center;gap:14px">
      <div class="player"><div style="padding:24px">${running ? `<span class="spinner" aria-hidden="true"></span><p style="margin:12px 0 0">${esc(p.job.step || '處理中')}</p><div class="progress"><div style="width:${p.job.progress || 0}%"></div></div><p class="small" style="margin:8px 0 0">可以先離開，稍後回來看</p>` : `<p style="color:#ffb4ab">${esc(p.job?.error || '還沒有影片')}</p><a class="btn primary" href="#/p/${p.id}/brief">回需求頁</a>`}</div></div></section>
      <section class="main"><p class="eyebrow">AI 一鍵成片</p><h1>正在幫你做影片</h1><p class="lead">AI 依序完成：寫文案 → 生成場景圖片 → 配音 → 讓畫面動起來 → 字幕、音樂、合成。完成後這頁會自動出現影片。</p></section></div>`;
    if (running) startPoll();
    return;
  }
  const latest = p.versions.at(-1);
  const left = p.revisionsLeft;
  const n = p.script.scenes.length;
  const images = p.assets.filter((a) => a.mime.startsWith('image/'));
  const audios = p.assets.filter((a) => a.mime.startsWith('audio/') && !a.voice);
  const vurl = (v, dl) => `/api/projects/${p.id}/versions/${v.file}${dl ? '?download=1' : ''}`;
  const sel = [...revise.scenes].sort((a, b) => a - b);

  let playerInner;
  if (running) {
    playerInner = `<div><span class="spinner" aria-hidden="true"></span><p style="margin:12px 0 0">${esc(p.job.step || '處理中')}</p><div class="progress" aria-label="進度"><div style="width:${p.job.progress || 0}%"></div></div><p class="small" style="margin:8px 0 0">${p.job.progress || 0}% · 可以先離開，稍後回來看</p></div>`;
  } else if (latest) {
    playerInner = `<video src="${vurl(latest)}" controls playsinline preload="metadata"></video>`;
  } else if (p.job?.status === 'error') {
    playerInner = `<div style="padding:24px"><p class="error" style="color:#ffb4ab">產生失敗：${esc(p.job.error)}</p>${p.script ? '<button class="btn primary" id="retryBtn">重新產生（不扣次數）</button>' : `<a class="btn primary" href="#/p/${p.id}/brief">回需求頁重試</a>`}</div>`;
  } else {
    playerInner = `<div><p>還沒有影片</p><a class="btn primary" href="#/p/${p.id}/assets">回到素材頁產生</a></div>`;
  }

  const typeLabels = [
    ['visual', '換畫面／動態'],
    ['narration', '改旁白文字'],
    ['voice', '換聲線／語速'],
    ['subtitle', '字幕／轉場／大字'],
    ['bgm', '背景音樂']
  ];
  const t = revise.types;
  const disabled = running || !latest;

  app.innerHTML = `
  <div class="layout">
    <section style="flex:0 1 380px;min-width:0;display:flex;flex-direction:column;gap:14px;align-items:center">
      <div class="player">${playerInner}</div>
      ${latest?.timeline ? `<div class="nowplaying" id="nowPlaying" aria-live="polite">
        <span class="small muted">正在播放</span>
        <strong id="npTitle">場景 01｜${esc(p.script.scenes[0].section)}</strong>
        <span class="small muted num" id="npTime"></span>
        <p class="small" id="npText" style="margin:0">${esc(p.script.scenes[0].narration)}</p>
      </div>` : ''}
      ${latest ? `<div class="row" style="justify-content:center">
        <span class="small muted">v${latest.n} · ${latest.seconds} 秒</span>
        <a class="btn dark" href="${vurl(latest, true)}">下載 MP4（1080×1920）</a>
      </div>
      ${latest.cover ? `<div class="card" style="width:100%;max-width:360px;padding:14px;gap:10px">
        <div class="row between"><strong>封面圖</strong><a class="small" href="${vurl({ file: latest.cover }, true)}">下載</a></div>
        <img src="${vurl({ file: latest.cover })}?t=${encodeURIComponent(latest.coverAt || latest.createdAt)}" alt="影片封面" style="width:100%;border-radius:10px;aspect-ratio:9/16;object-fit:cover">
        <label class="small" for="coverTitle">封面標題</label>
        <input id="coverTitle" type="text" maxlength="40" value="${esc(p.script.title || '')}">
        <button type="button" class="btn" id="coverBtn">用目前畫面重做封面（免費）</button>
      </div>` : ''}` : ''}
      ${p.job?.status === 'error' && latest ? `<p class="error small">上次修改失敗：${esc(p.job.error)}（次數已退回）</p>` : ''}
    </section>
    <section class="main">
      <div class="row between" style="align-items:flex-end">
        <div><p class="eyebrow">步驟 4 / 4</p><h1>預覽影片，提出修改</h1></div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <span class="small muted">剩餘修改次數</span>
          <div class="dots" aria-label="剩餘 ${left} 次，共 ${cfg.maxRevisions} 次">
            ${Array.from({ length: cfg.maxRevisions }, (_, i) => `<span class="${i >= cfg.maxRevisions - left ? 'on' : ''}" aria-hidden="true"></span>`).join('')}
            <strong class="num" style="font-size:26px;margin-left:6px">${left} / ${cfg.maxRevisions}</strong>
          </div>
        </div>
      </div>

      <div class="card" id="globalCard">
        <h2>✨ 一句話改全片</h2>
        <p class="small muted" style="margin:0">例如「開場更有梗、節奏快一點、結尾加上限時優惠、音樂換成激昂的」。AI 先列出打算怎麼改，你確認後才會扣次數。</p>
        <textarea id="globalAsk" rows="2" placeholder="用一句話描述你想怎麼改" ${disabled || left <= 0 ? 'disabled' : ''}></textarea>
        <div id="planBox"></div>
        <button type="button" class="btn dark" id="planBtn" ${disabled || left <= 0 ? 'disabled' : ''}>讓 AI 規劃（不扣次數）</button>
      </div>

      <div class="card">
        <h2>或者：自己挑場景修改 · 點選要修改的場景（最多 ${cfg.maxScenesPerRevision} 個）</h2>
        <div class="timeline">${Array.from({ length: n }, (_, i) => `<button type="button" data-tl="${i}" aria-pressed="${revise.scenes.has(i)}" title="${esc(p.script.scenes[i].narration)}" ${disabled || revise.full ? 'disabled' : ''}>${String(i + 1).padStart(2, '0')}</button>`).join('')}</div>
      </div>

      <div class="card">
        <fieldset style="border:0;margin:0;padding:0">
          <legend class="label" style="font-size:15px;font-weight:700;margin-bottom:12px">要改什麼？</legend>
          <div class="checks">
            ${typeLabels.map(([k, l]) => `<label class="check"><input type="checkbox" data-type="${k}" ${t.has(k) ? 'checked' : ''} ${disabled || revise.full ? 'disabled' : ''}> ${l}</label>`).join('')}
            <label class="check"><input type="checkbox" id="fullRedo" ${revise.full ? 'checked' : ''} ${disabled || left < cfg.fullRedoCost ? 'disabled' : ''}> 全片重做（扣 ${cfg.fullRedoCost} 次）</label>
          </div>
        </fieldset>

        ${!revise.full && sel.length && (t.has('visual') || t.has('narration')) ? `<div style="display:flex;flex-direction:column;gap:12px">${sel
          .map((i) => `<div class="card" style="padding:14px;gap:10px">
            <strong class="small">場景 ${String(i + 1).padStart(2, '0')} ${esc(p.script.scenes[i].section)}</strong>
            ${t.has('narration') ? `<div class="field"><label class="small" for="eh${i}">重點大字</label><input type="text" id="eh${i}" data-edit-hl="${i}" maxlength="12" value="${esc(p.script.scenes[i].headline || '')}"></div>
            <div class="field"><label class="small" for="en${i}">新旁白（留白＝依修改說明由 AI 改寫）</label><textarea id="en${i}" data-edit-narr="${i}" rows="2" placeholder="${esc(p.script.scenes[i].narration)}"></textarea></div>
            <div class="row small" style="gap:8px">說書人聲音：
              <button type="button" class="btn" data-rrec="${i}" style="min-height:36px">🎙</button>
              <label class="btn" style="min-height:36px;cursor:pointer">⬆ 上傳<input type="file" accept="audio/*" data-rupv="${i}" class="sr"></label>
              <span>${revise.voice?.[i] ? '✓ 已錄新的聲音' : p.scenes[i].voiceAssetId ? '目前用錄音' : '目前用 AI 配音'}</span>
              ${p.scenes[i].voiceAssetId ? `<label><input type="checkbox" data-rai="${i}"> 改回 AI 配音</label>` : ''}
            </div>` : ''}
            ${t.has('visual') ? `<div class="grid2">
              <div class="field"><label class="small" for="ea${i}">換素材</label><select id="ea${i}" data-edit-asset="${i}"><option value="">維持原素材</option><option value="__ai__">✨ AI 新生成一張（約 NT$1）</option>${images.map((im, k) => `<option value="${im.id}">第 ${k + 1} 張 ${esc(im.originalName.slice(0, 14))}</option>`).join('')}</select></div>
              <div class="field"><label class="small" for="em${i}">動態方式</label><select id="em${i}" data-edit-motion="${i}"><option value="">維持（${p.scenes[i].motion === 'ai' ? 'AI 動態' : '鏡頭推移'}）</option><option value="ai">AI 動態</option><option value="kenburns">鏡頭推移</option></select></div>
            </div>` : ''}
          </div>`)
          .join('')}</div>` : ''}

        ${!revise.full && (t.has('voice') || t.has('subtitle') || t.has('bgm')) ? `<div class="grid3">
          ${t.has('voice') ? `<div class="field"><label for="rv">聲線</label><select id="rv">${voiceOptions(p.settings.voice)}</select></div>
          <div class="field"><label for="rsp">語速</label>${speedSlider('rsp', p.settings.speed)}<button type="button" class="btn" id="rvListen" style="margin-top:6px">▶ 試聽</button></div>` : ''}
          ${t.has('subtitle') ? `<div class="field"><label for="rs">字幕</label><select id="rs">${Object.entries(cfg.subtitleStyles).map(([k, v]) => `<option value="${k}" ${p.settings.subtitle === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          <div class="field"><label for="rt">轉場</label><select id="rt">${Object.entries(cfg.transitions).map(([k, v]) => `<option value="${k}" ${(p.settings.transition || 'fade') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          <label class="small" style="margin-top:6px"><input type="checkbox" id="rh" ${p.settings.headlines !== false ? 'checked' : ''}> 顯示重點大字</label></div>` : ''}
          ${t.has('bgm') ? `<div class="field"><label for="rb">背景音樂</label><select id="rb">${bgmOptions(p.settings.bgmAssetId, audios)}</select><button type="button" class="btn" id="rbPlay" style="margin-top:6px">▶ 試聽</button></div>` : ''}
        </div>` : ''}

        <div class="field"><label for="note" style="font-weight:700">修改說明</label>
          <textarea id="note" rows="3" placeholder="例：場景 03 產品要更大、07 節奏加快、開場旁白更有梗" ${disabled ? 'disabled' : ''}></textarea></div>
        <div class="row between">
          <span class="small muted" id="summary"></span>
          <button class="btn primary" id="sendRevise" ${disabled || left <= 0 ? 'disabled' : ''}>送出修改（用掉 ${revise.full ? cfg.fullRedoCost : 1} 次）</button>
        </div>
        ${left <= 0 ? '<p class="small error" style="margin:0">這支影片的修改次數已用完。</p>' : ''}
      </div>

      ${p.versions.length ? `<div class="card"><h2>版本紀錄</h2><ul class="history">${[...p.versions]
        .reverse()
        .map((v) => `<li><span><strong>v${v.n}</strong> · ${esc(v.isRevision ? `修改：${v.note}` : '初版')}${Array.isArray(v.regenerated) && v.regenerated.length ? `（重做場景 ${v.regenerated.filter((x) => x !== 'global').map((x) => x + 1).join('、') || '—'}）` : v.regenerated === 'all' ? '（全片）' : ''}</span>${v.tempo && v.speed && v.tempo > v.speed + 0.02 ? `<span class="small muted" style="flex-basis:100%">旁白偏長，為了剛好 ${tgt() / 60} 分鐘已自動加快到 ${v.tempo} 倍；想慢一點請精簡旁白。</span>` : ''}${v.blockedScenes?.length ? `<span class="small error" style="flex-basis:100%">場景 ${v.blockedScenes.join('、')} 的 AI 動態被 Google 安全過濾，已改用鏡頭推移。可換一張圖（避免真人臉部、商標、文字）再修改。</span>` : ''}${v.quotaScenes?.length ? `<span class="small error" style="flex-basis:100%">今天的 AI 影片額度用完，場景 ${v.quotaScenes.join('、')} 先用鏡頭推移。額度約台灣時間下午 4 點重置，之後用「修改」勾選這些場景即可改回 AI 動態。</span>` : ''}<span class="row"><a href="${vurl(v)}" target="_blank" rel="noopener">播放</a><a href="${vurl(v, true)}">下載</a><span class="muted small">${new Date(v.createdAt).toLocaleString('zh-TW')}</span></span></li>`)
        .join('')}</ul>
        <p class="small muted" style="margin:0">本專案 AI 影片成本累計約 NT$${p.cost.twd}（US$${p.cost.usd}）</p></div>` : ''}
    </section>
  </div>`;

  const summary = () => {
    const el = $('#summary');
    if (!el) return;
    if (revise.full) el.textContent = '全部場景重新產生畫面與配音';
    else if (sel.length) el.textContent = `只重做場景 ${sel.map((i) => i + 1).join('、')}，其餘保留`;
    else el.textContent = t.size ? '只調整整體設定，畫面不重做' : '請選場景與修改項目';
  };
  summary();

  const video = $('.player video');
  const tl = latest?.timeline;
  const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  let lastIdx = -1;
  const showScene = (i) => {
    if (i === lastIdx || !tl) return;
    lastIdx = i;
    $$('[data-tl]').forEach((b) => b.classList.toggle('playing', Number(b.dataset.tl) === i));
    if (!$('#npTitle')) return;
    $('#npTitle').textContent = `場景 ${String(i + 1).padStart(2, '0')}｜${p.script.scenes[i].section}`;
    $('#npTime').textContent = `${fmt(tl[i].start)}–${fmt(tl[i].end)}`;
    $('#npText').textContent = p.script.scenes[i].narration;
  };
  if (video && tl) {
    video.ontimeupdate = () => {
      const t = video.currentTime;
      const i = tl.findIndex((s) => t >= s.start && t < s.end);
      showScene(i < 0 ? tl.length - 1 : i);
    };
    showScene(0);
  }

  $$('[data-tl]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.tl);
    // 點場景：影片跳到那一段開頭
    if (video && tl?.[i]) {
      pendingSeek = tl[i].start + 0.05;
      video.currentTime = pendingSeek;
      showScene(i);
    }
    if (revise.scenes.has(i)) revise.scenes.delete(i);
    else if (revise.scenes.size >= cfg.maxScenesPerRevision) return toast(`每次最多 ${cfg.maxScenesPerRevision} 個場景；大改請用「全片重做」`, true);
    else revise.scenes.add(i);
    keepNote(viewVideo);
  }));
  $$('[data-type]').forEach((c) => (c.onchange = () => {
    c.checked ? revise.types.add(c.dataset.type) : revise.types.delete(c.dataset.type);
    keepNote(viewVideo);
  }));
  if ($('#planBtn'))
    $('#planBtn').onclick = (e) => {
      const instruction = $('#globalAsk').value.trim();
      if (!instruction) return toast('請輸入要怎麼改', true);
      busy(e.currentTarget, 'AI 規劃中…', async () => {
        const { plan } = await api('POST', `/api/projects/${p.id}/revise-plan`, { instruction });
        const scenes = [...new Set([...plan.visuals.map((x) => x.index), ...plan.narration.map((x) => x.index), ...plan.headlines.map((x) => x.index)])].sort((a, b) => a - b);
        $('#planBox').innerHTML = `<div class="card" style="background:#f3f6ff;border-color:#c9d6ff;padding:16px;gap:8px">
          <strong>AI 打算這樣改：</strong>
          <ul style="margin:0;padding-left:20px">${plan.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
          <span class="small muted">影響場景：${scenes.length ? scenes.map((i) => i + 1).join('、') : '只改整體設定'}；重新產生 AI 畫面：${plan.visuals.length} 場</span>
          <div class="row"><button type="button" class="btn primary" id="applyPlan">確定修改（用掉 ${plan.cost} 次）</button><button type="button" class="btn" id="cancelPlan">取消</button></div>
        </div>`;
        $('#cancelPlan').onclick = () => ($('#planBox').innerHTML = '');
        $('#applyPlan').onclick = (ev) =>
          busy(ev.currentTarget, '送出中…', async () => {
            project = await api('POST', `/api/projects/${p.id}/revise`, { planId: plan.id });
            viewVideo();
            startPoll();
            toast('已送出，完成後會自動顯示新版本');
          });
      });
    };
  if ($('#coverBtn'))
    $('#coverBtn').onclick = (e) =>
      busy(e.currentTarget, '產生中…', async () => {
        project = await api('POST', `/api/projects/${p.id}/cover`, { version: latest.n, time: $('.player video')?.currentTime || 1.2, title: $('#coverTitle').value });
        keepNote(viewVideo);
        toast('封面已更新');
      });
  bindSpeed('rsp');
  if ($('#rvListen')) $('#rvListen').onclick = (e) => listen(e.currentTarget, sel[0] ?? 0, { voice: $('#rv').value, speed: Number($('#rsp').value) });
  const gotVoice = (i) => (r) => {
    (revise.voice ||= {})[i] = r.voiceAssetId;
    project = r;
    keepNote(viewVideo);
    toast('新的聲音已準備好，送出修改後套用');
  };
  $$('[data-rrec]').forEach((b) => (b.onclick = () =>
    toggleRecord(b, (blob, name) => uploadVoice(Number(b.dataset.rrec), blob, name).then(gotVoice(b.dataset.rrec)).catch((e) => toast(e.message, true)))));
  $$('[data-rupv]').forEach((inp) => (inp.onchange = () => {
    const f = inp.files[0];
    if (f) uploadVoice(Number(inp.dataset.rupv), f, f.name).then(gotVoice(inp.dataset.rupv)).catch((e) => toast(e.message, true));
  }));
  if ($('#rbPlay')) $('#rbPlay').onclick = () => (previewAudio ? previewBgm(null) : previewBgm($('#rb').value));
  if ($('#fullRedo')) $('#fullRedo').onchange = (e) => ((revise.full = e.target.checked), keepNote(viewVideo));
  if ($('#retryBtn')) $('#retryBtn').onclick = (e) => busy(e.currentTarget, '送出中…', async () => ((project = await api('POST', `/api/projects/${p.id}/retry`, {})), viewVideo(), startPoll()));

  $('#sendRevise').onclick = (e) => {
    const note = $('#note').value.trim();
    const sceneEdits = {};
    $$('[data-edit-narr]').forEach((x) => x.value.trim() && ((sceneEdits[x.dataset.editNarr] ||= {}).narration = x.value.trim()));
    for (const [i, id] of Object.entries(revise.voice || {})) (sceneEdits[i] ||= {}).voiceAssetId = id;
    $$('[data-rai]:checked').forEach((x) => ((sceneEdits[x.dataset.rai] ||= {}).voiceAssetId = null));
    $$('[data-edit-hl]').forEach((x) => x.value !== (p.script.scenes[x.dataset.editHl].headline || '') && ((sceneEdits[x.dataset.editHl] ||= {}).headline = x.value.trim()));
    $$('[data-edit-asset]').forEach((x) => x.value && ((sceneEdits[x.dataset.editAsset] ||= {}).assetId = x.value));
    $$('[data-edit-motion]').forEach((x) => x.value && ((sceneEdits[x.dataset.editMotion] ||= {}).motion = x.value));
    const settings = { voice: $('#rv')?.value, speed: $('#rsp') ? Number($('#rsp').value) : undefined, subtitle: $('#rs')?.value, transition: $('#rt')?.value, headlines: $('#rh') ? $('#rh').checked : undefined, bgmAssetId: $('#rb')?.value || null };
    if (!revise.full && !t.size) return toast('請勾選要修改的項目', true);
    if (t.has('narration') && !note && sel.some((i) => !sceneEdits[i]?.narration && sceneEdits[i]?.headline === undefined && sceneEdits[i]?.voiceAssetId === undefined)) return toast('改旁白請填新旁白、改重點大字，或在修改說明寫要怎麼改', true);
    const cost = revise.full ? cfg.fullRedoCost : 1;
    if (!confirm(`這次修改會用掉 ${cost} 次（剩 ${left} 次），確定送出？`)) return;
    busy(e.currentTarget, '送出中…', async () => {
      project = await api('POST', `/api/projects/${p.id}/revise`, { scenes: sel, types: [...t], note, sceneEdits, settings, full: revise.full });
      revise.scenes.clear();
      revise.types.clear();
      revise.full = false;
      revise.voice = {};
      viewVideo();
      startPoll();
      toast('已送出，完成後會自動顯示新版本');
    });
  };

  if (running) startPoll();
}

let pendingSeek = null;
// 重畫畫面時保留：修改說明文字、影片播放位置與播放狀態
function keepNote(fn) {
  const v = $('#note')?.value;
  const old = $('.player video');
  const time = pendingSeek ?? old?.currentTime;
  const playing = old && !old.paused;
  pendingSeek = null;
  fn();
  if (v && $('#note')) $('#note').value = v;
  const nv = $('.player video');
  if (nv && time) {
    const apply = () => {
      nv.currentTime = time;
      if (playing) nv.play().catch(() => {});
    };
    nv.readyState >= 1 ? apply() : nv.addEventListener('loadedmetadata', apply, { once: true });
  }
}

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const fresh = await api('GET', `/api/projects/${project.id}`);
      const changed = fresh.job?.status !== project.job?.status || fresh.job?.progress !== project.job?.progress || fresh.job?.step !== project.job?.step || fresh.versions.length !== project.versions.length || Boolean(fresh.script) !== Boolean(project.script);
      project = fresh;
      if (!location.hash.endsWith('/video')) return clearInterval(pollTimer);
      if (changed) {
        renderSteps('video');
        keepNote(viewVideo);
      }
      if (!['queued', 'running'].includes(fresh.job?.status)) {
        clearInterval(pollTimer);
        if (fresh.job?.status === 'done') toast(`v${fresh.versions.at(-1).n} 完成！`);
      }
    } catch {}
  }, 3000);
}

/* ---------- 啟動 ---------- */
(async () => {
  cfg = await api('GET', '/api/config');
  await loadBrand();
  try {
    cfg.narrPresets = await api('GET', '/api/narrator/presets');
  } catch {}
  $('#mockBanner').hidden = !cfg.mock;
  window.addEventListener('hashchange', route);
  route();
})();
