// 端到端測試（建議在模擬模式跑：MOCK=1 npm run test:e2e）
// 需求 → 文案 → 上傳圖片 → 產生影片 → 修改 → 檢查次數限制
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, form) {
  const res = await fetch(BASE + url, { method, headers: form || !body ? {} : { 'Content-Type': 'application/json' }, body: form || (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function ok(cond, msg) { if (!cond) { console.error('✗', msg); process.exit(1); } console.log('✓', msg); }
async function waitJob(id) {
  for (;;) {
    const { data } = await api('GET', `/api/projects/${id}`);
    process.stdout.write(`\r  ${data.job?.step} ${data.job?.progress}%      `);
    if (data.job?.status === 'done') { console.log(); return data; }
    if (data.job?.status === 'error') { console.log(); throw new Error(data.job.error); }
    await sleep(2000);
  }
}
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type:format=duration', '-of', 'json', f]).toString());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
const colors = ['0x2F55E4', '0xE4552F', '0x2FE48A', '0xE4C52F', '0x8A2FE4', '0x2FC9E4'];
const files = colors.map((c, i) => {
  const f = path.join(tmp, `img${i}.jpg`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=1080x1350:d=1,drawbox=c=${c}@0.5:t=fill`, '-frames:v', '1', f]);
  return f;
});

const t0 = Date.now();
let r = await api('POST', '/api/projects', { brief: { brand: '測試咖啡', audience: '上班族', purpose: '產品介紹', points: '手沖咖啡豆、每週新鮮烘焙', tone: '親切口語' } });
ok(r.status === 201, '建立專案');
const id = r.data.id;
r = await api('POST', `/api/projects/${id}/script`, {});
const N = r.data.script?.scenes?.length;
ok(N === 10, `預設產生 ${N} 個場景文案（建議 10）`);
r = await api('PATCH', `/api/projects/${id}/script`, { scenes: [{ index: 0, narration: '早上第一杯咖啡，你喝對了嗎？今天帶你認識每週新鮮烘焙的手沖豆。' }] });
ok(r.data.script.scenes[0].narration.startsWith('早上'), '手動修改文案');
await api('PUT', `/api/projects/${id}/scenes`, { settings: { tier: 'economy' } });
r = await api('POST', `/api/projects/${id}/render`);
ok(r.status === 400, '經濟版「鏡頭推移」場景沒有圖片時不能產生影片');
r = await api('POST', `/api/projects/${id}/scenes/5/ai-image`, {});
ok(r.data.assets?.length === 1 && r.data.scenes[5].assetId === r.data.assets[0].id, 'AI 補圖套用到場景 6');
const fd = new FormData();
for (const f of files) fd.append('files', new Blob([fs.readFileSync(f)], { type: 'image/jpeg' }), path.basename(f));
r = await api('POST', `/api/projects/${id}/assets`, null, fd);
ok(r.data.assets.length === 7 && r.data.scenes.every((s) => s.assetId), '上傳 6 張圖並自動配對');
r = await api('PUT', `/api/projects/${id}/scenes`, { settings: { tier: 'economy' } });
ok(r.data.scenes.filter((s) => s.motion === 'ai').length === 2, '經濟版 AI 動態場景 = 2（10 場的 20%）');
r = await api('PUT', `/api/projects/${id}/scenes`, { scenes: r.data.scenes.map(() => ({ motion: 'ai' })) });
ok(r.data.scenes.filter((s) => s.motion === 'ai').length === 2, 'AI 場景數不能超過方案上限');
r = await api('POST', `/api/projects/${id}/render`);
ok(r.status === 202, '送出產生影片');
let p = await waitJob(id);
const v1 = path.join(process.env.DATA_DIR || './data', 'projects', id, 'versions', 'v1.mp4');
let info = probe(v1);
const vs = info.streams.find((s) => s.codec_type === 'video');
ok(vs.width === 1080 && vs.height === 1920, `v1 解析度 ${vs.width}×${vs.height}`);
ok(Math.abs(Number(info.format.duration) - 180) < 6, `v1 長度 ${Number(info.format.duration).toFixed(1)} 秒`);
ok(info.streams.some((s) => s.codec_type === 'audio'), 'v1 有音軌');

r = await api('POST', `/api/projects/${id}/revise`, { scenes: [0, 1, 2, 3, 4], types: ['visual'] });
ok(r.status === 400, '一次超過 4 個場景會被擋');
r = await api('POST', `/api/projects/${id}/revise`, { scenes: [2, 6], types: ['visual', 'narration'], note: '更有活力', sceneEdits: { 2: { narration: '這一段旁白是手動改的新內容，看看字幕有沒有跟著更新。' } } });
ok(r.status === 202 && r.data.revisionsLeft === 4, '修改 1：剩 4 次');
p = await waitJob(id);
ok(p.versions.length === 2 && p.versions[1].regenerated.join() === '2,6', 'v2 只重做場景 3、7');
r = await api('POST', `/api/projects/${id}/revise`, { types: ['voice', 'subtitle'], settings: { voice: 'male-calm', subtitle: 'box' } });
ok(r.status === 202 && r.data.revisionsLeft === 3, '修改 2（換聲線＋字幕）：剩 3 次');
await waitJob(id);
r = await api('POST', `/api/projects/${id}/revise`, { full: true });
ok(r.status === 202 && r.data.revisionsLeft === 1, '全片重做扣 2 次：剩 1 次');
await waitJob(id);
r = await api('POST', `/api/projects/${id}/revise`, { full: true });
ok(r.status === 403, '剩 1 次時不能全片重做');
r = await api('POST', `/api/projects/${id}/revise`, { scenes: [9], types: ['visual'] });
ok(r.status === 202 && r.data.revisionsLeft === 0, '修改 5：剩 0 次');
p = await waitJob(id);
r = await api('POST', `/api/projects/${id}/revise`, { scenes: [1], types: ['visual'] });
ok(r.status === 403, '第 6 次修改被擋');
ok(p.versions.length === 5, `共 ${p.versions.length} 個版本（初版＋4 次送出，其中 1 次全片重做扣 2）`);
r = await api('POST', `/api/projects/${id}/revise-plan`, { instruction: '節奏快一點' });
ok(r.status === 200 && r.data.revisionsLeft === 0, '次數用完時仍可預覽 AI 規劃');
r = await api('POST', `/api/projects/${id}/revise`, { planId: r.data.plan.id });
ok(r.status === 403, '次數用完時一句話修改被擋');
console.log(`\n全部通過，用時 ${Math.round((Date.now() - t0) / 1000)} 秒。專案：${BASE}/#/p/${id}/video`);

// AI 一鍵成片（另一個專案，12 場景）
r = await api('POST', '/api/projects', { brief: { brand: '一鍵測試', audience: '大家', purpose: '產品介紹', points: '好用', sceneCount: 12 } });
const id2 = r.data.id;
r = await api('POST', `/api/projects/${id2}/auto`, { tier: 'standard' });
ok(r.status === 202, '送出 AI 一鍵成片');
const p2 = await waitJob(id2);
const v2 = path.join(process.env.DATA_DIR || './data', 'projects', id2, 'versions', 'v1.mp4');
ok(p2.script.scenes.length === 12 && p2.assets.length === 12 && p2.scenes.filter((s) => s.motion === 'ai').length === 6, '一鍵成片：12 場文案、12 張 AI 圖、6 場 AI 動態');
ok(Math.abs(Number(probe(v2).format.duration) - 180) < 6, `一鍵成片長度 ${Number(probe(v2).format.duration).toFixed(1)} 秒`);
console.log('一鍵成片也通過');
