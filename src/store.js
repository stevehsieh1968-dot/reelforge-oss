// 簡單的檔案型資料庫：每個專案一個資料夾，裡面一個 project.json
// 規模變大時可換成 PostgreSQL，介面維持 get / save / list 即可。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export const projectsDir = path.join(config.dataDir, 'projects');

export function projectDir(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw httpError(400, '專案編號格式錯誤');
  return path.join(projectsDir, id);
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const locks = new Map();
// 同一專案的寫入排隊，避免同時寫壞 JSON
async function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  locks.set(id, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === next) locks.delete(id);
  }
}

export async function createProject(brief) {
  const id = crypto.randomUUID();
  const dir = projectDir(id);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, 'cache'), { recursive: true });
  await fs.mkdir(path.join(dir, 'versions'), { recursive: true });
  const now = new Date().toISOString();
  const project = {
    id,
    createdAt: now,
    updatedAt: now,
    brief,
    script: null, // { titles, title, caption, hashtags, scenes: [{ narration, visual }] }
    assets: [], // { id, file, originalName, mime }
    scenes: [], // { assetId, motion: 'ai'|'kenburns', variant }
    settings: { tier: 'premium', voice: 'female-warm', subtitle: 'outline', bgmAssetId: 'builtin:piano', speed: 1, transition: 'fade', headlines: true },
    revisionsUsed: 0,
    versions: [], // { n, file, createdAt, note, regenerated: [idx] }
    job: null, // { status: 'queued'|'running'|'done'|'error', step, progress, error }
    cost: { usd: 0, items: [] }
  };
  await saveProject(project);
  return project;
}

export async function getProject(id) {
  try {
    const raw = await fs.readFile(path.join(projectDir(id), 'project.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, '找不到這個專案');
    throw e;
  }
}

export async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  const file = path.join(projectDir(project.id), 'project.json');
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(project, null, 2));
  await fs.rename(tmp, file);
  return project;
}

// 讀取 → 修改 → 寫回，全部在鎖內
export async function updateProject(id, mutate) {
  return withLock(id, async () => {
    const p = await getProject(id);
    await mutate(p);
    return saveProject(p);
  });
}

export async function listProjects() {
  await fs.mkdir(projectsDir, { recursive: true });
  const ids = await fs.readdir(projectsDir);
  const out = [];
  for (const id of ids) {
    try {
      const p = await getProject(id);
      out.push({ id: p.id, name: p.brief?.brand, updatedAt: p.updatedAt, versions: p.versions.length });
    } catch {
      /* 略過壞掉的資料夾 */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
