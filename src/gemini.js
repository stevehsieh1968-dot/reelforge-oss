// 所有 Google Gemini 呼叫集中在這裡：文案、改寫、配音（TTS）、Veo 圖生影片
import fs from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { config, targetOf } from './config.js';
import { getTemplate } from './templates.js';

let ai = null;
function client() {
  if (!ai) ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return ai;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 / 5xx 自動重試：有「請 N 秒後再試」就照 Google 指定的秒數等
function retryDelayMs(e) {
  const m = String(e?.message || '').match(/retry in ([\d.]+)s|"retryDelay":\s*"([\d.]+)s"/i);
  const s = m ? Number(m[1] || m[2]) : 0;
  return s ? Math.ceil(s * 1000) + 1500 : 0;
}

async function withRetry(fn, label, tries = 5, quotaTries = 12) {
  let lastErr;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message);
      const status = Number(e?.status || e?.code || e?.response?.status || (msg.match(/"code":\s*(\d{3})/) || [])[1]);
      const isQuota = status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg);
      const retryable = isQuota || [500, 502, 503, 504].includes(status) || /UNAVAILABLE|high demand|fetch failed/i.test(msg);
      // 每日額度用完就不用等了
      const daily = /per day|PerDay/i.test(msg);
      // 預付額度用完：等再久也不會好，直接告訴使用者
      const prepay = /prepayment|prepay|spending cap|spend cap/i.test(msg);
      if (prepay) break;
      const maxTries = isQuota ? quotaTries : tries;
      if (!retryable || daily || i >= maxTries - 1) break;
      const wait = retryDelayMs(e) || Math.min(30000, 3000 * 2 ** i) + Math.floor(Math.random() * 1000);
      console.warn(`[gemini] ${label} ${isQuota ? '超過每分鐘額度' : '暫時失敗'}，${Math.round(wait / 1000)} 秒後重試（第 ${i + 1} 次）`);
      await sleep(wait);
    }
  }
  const msg = String(lastErr?.message || lastErr);
  if (isQuotaErr(msg)) {
    console.warn(`[gemini] ${label} Google 原始回覆：${msg.replaceAll(config.geminiApiKey || '\u0000', '***').slice(0, 800)}`);
    const err = new Error(`${label} 失敗：${quotaExplain(msg)}`);
    err.quota = true;
    err.raw = msg;
    throw err;
  }
  throw new Error(`${label} 失敗：${msg.slice(0, 500)}`);
}

const isQuotaErr = (msg) => /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(String(msg));

// 把 Google 的額度錯誤翻成看得懂的說明
function quotaExplain(msg) {
  msg = String(msg);
  const id = (msg.match(/"quotaId":\s*"([^"]+)"/) || [])[1] || '';
  const model = (msg.match(/"model":\s*"([^"]+)"/) || [])[1] || '';
  const which = [model && `模型 ${model}`, id && `額度項目 ${id}`].filter(Boolean).join('，');
  const tail = which ? `（${which}）` : '';
  if (/spending cap|spend cap/i.test(msg)) {
    return `已超過你在 Google 設定的「每月花費上限」，所以 Google 暫停了這個專案（跟餘額多少無關）。請到 https://ai.studio/spend 把每月上限調高（建議至少 NT$1,000），儲存後約 1–2 分鐘生效，再按一次就好。`;
  }
  if (/prepayment|prepay/i.test(msg)) {
    return `Google 回覆「預付額度已用完」。請到 https://aistudio.google.com/billing 確認：①金鑰所屬的專案就是你儲值的那個專案；②餘額足夠（AI 影片 1 分鐘約 US$4＝NT$135，3 分鐘約 US$13＝NT$410）；③可以開啟「自動儲值 auto-reload」。剛儲值的話，有時要等 10–30 分鐘才會同步。`;
  }
  if (/free_tier|FreeTier|Free Tier/i.test(msg)) {
    return `你的 Gemini 金鑰目前是「免費方案」，額度很少${tail}。請到 https://aistudio.google.com/apikey 確認這把金鑰所屬的專案已連結帳單（Tier 1 以上）；剛設定帳單可能要等幾分鐘才生效。`;
  }
  if (/per ?day|PerDay/i.test(msg)) {
    return `今天的使用額度已用完${tail}，台灣時間下午 4 點左右重置；或到 https://aistudio.google.com/usage 查看用量、申請提高額度。`;
  }
  return `超過 Google 的使用額度${tail}。請到 https://aistudio.google.com/usage 查看用量與上限；若一直出現，通常是金鑰所屬的專案沒有連結帳單。`;
}

