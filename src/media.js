// FFmpeg 工具：鏡頭推移、片段標準化、配音對時、字幕、最終合成
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const W = config.width;
const H = config.height;
const FPS = config.fps;
const VCODEC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

export function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: opts.cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} 失敗 (${code})：${err.slice(-1500)}`))
    );
  });
}

const ff = (args, opts) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], opts);

export async function duration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(out.trim());
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/* ---------- 音訊 ---------- */

// 配音轉成乾淨的 24kHz 單聲道 WAV：自動判斷格式，並修掉頭尾的靜音與雜訊
const TRIM =
  'silenceremove=start_periods=1:start_duration=0.03:start_threshold=-48dB:detection=peak,areverse,' +
  'silenceremove=start_periods=1:start_duration=0.03:start_threshold=-48dB:detection=peak,areverse';

export async function speechToWav({ data, mime = '' }, outWav) {
  const head = data.subarray(0, 4).toString('latin1');
  const isContainer =
    /wav|wave|mpeg|mp3|ogg|opus|webm|aac|flac|mp4/i.test(mime) ||
    head === 'RIFF' || head.startsWith('ID3') || head === 'OggS' || head === 'fLaC' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
  const raw = outWav + '.in';
  await fs.writeFile(raw, data);
  try {
    if (isContainer) {
      await ff(['-i', raw, '-af', TRIM, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outWav]);
    } else {
      const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
      await ff(['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', raw, '-af', TRIM, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outWav]);
    }
  } finally {
    await fs.unlink(raw).catch(() => {});
  }
}

// 試聽用：套用語速
export async function applyTempo(inWav, outWav, tempo) {
  await ff(['-i', inWav, '-af', `atempo=${Math.min(1.5, Math.max(0.8, tempo)).toFixed(3)}`, '-c:a', 'pcm_s16le', outWav]);
}

export async function pcmToWav(pcm, outWav) {
  const raw = outWav + '.pcm';
  await fs.writeFile(raw, pcm);
  await ff(['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, outWav]);
  await fs.unlink(raw);
}

// 模擬模式用：依字數產生對應長度的柔和測試音
export async function mockSpeech(text, outWav) {
  const secs = Math.max(2, [...text].length / 4.2).toFixed(2);
  await ff(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${secs}`, '-af', 'volume=0.05', '-ar', '24000', '-ac', '1', outWav]);
}

// 調整語速並補靜音，讓配音剛好等於場景長度（48kHz 立體聲）
// 開頭、結尾加極短淡入淡出，消除場景接縫的「啪」聲；去掉低頻雜訊
export async function fitAudio(inWav, outWav, seconds, tempo = 1, spoken = null) {
  const t = Math.min(1.5, Math.max(0.8, tempo)).toFixed(3);
  const speech = Math.max(0.2, Math.min(spoken ?? seconds, seconds));
  const fadeOutAt = Math.max(0, speech - 0.12).toFixed(3);
  await ff([
    '-i', inWav,
    '-af', [
      `atempo=${t}`,
      'aresample=48000',
      'highpass=f=70',
      'afade=t=in:st=0:d=0.04',
      `afade=t=out:st=${fadeOutAt}:d=0.12`,
      `atrim=0:${speech.toFixed(3)}`,
      'apad',
      `atrim=0:${seconds.toFixed(3)}`
    ].join(','),
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', outWav
  ]);
}

export async function concatAudio(files, outWav, workDir) {
  const list = path.join(workDir, 'audio-list.txt');
  await fs.writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outWav]);
}

/* ---------- 畫面 ---------- */