/* ---------------- 連線診斷 ---------------- */
// 直接用最小的請求測試金鑰，回傳 Google 原本的錯誤（不重試）
export async function diagnose() {
  if (config.mock) return { mock: true, results: [] };
  if (config.textProvider === 'openai') {
    const t0 = Date.now();
    try {
      const r = await openaiText({ contents: '請只回答：好' }, '測試');
      return { key: config.openaiBaseUrl, results: [{ model: config.openaiModel, ok: true, ms: Date.now() - t0, reply: r.text.slice(0, 20) }] };
    } catch (e) {
      return { key: config.openaiBaseUrl, results: [{ model: config.openaiModel, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 1500) }] };
    }
  }
  const key = config.geminiApiKey || '';
  const models = [...new Set([config.textModel, config.textFallbackModel].filter(Boolean))];
  const results = [];
  for (const model of models) {
    const t0 = Date.now();
    try {
      const r = await client().models.generateContent({ model, contents: '請只回答：好' });
      results.push({ model, ok: true, ms: Date.now() - t0, reply: String(r.text || '').slice(0, 20) });
    } catch (e) {
      results.push({ model, ok: false, ms: Date.now() - t0, status: e?.status || e?.code || null, error: String(e?.message || e).replaceAll(key, '***').slice(0, 1500) });
    }
  }
  return { key: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '（沒有設定）', results };
}

/* ---------------- 文案 ---------------- */

const isBusy = (e) => (e?.quota && !/prepay|spend/i.test(e?.raw || '')) || /503|UNAVAILABLE|high demand|overloaded|429|RESOURCE_EXHAUSTED/i.test(String(e?.message));

/* ---------- OpenAI 相容服務（例如本機 Ollama、LM Studio、OpenRouter） ---------- */
// Gemini 的 responseSchema（大寫 type）轉成一般 JSON Schema，寫進提示裡
function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type') out.type = String(v).toLowerCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else if (k === 'items') out.items = toJsonSchema(v);
    else out[k] = v;
  }
  return out;
}
// 從模型回覆裡挖出 JSON（去掉 <think>…</think>、```json 圍欄等）
export function extractJson(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error('文案模型沒有回傳 JSON');
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  return t.slice(start, end + 1);
}
async function openaiText(params, label) {
  const cfg = params.config || {};
  let prompt = typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents);
  if (cfg.responseSchema) {
    prompt +=
      `\n\n只輸出一個 JSON，不要任何說明文字或 Markdown。JSON 必須符合這個 JSON Schema：\n` + JSON.stringify(toJsonSchema(cfg.responseSchema));
  }
  const body = {
    model: config.openaiModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: cfg.temperature ?? 0.7,
    stream: false
  };
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiApiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10 * 60 * 1000)
      });
      if (!r.ok) throw new Error(`${label}失敗（${r.status}）：${(await r.text()).slice(0, 300)}`);
      const json = await r.json();
      const content = json.choices?.[0]?.message?.content || '';
      const text = cfg.responseSchema ? extractJson(content) : content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (cfg.responseSchema) JSON.parse(text); // 確認是合法 JSON，不合法就重試
      return { text };
    } catch (e) {
      lastErr = e;
      if (/ECONNREFUSED|fetch failed/i.test(String(e?.cause?.code || e?.message))) {
        throw new Error(`連不到文案模型服務 ${config.openaiBaseUrl}：如果用 Ollama，請先開啟 Ollama 並執行 ollama pull ${config.openaiModel}`);
      }
      console.warn(`[text] ${label}第 ${i + 1} 次失敗：${e.message}`);
    }
  }
  throw lastErr;
}

// 先用主模型；忙碌或額度不夠就改用備用模型（每個模型的額度是分開算的）
async function generateText(params, label) {
  if (config.textProvider === 'openai') return openaiText(params, label);
  try {
    return await withRetry(() => client().models.generateContent({ model: config.textModel, ...params }), label, 3, 3);
  } catch (e) {
    if (!isBusy(e) || !config.textFallbackModel || config.textFallbackModel === config.textModel) throw e;
    console.warn(`[gemini] ${config.textModel} ${e.quota ? '額度不夠' : '忙碌中'}，改用備用模型 ${config.textFallbackModel}`);
    try {
      return await withRetry(() => client().models.generateContent({ model: config.textFallbackModel, ...params }), label, 3, 6);
    } catch (e2) {
      if (e2.quota) throw e2; // 額度問題：顯示真正原因，不要說「伺服器太忙」
      if (isBusy(e2)) throw new Error('Google 伺服器目前太忙，請 1–2 分鐘後再按一次');
      throw e2;
    }
  }
}

const scriptSchema = {
  type: 'OBJECT',
  properties: {
    titles: { type: 'ARRAY', items: { type: 'STRING' } },
    caption: { type: 'STRING' },
    hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
    scenes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          section: { type: 'STRING' },
          headline: { type: 'STRING' },
          narration: { type: 'STRING' },
          visual: { type: 'STRING' },
          motionPrompt: { type: 'STRING' }
        },
        required: ['section', 'headline', 'narration', 'visual', 'motionPrompt']
      }
    }
  },
  required: ['titles', 'caption', 'hashtags', 'scenes']
};

function briefText(b) {
  return [
    `品牌／產品：${b.brand || ''}`,
    `目標受眾：${b.audience || ''}`,
    `影片目的：${b.purpose || ''}`,
    `核心賣點與必提內容：${b.points || ''}`,
    `語氣風格：${b.tone || ''}`,
    `旁白語言：${b.language || '國語（台灣）'}`,
    `發佈平台：${b.platform || ''}`,
    getTemplate(b.template) ? `影片範本：${getTemplate(b.template).name}` : '',
    b.reference ? `參考：${b.reference}` : ''
  ].join('\n');
}

// 每場旁白字數範圍（依場景數調整；中文旁白約每秒 4 字）
export function charRange(n, target = config.targetSeconds) {
  const per = (target * 4) / n;
  return [Math.round(per * 0.8), Math.round(per * 1.1)];
}

export async function generateScript(brief, extraInstruction = '', sceneCount = config.sceneCount) {
  const n = sceneCount;
  const target = targetOf(brief);
  const chars = Math.round(target * 4);
  const [lo, hi] = charRange(n, target);
  if (config.mock) return mockScript(brief, n);

  const tpl = getTemplate(brief.template);
  const tplText = tpl
    ? `\n請使用「${tpl.name}」範本的結構（共 ${tpl.scenes.length} 段${tpl.scenes.length !== n ? `，請合併或拆分成正好 ${n} 個場景，保持順序與重點` : ''}）：\n` +
      tpl.scenes.map((s, i) => `${i + 1}. ${s.section}：${s.goal}（畫面：${s.visual}）`).join('\n') +
      '\nsection 請使用範本的段落名稱。\n' +
      (tpl.style ? `\n寫作風格：${tpl.style}\n標示「說書人出鏡」的場景，旁白是說書人直接對觀眾說話；其他場景是說書人講述故事，畫面是故事情節。\n` : '') +
      (tpl.scenes.some((s) => s.narrator) ? `說書人出鏡的段落：${tpl.scenes.filter((s) => s.narrator).map((s) => s.section).join('、')}。\n` : '')
    : '';
  const prompt = `你是台灣的短影音行銷編劇。請依下列需求，寫一支 ${target / 60} 分鐘、直式 9:16 的短視頻腳本。

${briefText(brief)}
${tplText}
規則：
- 正好 ${n} 個場景，每個場景約 ${Math.round(target / n)} 秒，旁白每場景 ${lo}–${hi} 字，全片約 ${chars} 字，使用繁體中文與台灣用語。
- 結構：${tpl ? '照上面的範本' : '開場鉤子（第 1 場，3 秒內抓住注意力）→ 痛點 → 解方 → 賣點展開 → 優惠／信任 → 最後 1 場行動呼籲'}。第 1 場要在 3 秒內抓住注意力，最後 1 場是行動呼籲。
- section：該場景段落名稱（例如「開場」「賣點 1」）。
- headline：該場景畫面上方要顯示的「重點大字」，2–8 個字，抓住這段最想讓人記住的一句（例如「每週新鮮烘焙」「限時 8 折」），不要標點。
- visual：用中文描述畫面建議，方便使用者挑選對應圖片。
- motionPrompt：用英文寫給影片模型的「真人實拍」動態描述，重點是畫面裡的人和物「在做什麼動作」：例如人物走路、轉頭微笑、拿起產品使用、手部操作、倒咖啡、互相交談的自然表情，背景也有細微動態；最後才補一句鏡頭運動。不要只寫鏡頭推近或平移，不要要求畫面出現文字。
- titles：3 個標題選項（問句型、數字型、好處型），各 20 字內。
- caption：80 字內的貼文說明。hashtags：5–8 個，不含 # 符號。
- 不得捏造品牌沒提供的數據、價格或認證；資訊不足時用一般性描述。
${extraInstruction ? `\n額外要求：${extraInstruction}` : ''}`;

  const res = await generateText(
    { contents: prompt, config: { responseMimeType: 'application/json', responseSchema: scriptSchema, temperature: 0.9 } },
    '產生文案'
  );
  const data = JSON.parse(res.text);
  data.scenes = normalizeScenes(data.scenes, n);
  return data;
}