// 鏡頭推移（Ken Burns）：把靜態圖做成有動感的片段，幾乎零成本
export async function kenBurns(imagePath, outMp4, seconds, variant = 0, intensity = 0.12) {
  const N = Math.round(seconds * FPS);
  const BW = Math.round(W * 1.5);
  const BH = Math.round(H * 1.5);
  const z = intensity;
  const moves = [
    { z: `1+${z}*on/${N}`, x: `(iw-iw/zoom)/2`, y: `(ih-ih/zoom)/2` }, // 推近
    { z: `${1 + z}-${z}*on/${N}`, x: `(iw-iw/zoom)/2`, y: `(ih-ih/zoom)/2` }, // 拉遠
    { z: `${1 + z}`, x: `(iw-iw/zoom)*on/${N}`, y: `(ih-ih/zoom)/2` }, // 左→右
    { z: `${1 + z}`, x: `(iw-iw/zoom)/2`, y: `(ih-ih/zoom)*(1-on/${N})` } // 下→上
  ];
  const m = moves[variant % moves.length];
  const vf = [
    `scale=${BW}:${BH}:force_original_aspect_ratio=increase`,
    `crop=${BW}:${BH}`,
    `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=1:s=${W}x${H}:fps=${FPS}`,
    'setsar=1'
  ].join(',');
  await ff(['-loop', '1', '-framerate', String(FPS), '-i', imagePath, '-vf', vf, '-t', seconds.toFixed(3), '-an', ...VCODEC, outMp4]);
}

// 把 AI 片段（通常 8 秒）調成場景長度：先最多放慢 1.3 倍，不夠再停格補齊
export async function fitClip(inMp4, outMp4, seconds, { keepSpeed = false } = {}) {
  const src = await duration(inMp4);
  // keepSpeed：對嘴影片不能放慢（嘴型會和聲音對不上），不夠長就停在最後一格
  const slow = keepSpeed ? 1 : Math.min(1.3, Math.max(1, seconds / src));
  const pad = Math.max(0, seconds - src * slow) + 0.5;
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
    `setpts=${slow.toFixed(4)}*PTS`,
    `fps=${FPS}`,
    `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`,
    `trim=0:${seconds.toFixed(3)}`,
    'setpts=PTS-STARTPTS',
    'setsar=1'
  ].join(',');
  await ff(['-i', inMp4, '-vf', vf, '-an', ...VCODEC, outMp4]);
}

// 影片的畫面長度（對嘴片段：聲音要剪成跟畫面一樣長）
export async function videoDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file]);
  const d = Number(out.trim());
  return d > 0 ? d : duration(file);
}

// 取出影片裡的聲音（說書人對嘴），長度剛好等於畫面長度
export async function extractAudio(inMp4, outWav, seconds) {
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', inMp4]);
  if (!probe.trim()) throw new Error('對嘴影片沒有聲音');
  await ff(['-i', inMp4, '-vn', '-af', `aresample=24000,apad,atrim=0:${seconds.toFixed(3)}`, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', outWav]);
}

// 模擬模式的對嘴片段：說書人照片＋測試音
export async function mockTalking(imagePath, outMp4, seconds) {
  await ff([
    '-loop', '1', '-i', imagePath,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds.toFixed(2)}`,
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`,
    '-af', 'volume=0.05', '-t', seconds.toFixed(2),
    ...VCODEC, '-c:a', 'aac', '-shortest', outMp4
  ]);
}

// 取影片最後一格當下一個鏡頭的起始畫面（讓長場景的多個 AI 鏡頭連續不跳）
export async function lastFrame(videoFile, outJpg) {
  await ff(['-sseof', '-0.15', '-i', videoFile, '-frames:v', '1', '-q:v', '2', '-update', '1', outJpg]);
}

export async function concatVideo(files, outMp4, workDir) {
  const list = path.join(workDir, `${path.basename(outMp4)}.list.txt`);
  await fs.writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outMp4]);
  await fs.unlink(list).catch(() => {});
}

// 場景轉場：每段（最後一段除外）多算 d 秒讓轉場重疊，轉場開始點＝下一場旁白開始，配音時間不變
export const TRANSITIONS = { fade: 'fade', slide: 'slideleft', zoom: 'zoomin', none: null };
export async function xfadeVideo(files, durations, kind, d, outMp4) {
  const t = TRANSITIONS[kind];
  if (!t || files.length < 2) return concatVideo(files, outMp4, path.dirname(outMp4));
  const args = [];
  files.forEach((f) => args.push('-i', f));
  const parts = [];
  let prev = '[0:v]';
  let offset = 0;
  for (let k = 1; k < files.length; k++) {
    offset += durations[k - 1];
    const label = k === files.length - 1 ? '[v]' : `[x${k}]`;
    parts.push(`${prev}[${k}:v]xfade=transition=${t}:duration=${d}:offset=${offset.toFixed(3)}${label}`);
    prev = label;
  }
  await ff([...args, '-filter_complex', parts.join(';'), '-map', '[v]', '-an', ...VCODEC, outMp4]);
}