// 依一句話指令改寫指定場景的旁白（不改其他場景）
export async function rewriteScenes(brief, scenes, indexes, instruction) {
  if (config.mock) {
    return indexes.map((i) => ({ index: i, narration: `${scenes[i].narration}（已依指示調整）`.slice(0, 60) }));
  }
  const list = indexes.map((i) => `場景 ${i + 1}（${scenes[i].section}）：${scenes[i].narration}`).join('\n');
  const [lo, hi] = charRange(scenes.length, targetOf(brief));
  const context = scenes.map((s, i) => `${i + 1}. ${s.narration}`).join('\n');
  const prompt = `以下是一支短視頻的完整旁白：
${context}

品牌需求：
${briefText(brief)}

請只改寫這些場景的旁白，每場景 ${lo}–${hi} 字，繁體中文，與前後文順暢銜接：
${list}

修改指示：${instruction}`;
  const res = await generateText(
    {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { index: { type: 'INTEGER' }, narration: { type: 'STRING' } },
            required: ['index', 'narration']
          }
        }
      }
    },
    '改寫旁白'
  );
  // 模型回傳 1-based 場景編號
  return JSON.parse(res.text)
    .map((r) => ({ index: r.index - 1, narration: r.narration }))
    .filter((r) => indexes.includes(r.index));
}

/* ---------------- 一句話改全片：AI 規劃要改什麼 ---------------- */
const planSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'ARRAY', items: { type: 'STRING' } },
    narration: { type: 'ARRAY', items: { type: 'OBJECT', properties: { scene: { type: 'INTEGER' }, narration: { type: 'STRING' } }, required: ['scene', 'narration'] } },
    headlines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { scene: { type: 'INTEGER' }, headline: { type: 'STRING' } }, required: ['scene', 'headline'] } },
    visuals: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { scene: { type: 'INTEGER' }, motionPrompt: { type: 'STRING' }, newImage: { type: 'BOOLEAN' } }, required: ['scene', 'motionPrompt'] }
    },
    settings: {
      type: 'OBJECT',
      properties: {
        speed: { type: 'NUMBER' },
        transition: { type: 'STRING' },
        subtitle: { type: 'STRING' },
        music: { type: 'STRING' },
        headlines: { type: 'BOOLEAN' }
      }
    }
  },
  required: ['summary']
};

export async function planRevision({ brief, script, settings, instruction, options }) {
  const n = script.scenes.length;
  const [lo, hi] = charRange(n, targetOf(brief));
  if (config.mock) {
    return {
      summary: ['【模擬】改寫開場與結尾旁白', '語速調快一點', '重做第 1 場畫面'],
      narration: [{ index: 0, narration: `${script.scenes[0].narration}（模擬：更有活力）`.slice(0, 80) }],
      headlines: [{ index: n - 1, headline: '馬上行動' }],
      visuals: [{ index: 0, motionPrompt: script.scenes[0].motionPrompt + ', more energetic', newImage: false }],
      settings: { speed: Math.min(1.5, (Number(settings.speed) || 1) + 0.1) }
    };
  }
  const list = script.scenes
    .map((s, i) => `${i + 1}. [${s.section}] 大字：${s.headline || '（無）'}｜旁白：${s.narration}｜畫面動作：${s.motionPrompt}`)
    .join('\n');
  const prompt = `你是短影音剪輯師。使用者想用一句話修改整支 ${n} 個場景的短視頻，請規劃「最少但有效」的修改。

品牌需求：
${briefText(brief)}

目前設定：語速 ${settings.speed || 1} 倍、轉場 ${settings.transition}、字幕 ${settings.subtitle}、背景音樂 ${settings.bgmAssetId || '無'}、重點大字 ${settings.headlines === false ? '關' : '開'}

目前腳本：
${list}

使用者的修改要求：「${instruction}」

規則：
- 只列出真的需要改的場景；沒提到畫面就不要改 visuals。visuals 會重新產生 AI 影片（花錢），最多 ${options.maxVisual} 個，除非使用者明確要求整支重做。
- narration：改寫後的旁白，每場 ${lo}–${hi} 字，繁體中文，台灣用語，與前後文順暢。
- headlines：2–8 字，不要標點。
- visuals：英文 motionPrompt，強調真人實拍的人物動作；newImage=true 代表原圖不適合、要用 AI 重新生一張圖。
- settings 只填要改的：speed 0.8–1.5；transition 只能是 ${options.transitions}；subtitle 只能是 ${options.subtitles}；music 只能是 ${options.music} 或 none。
- summary：用 2–6 條繁體中文短句，告訴使用者你打算改什麼。
- scene 編號從 1 開始。`;
  const res = await generateText({ contents: prompt, config: { responseMimeType: 'application/json', responseSchema: planSchema } }, '規劃修改');
  const raw = JSON.parse(res.text);
  const fix = (arr, key) =>
    (arr || []).map((x) => ({ ...x, index: Number(x.scene) - 1 })).filter((x) => x.index >= 0 && x.index < n && (key ? typeof x[key] === 'string' : true));
  return {
    summary: (raw.summary || []).slice(0, 8).map(String),
    narration: fix(raw.narration, 'narration').map(({ index, narration }) => ({ index, narration })),
    headlines: fix(raw.headlines, 'headline').map(({ index, headline }) => ({ index, headline: headline.replace(/[，。！？、]/g, '').slice(0, 12) })),
    visuals: fix(raw.visuals, 'motionPrompt').map(({ index, motionPrompt, newImage }) => ({ index, motionPrompt: motionPrompt.slice(0, 600), newImage: Boolean(newImage) })),
    settings: raw.settings || {}
  };
}

function normalizeScenes(scenes, n) {
  const out = (scenes || []).slice(0, n).map((s) => ({
    section: String(s.section || ''),
    headline: String(s.headline || '').replace(/[，。！？、]/g, '').trim().slice(0, 12),
    narration: String(s.narration || '').trim(),
    visual: String(s.visual || ''),
    motionPrompt: String(s.motionPrompt || 'slow cinematic camera push-in, soft natural light')
  }));
  while (out.length < n) out.push({ ...out[out.length - 1] });
  return out;
}

function mockScript(brief, n) {
  const brand = brief.brand || '你的品牌';
  const tpl = getTemplate(brief.template);
  const sections = tpl
    ? Array.from({ length: n }, (_, i) => tpl.scenes[Math.min(tpl.scenes.length - 1, Math.floor((i * tpl.scenes.length) / n))].section)
    : ['開場', '痛點', '解方'];
  if (tpl) sections[n - 1] = tpl.scenes.at(-1).section;
  if (!tpl) {
    for (let i = 4; i <= n - 3; i++) sections.push(`賣點 ${i - 3}`);
    sections.push('優惠', '信任', '行動呼籲');
  }
  if (sections.length > n) {
    sections.length = n;
    sections[n - 1] = '行動呼籲';
  }
  const scenes = sections.slice(0, n).map((section, i) => ({
    section,
    headline: `重點${i + 1}：${section}`.slice(0, 8),
    narration: `模擬文案第 ${i + 1} 場，${section}：這裡會是 AI 依照 ${brand} 的需求寫好的旁白。`.repeat(n <= 10 ? 2 : 1),
    visual: `${section}相關畫面`,
    motionPrompt: 'slow cinematic camera push-in, soft natural light'
  }));
  return {
    titles: [`${brand}：你也有這個困擾嗎？`, `3 個理由選擇 ${brand}`, `用 ${brand} 讓生活更輕鬆`],
    caption: `【模擬】${brand} 的貼文說明會出現在這裡。`,
    hashtags: [brand, '推薦', '台灣'],
    scenes
  };
}

/* ---------------- 影片庫搜尋關鍵字 ---------------- */
// 把場景的畫面描述變成 2–4 個英文關鍵字（給 Pexels 搜尋用）；文案模型很便宜，失敗就用簡單規則
export async function stockQuery({ visual, motionPrompt }) {
  const fallback = () =>
    String(motionPrompt || '')
      .replace(/[^a-zA-Z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !/^(the|this|that|with|from|into|while|their|they|camera|shot|slowly|gently|natural|scene|image|person)$/i.test(w))
      .slice(0, 3)
      .join(' ') || 'people lifestyle';
  if (config.mock) return fallback();
  try {
    const res = await generateText(
      {
        contents:
          `Give 2-4 simple English search keywords to find a real stock video clip for this scene. ` +
          `Prefer concrete subjects and actions (e.g. "woman drinking coffee cafe"). No brand names. Scene: ${visual}. Motion: ${motionPrompt}`,
        config: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] }, temperature: 0.3 }
      },
      '影片庫關鍵字'
    );
    const q = String(JSON.parse(res.text).query || '').replace(/[^\w\s-]/g, ' ').trim();
    return q || fallback();
  } catch (e) {
    console.warn(`[stock] 關鍵字產生失敗，改用簡單規則：${e.message}`);
    return fallback();
  }
}

/* ---------------- 配音 TTS ---------------- */