/* ---------- 字幕、重點大字、片尾卡（ASS） ---------- */

const assTime = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
};

// #RRGGBB → ASS 的 &HAABBGGRR
export function assColor(hex = '#2F55E4', alpha = 0) {
  const h = /^#?[0-9a-f]{6}$/i.test(hex) ? hex.replace('#', '') : '2F55E4';
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

const clean = (s) => String(s || '').replace(/[{}\\]/g, '').replace(/\n/g, ' ');

// 把一段旁白切成 ≤ maxLen 字的字幕句，依字數分配時間
export function splitCaption(text, maxLen = 14) {
  const parts = text
    .replace(/\s+/g, '')
    .split(/(?<=[，。！？、；：,.!?;:])/)
    .filter(Boolean);
  const out = [];
  for (let p of parts) {
    p = p.replace(/[，。、；：,.;:]$/, '');
    while ([...p].length > maxLen) {
      const chars = [...p];
      out.push(chars.slice(0, maxLen).join(''));
      p = chars.slice(maxLen).join('');
    }
    if (p) out.push(p);
  }
  return out;
}

function assHeader(styles, wrap = 2) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: ${wrap}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * cues: [{start,end,text}]  headlines: [{start,end,text}]
 * style: outline | box | karaoke   brand: { color, name, ctaText, ctaSub }  endCard: { start, end } | null
 */
export async function writeAss({ cues, headlines = [], style = 'outline', brand = {}, endCard = null, pipName = null }, outFile) {
  const font = config.subtitleFont;
  const bc = assColor(brand.color);
  const styles = [
    style === 'box'
      ? `Style: Default,${font},68,&H00FFFFFF,&H00FFFFFF,${bc},${bc},1,0,0,0,100,100,0,0,3,18,0,2,80,80,380,1`
      : style === 'karaoke'
        ? // 逐字跳出：字先是白色，念到時變黃色
          `Style: Default,${font},74,&H0000D4FF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,6,2,2,80,80,380,1`
        : `Style: Default,${font},70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,5,2,2,80,80,380,1`,
    `Style: Headline,${font},92,&H00FFFFFF,&H00FFFFFF,${bc},${bc},1,0,0,0,100,100,2,0,3,22,0,8,80,80,300,1`,
    `Style: EndName,${font},84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,4,3,5,60,60,0,1`,
    `Style: EndCta,${font},62,&H00FFFFFF,&H00FFFFFF,${bc},${bc},1,0,0,0,100,100,0,0,3,20,0,5,60,60,0,1`,
    `Style: PipName,${font},34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,5,0,0,0,1`,
    `Style: EndSub,${font},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,5,60,60,0,1`
  ];
  const ev = [];
  for (const c of cues) {
    if (endCard && c.start >= endCard.start - 0.05) continue; // 片尾卡時間不顯示一般字幕
    let text = clean(c.text);
    if (style === 'karaoke') {
      const chars = [...text];
      const cs = Math.max(1, Math.round(((c.end - c.start) * 100) / Math.max(1, chars.length)));
      text = chars.map((ch) => `{\\kf${cs}}${ch}`).join('');
    }
    ev.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${text}`);
  }
  for (const h of headlines) {
    if (!h.text) continue;
    // 重點大字：彈出放大＋淡入淡出
    ev.push(`Dialogue: 1,${assTime(h.start)},${assTime(h.end)},Headline,,0,0,0,,{\\fad(150,200)\\fscx70\\fscy70\\t(0,180,\\fscx100\\fscy100)}${clean(h.text)}`);
  }
  if (pipName?.text) {
    for (const [a, b] of pipName.ranges) {
      ev.push(`Dialogue: 1,${assTime(a)},${assTime(b)},PipName,,0,0,0,,{\\pos(156,${H - 640 + 250})}${clean(pipName.text)}`);
    }
  }
  if (endCard) {
    const s = assTime(endCard.start + 0.2);
    const e = assTime(endCard.end);
    if (brand.name) ev.push(`Dialogue: 2,${s},${e},EndName,,0,0,0,,{\\fad(300,0)\\pos(${W / 2},${Math.round(H * 0.53)})}${clean(brand.name)}`);
    if (brand.ctaText) ev.push(`Dialogue: 2,${s},${e},EndCta,,0,0,0,,{\\fad(300,0)\\pos(${W / 2},${Math.round(H * 0.62)})}${clean(brand.ctaText)}`);
    if (brand.ctaSub) ev.push(`Dialogue: 2,${s},${e},EndSub,,0,0,0,,{\\fad(300,0)\\pos(${W / 2},${Math.round(H * 0.70)})}${clean(brand.ctaSub)}`);
  }
  await fs.writeFile(outFile, assHeader(styles) + ev.join('\n') + '\n');
}

/* ---------- 最終合成 ---------- */

/**
 * logoFile：品牌 Logo（透明 PNG 最好）；watermark：右上角浮水印；intro：開頭 1.5 秒置中 Logo；
 * endCard：{start,end} 片尾卡（畫面變暗＋大 Logo，文字由 ASS 負責）
 */
export async function finalMux({ clips, durations, transition = 'none', xd = 0, narrationFile, bgmFile, assFile, outFile, workDir, logoFile = null, watermark = false, intro = false, endCard = null, pip = null }) {
  // 轉場與字幕、Logo 在同一次編碼完成（少一輪重新編碼）
  const total = durations.reduce((a, b) => a + b, 0);
  const t = TRANSITIONS[transition];
  let args = [];
  const chain = [];
  let v;
  if (t && clips.length > 1) {
    clips.forEach((f) => args.push('-i', f));
    let prev = '[0:v]';
    let offset = 0;
    for (let k = 1; k < clips.length; k++) {
      offset += durations[k - 1];
      chain.push(`${prev}[${k}:v]xfade=transition=${t}:duration=${xd}:offset=${offset.toFixed(3)}[x${k}]`);
      prev = `[x${k}]`;
    }
    v = prev;
  } else {
    const list = path.join(workDir, 'video-list.txt');
    await fs.writeFile(list, clips.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    args.push('-f', 'concat', '-safe', '0', '-i', list);
    v = '[0:v]';
  }
  const nIdx = t && clips.length > 1 ? clips.length : 1;
  args.push('-i', narrationFile);
  let idx = nIdx + 1;
  let bgmIdx = null;
  let logoIdx = null;
  if (bgmFile) {
    args.push('-stream_loop', '-1', '-i', bgmFile);
    bgmIdx = idx++;
  }
  if (logoFile && (watermark || intro || endCard)) {
    args.push('-loop', '1', '-framerate', String(FPS), '-t', total.toFixed(3), '-i', logoFile);
    logoIdx = idx++;
  }
  let pipIdx = null;
  if (pip?.file && pip.ranges?.length) {
    args.push('-loop', '1', '-framerate', String(FPS), '-t', total.toFixed(3), '-i', pip.file);
    pipIdx = idx++;
  }

  // 音訊：旁白統一音量；有背景音樂時自動壓低並在片尾淡出
  let audio = `[${nIdx}:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`;
  if (bgmIdx !== null) {
    audio =
      `[${nIdx}:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,asplit=2[n1][n2];` +
      `[${bgmIdx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.22,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[bgm];` +
      '[bgm][n1]sidechaincompress=threshold=0.04:ratio=5:attack=60:release=1500[duck];' +
      '[n2][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]';
  }

  // 畫面：轉場 → 片尾變暗 → 字幕／大字 → Logo
  if (endCard) {
    chain.push(`${v}drawbox=x=0:y=0:w=iw:h=ih:color=black@0.6:t=fill:enable='gte(t,${endCard.start.toFixed(2)})'[dim]`);
    v = '[dim]';
  }
  chain.push(`${v}subtitles=${path.basename(assFile)}[sub]`);
  v = '[sub]';
  if (logoIdx !== null) {
    const uses = [watermark && 'w', intro && 'i', endCard && 'e'].filter(Boolean);
    chain.push(`[${logoIdx}:v]format=rgba,split=${uses.length}${uses.map((u) => `[l${u}]`).join('')}`);
    if (watermark) {
      chain.push(`[lw]scale=150:-1,colorchannelmixer=aa=0.85[lw2]`);
      const en = [intro ? 'gte(t,1.6)' : null, endCard ? `lt(t,${endCard.start.toFixed(2)})` : null].filter(Boolean).join('*') || '1';
      chain.push(`${v}[lw2]overlay=x=W-w-48:y=120:enable='${en}'[o1]`);
      v = '[o1]';
    }
    if (intro) {
      chain.push(`[li]scale=420:-1,fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st=1.2:d=0.4:alpha=1[li2]`);
      chain.push(`${v}[li2]overlay=x=(W-w)/2:y=(H-h)/2-120:enable='lt(t,1.6)'[o2]`);
      v = '[o2]';
    }
    if (endCard) {
      chain.push(`[le]scale=460:-1,fade=t=in:st=${(endCard.start + 0.1).toFixed(2)}:d=0.4:alpha=1[le2]`);
      chain.push(`${v}[le2]overlay=x=(W-w)/2:y=H*0.44-h:enable='gte(t,${endCard.start.toFixed(2)})'[o3]`);
      v = '[o3]';
    }
  }
  if (pipIdx !== null) {
    // 說書人小頭像：只在說書人沒出鏡的時段顯示
    const en = pip.ranges.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+');
    chain.push(`[${pipIdx}:v]format=rgba[pp]`);
    chain.push(`${v}[pp]overlay=x=40:y=H-640:enable='${en}'[o4]`);
    v = '[o4]';
  }
  chain.push(`${v}null[v]`);
  args.push(
    '-filter_complex', `${audio};${chain.join(';')}`,
    '-map', '[v]', '-map', '[a]',
    ...VCODEC, '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile
  );
  await ff(args, { cwd: workDir });
}

// 說書人圓形小頭像（白色外框），輸出透明 PNG
export async function makeCircle(photo, outPng, size = 220) {
  const r = size / 2;
  const R = r + 6;
  const S = size + 12;
  await ff([
    '-i', photo,
    '-f', 'lavfi', '-i', `color=c=white:s=${S}x${S}`,
    '-filter_complex',
    `[0:v]scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${r},Y-${r}),${r - 1}),255,0)'[c];` +
      `[1:v]format=rgba,geq=r='255':g='255':b='255':a='if(lte(hypot(X-${R},Y-${R}),${R - 1}),255,0)'[ring];[ring][c]overlay=6:6:format=auto`,
    '-frames:v', '1', outPng
  ]);
}

// 錄音或上傳的說書人聲音 → 乾淨的 24kHz 單聲道 WAV（修掉頭尾空白）
export async function voiceToWav(inFile, outWav) {
  await ff(['-i', inFile, '-vn', '-af', `highpass=f=70,${TRIM}`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outWav]);
}

/* ---------- 封面圖 ---------- */
export async function makeCover({ videoFile, time, title, brand = {}, logoFile = null, outFile, workDir }) {
  const font = config.subtitleFont;
  const bc = assColor(brand.color);
  const ass = path.join(workDir, 'cover.ass');
  const styles = [
    `Style: Title,${font},118,&H00FFFFFF,&H00FFFFFF,${bc},${bc},1,0,0,0,100,100,2,0,3,30,0,2,90,90,420,1`,
    `Style: Brand,${font},54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,4,3,2,90,90,300,1`
  ];
  const ev = [`Dialogue: 0,0:00:00.00,0:00:10.00,Title,,0,0,0,,${clean(title)}`];
  if (brand.name) ev.push(`Dialogue: 0,0:00:00.00,0:00:10.00,Brand,,0,0,0,,${clean(brand.name)}`);
  await fs.writeFile(ass, assHeader(styles, 0) + ev.join('\n') + '\n');
  const args = ['-ss', Math.max(0, time).toFixed(2), '-i', videoFile];
  // 底部漸層加深，讓標題清楚
  let filter = `[0:v]drawbox=x=0:y=ih*0.55:w=iw:h=ih*0.45:color=black@0.45:t=fill,subtitles=cover.ass[c]`;
  if (logoFile) {
    args.push('-i', logoFile);
    filter += `;[1:v]format=rgba,scale=220:-1[lg];[c][lg]overlay=x=60:y=110[c2]`;
  }
  args.push('-filter_complex', filter, '-map', logoFile ? '[c2]' : '[c]', '-frames:v', '1', '-q:v', '3', outFile);
  await ff(args, { cwd: workDir });
}