// 只送旁白文字本身（新版 TTS 會把任何附加說明也唸出來）
// voice：內建聲線名稱（如 Aoede），或自訂聲音 id（voice_ 開頭：聲音設計／聲音複製）
// 回傳 { data: Buffer, mime }，格式可能是 WAV 或 raw PCM（audio/L16;rate=24000）
export async function synthesizeSpeech(text, voice) {
  if (/^voice(key)?_/.test(voice)) {
    const body = {
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice } } }
    };
    const json = await withRetry(
      async () => (await apiFetch(`${API}/models/${config.ttsModel}:generateContent`, { method: 'POST', body: JSON.stringify(body) }, '產生配音')).json(),
      '產生配音'
    );
    const parts = json.candidates?.[0]?.content?.parts || [];
    const audio = parts.map((p) => p.inlineData || p.inline_data).filter((d) => d?.data);
    if (!audio.length) throw new Error('配音服務沒有回傳音訊');
    return { data: Buffer.concat(audio.map((d) => Buffer.from(d.data, 'base64'))), mime: audio[0].mimeType || audio[0].mime_type || '' };
  }
  const res = await withRetry(
    () =>
      client().models.generateContent({
        model: config.ttsModel,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        }
      }),
    '產生配音'
  );
  const parts = res.candidates?.[0]?.content?.parts || [];
  const audio = parts.filter((p) => p.inlineData?.data);
  if (!audio.length) throw new Error('配音服務沒有回傳音訊');
  return {
    data: Buffer.concat(audio.map((p) => Buffer.from(p.inlineData.data, 'base64'))),
    mime: audio[0].inlineData.mimeType || audio[0].inlineData.mime_type || ''
  };
}

/* ---------------- 自訂聲音：聲音設計（prompted）／聲音複製（replicated） ---------------- */
// 回傳 voice id（voice_ 開頭，保存在你的 Google 專案一年）
export async function createVoice({ type, displayName, gender, prompt, source, consent }) {
  if (config.mock) return `voice_mock_${type}_${Math.random().toString(36).slice(2, 8)}`;
  const voice = { model: config.ttsModel, type, display_name: displayName };
  if (type === 'prompted') Object.assign(voice, { gender, prompted: { input: prompt } });
  else voice.replicated = { source_audio: { mime_type: 'audio/wav', data: source }, consent_audio: { mime_type: 'audio/wav', data: consent } };
  let json;
  try {
    json = await (await apiFetch(`${API}/voices`, { method: 'POST', body: JSON.stringify({ store: true, voice }) }, '建立聲音')).json();
  } catch (e) {
    if (/consent/i.test(e.message)) throw Object.assign(new Error('同意聲明驗證沒通過：請用同一支麥克風、同一個人，清楚唸出畫面上的同意聲明再試一次'), { status: 400 });
    if (/not available|unsupported location|region/i.test(e.message)) throw Object.assign(new Error('你所在的地區目前無法使用聲音複製，請改用內建說書人聲音'), { status: 400 });
    throw e;
  }
  // 可能是長時間作業：輪詢到完成
  let started = Date.now();
  while (json && !json.id && json.name && !json.done && Date.now() - started < 120000) {
    await sleep(3000);
    json = await (await apiFetch(`${API}/${json.name}`, {}, '建立聲音')).json();
  }
  const id = json?.id || json?.response?.id || json?.voice?.id || json?.name?.match(/voice_[\w-]+/)?.[0];
  if (!id) throw new Error(`建立聲音沒有回傳 id：${JSON.stringify(json).slice(0, 300)}`);
  return id;
}

/* ---------------- AI 圖生影片 ---------------- */
// 預設 Gemini Omni Flash（Interactions API）；VIDEO_MODEL 設成 veo-* 時走舊的 generateVideos

const API = 'https://generativelanguage.googleapis.com/v1beta';

async function apiFetch(url, init = {}, label = 'AI 影片') {
  const res = await fetch(url, {
    ...init,
    headers: { 'x-goog-api-key': config.geminiApiKey, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`${label}：HTTP ${res.status} ${text.slice(0, 600)}`);
    e.status = res.status;
    throw e;
  }
  return res;
}

// 在回應 JSON 裡找出影片或圖片（可能是 inline base64，或檔案 uri）
function findMedia(node, kind = 'video', depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  const mime = node.mime_type || node.mimeType || '';
  if ((node.type === kind || mime.startsWith(`${kind}/`)) && (node.data || node.uri || node.file_uri || node.fileUri)) {
    return { data: node.data, uri: node.uri || node.file_uri || node.fileUri, mime };
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const found = findMedia(v, kind, depth + 1);
    if (found) return found;
  }
  return null;
}
const findVideo = (n) => findMedia(n, 'video');

async function downloadVideoUri(uri, outPath) {
  let fileUrl = uri;
  if (/^files\//.test(uri)) fileUrl = `${API}/${uri}`;
  // Files API：等檔案處理完成（ACTIVE）再下載
  if (/generativelanguage\.googleapis\.com\/v1beta\/files\/[^/:?]+$/.test(fileUrl)) {
    for (let i = 0; i < 60; i++) {
      const meta = await (await apiFetch(fileUrl, {}, '查詢影片檔')).json();
      if (meta.state === 'ACTIVE' || !meta.state) break;
      if (meta.state === 'FAILED') throw new Error('AI 影片檔處理失敗');
      await sleep(5000);
    }
    fileUrl = `${fileUrl}:download?alt=media`;
  }
  const res = await apiFetch(fileUrl, { redirect: 'follow' }, '下載 AI 影片');
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}

const isSafety = (e) => /"code":\s*"safety"|filtered out|Prohibited Use|raiMediaFiltered|SAFETY/i.test(String(e?.message));
function safetyError(e) {
  const err = new Error(`AI 影片被 Google 安全過濾：${String(e?.message).slice(0, 200)}`);
  err.safety = true;
  return err;
}

// 讓人物「真的動起來」的共同要求
const LIVE_ACTION =
  'Live-action, photorealistic footage. People move naturally: body movement, hand gestures, natural facial expressions, blinking, ' +
  'interacting with the product or environment. Objects and background have subtle realistic motion. ' +
  'Not just a camera pan or zoom over a still photo. Vertical 9:16 social video. No on-screen text, no captions, no logos.';

// Interactions API 共同流程：送出 → （必要時）輪詢 → 取回影片／圖片
async function interact({ model, input, fmt, task, kind, label }) {
  const bodies = [
    { model, input, response_format: [fmt], ...(task ? { generation_config: { [`${kind}_config`]: { task } } } : {}), store: false },
    { model, input, response_format: fmt, store: false }
  ];
  let reply;
  let lastErr;
  for (const body of bodies) {
    try {
      reply = await withRetry(async () => (await apiFetch(`${API}/interactions`, { method: 'POST', body: JSON.stringify(body) }, label)).json(), label);
      break;
    } catch (e) {
      lastErr = e;
      if (isSafety(e)) throw safetyError(e);
      // 只有「欄位不認得／格式錯誤」才換精簡寫法重送，其他 400 直接回報
      if (!/HTTP 400/.test(e.message) || !/unknown|invalid|unrecognized|not supported|cannot find field/i.test(e.message)) throw e;
    }
  }
  if (!reply) throw lastErr;
  const started = Date.now();
  while (!findMedia(reply, kind) && reply.id && /progress|pending|running|queued/i.test(String(reply.status || ''))) {
    if (Date.now() - started > 15 * 60 * 1000) throw new Error(`${label}逾時（15 分鐘）`);
    await sleep(kind === 'video' ? config.veoPollMs : 3000);
    reply = await (await apiFetch(`${API}/interactions/${reply.id}`, {}, label)).json();
  }
  if (/fail|error|cancel/i.test(String(reply.status || ''))) {
    throw new Error(`${label}失敗：${JSON.stringify(reply.error || reply.status).slice(0, 400)}`);
  }
  const media = findMedia(reply, kind);
  if (!media) {
    const raw = JSON.stringify(reply);
    if (/safety|filtered|prohibited|blocked/i.test(raw)) throw safetyError(new Error(raw.slice(0, 300)));
    throw new Error(`${label}沒有產出：${raw.slice(0, 400)}`);
  }
  return media;
}

async function saveMedia(media, outPath) {
  if (media.data) await fs.writeFile(outPath, Buffer.from(media.data, 'base64'));
  else await downloadVideoUri(media.uri, outPath);
}

// 有圖：圖生影片；沒圖：直接用文字生成真人實拍感畫面
async function omniVideo({ imagePath, mime, prompt, outPath }) {
  const input = [];
  if (imagePath) {
    const data = (await fs.readFile(imagePath)).toString('base64');
    input.push({ type: 'image', data, mime_type: mime === 'image/webp' ? 'image/webp' : mime });
    input.push({ type: 'text', text: `${prompt}. Use this image as the first frame and keep its subject and composition. ${LIVE_ACTION}` });
  } else {
    input.push({ type: 'text', text: `${prompt}. ${LIVE_ACTION} Taiwanese/East Asian everyday setting unless the description says otherwise.` });
  }
  const media = await interact({
    model: config.videoModel,
    input,
    fmt: { type: 'video', aspect_ratio: '9:16', resolution: config.videoResolution },
    task: imagePath ? 'image_to_video' : 'text_to_video',
    kind: 'video',
    label: '送出 AI 影片'
  });
  await saveMedia(media, outPath);
  return outPath;
}

/* ---------------- 說書人真人對嘴 ---------------- */
// 用說書人照片當第一格，讓 Omni 一次產生「說話的畫面＋聲音」，嘴型與聲音同步。
// 目前 API 不接受上傳聲音樣本，聲音由 Omni 依描述產生。
export async function talkingVideo({ imagePath, mime, text, voiceDesc, seconds, outPath }) {
  const data = (await fs.readFile(imagePath)).toString('base64');
  const prompt =
    `<FIRST_FRAME> The person in this image is a storyteller looking into the camera and speaking in Mandarin Chinese with a natural Taiwanese accent. ` +
    `Voice: ${voiceDesc}. ` +
    `They say exactly these words, word for word, nothing more and nothing less: 「${text}」. ` +
    `Precise lip-sync with the spoken words, natural head movement, blinking, warm sincere facial expression, small natural hand gestures. ` +
    `Keep exactly the same person, face, hairstyle, clothing and background as the image. Steady medium close-up, static camera, vertical 9:16, live-action photorealistic. ` +
    `The clip is about ${seconds} seconds long: start speaking right away, finish the whole sentence, then hold a soft smile for half a second. ` +
    `Audio: only this one person's clear voice in a quiet room. No background music, no sound effects, no other voices. No on-screen text, no captions, no subtitles.`;
  const media = await interact({
    model: config.lipsyncModel,
    input: [
      { type: 'image', data, mime_type: mime === 'image/webp' ? 'image/webp' : mime },
      { type: 'text', text: prompt }
    ],
    fmt: { type: 'video', aspect_ratio: '9:16', resolution: config.videoResolution },
    task: 'image_to_video',
    kind: 'video',
    label: '說書人對嘴影片'
  });
  await saveMedia(media, outPath);
  return outPath;
}

/* ---------------- AI 補圖 ---------------- */
// 回傳實際的 mime（image/png 或 image/jpeg）
export async function generateImage({ prompt, outPath }) {
  if (config.mock) {
    const { run } = await import('./media.js');
    const hue = Math.floor(Math.random() * 360);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=768x1376:d=1,hue=h=${hue}`, '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', outPath]);
    return 'image/jpeg';
  }
  const media = await interact({
    model: config.imageModel,
    input: `${prompt}\n\nVertical 9:16 photo for a social media video. Photorealistic, natural lighting, real-life scene, sharp focus. ` +
      'If people appear, they look natural and candid (adults only). No text, no watermark, no logos, no brand names.',
    fmt: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '9:16' },
    kind: 'image',
    label: 'AI 生圖'
  });
  await saveMedia(media, outPath);
  const head = (await fs.readFile(outPath)).subarray(0, 4);
  return head[0] === 0x89 && head[1] === 0x50 ? 'image/png' : media.mime?.startsWith('image/') ? media.mime : 'image/jpeg';
}

async function veoImageToVideo({ imagePath, mime, prompt, outPath, seconds = 8 }) {
  const imageBytes = (await fs.readFile(imagePath)).toString('base64');
  let operation = await withRetry(
    () =>
      client().models.generateVideos({
        model: config.videoModel,
        prompt: `${prompt}. Vertical 9:16 social video, keep the subject and composition of the input image, no on-screen text.`,
        image: { imageBytes, mimeType: mime },
        config: { aspectRatio: '9:16', durationSeconds: seconds, resolution: config.videoResolution, numberOfVideos: 1 }
      }),
    '送出 AI 影片'
  );
  const started = Date.now();
  while (!operation.done) {
    if (Date.now() - started > 15 * 60 * 1000) throw new Error('AI 影片生成逾時（15 分鐘）');
    await sleep(config.veoPollMs);
    operation = await withRetry(() => client().operations.getVideosOperation({ operation }), '查詢 AI 影片進度');
  }
  if (operation.error) throw new Error(`AI 影片生成失敗：${operation.error.message || JSON.stringify(operation.error)}`);
  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) throw safetyError(new Error(JSON.stringify(operation.response?.raiMediaFilteredReasons || 'filtered')));
  await withRetry(() => client().files.download({ file: video, downloadPath: outPath }), '下載 AI 影片');
  return outPath;
}

export async function imageToVideo(opts) {
  if (config.mock) throw safetyError(new Error('模擬安全過濾（MOCK_BLOCK 測試用）'));
  if (!opts.imagePath && config.videoModel.startsWith('veo')) throw new Error('Veo 模式需要圖片');
  return config.videoModel.startsWith('veo') ? veoImageToVideo(opts) : omniVideo(opts);
}
