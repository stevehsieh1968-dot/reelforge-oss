"""產生 5 首內建背景音樂（程式合成、無版權問題），輸出到 music/*.mp3
用法：python scripts/make-music.py   （需要 numpy、scipy、ffmpeg）
每首約 60 秒，頭尾可無縫循環。"""
import os, subprocess, tempfile
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, lfilter

SR = 44100
rng = np.random.default_rng(7)
OUT = os.path.join(os.path.dirname(__file__), '..', 'music')
os.makedirs(OUT, exist_ok=True)

NOTE = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}
def hz(name, octave):
    return 440.0 * 2 ** ((NOTE[name] + 12 * (octave + 1) - 69) / 12)

def lowpass(x, cut, order=2):
    b, a = butter(order, min(cut / (SR / 2), 0.99), 'low')
    return lfilter(b, a, x)

def highpass(x, cut, order=2):
    b, a = butter(order, cut / (SR / 2), 'high')
    return lfilter(b, a, x)

def env(n, a=0.005, d=0.2, s=0.6, r=0.1, hold=None):
    t = np.arange(n) / SR
    hold = hold if hold is not None else n / SR - r
    e = np.where(t < a, t / a, s + (1 - s) * np.exp(-(t - a) / max(d, 1e-3)))
    rel = np.clip(1 - (t - hold) / r, 0, 1)
    return e * np.where(t > hold, rel, 1)

def osc(f, n, kind='sine', detune=0.0):
    t = np.arange(n) / SR
    ph = 2 * np.pi * f * (1 + detune) * t
    if kind == 'sine':
        return np.sin(ph)
    if kind == 'tri':
        return 2 / np.pi * np.arcsin(np.sin(ph))
    if kind == 'saw':
        return 2 * ((f * (1 + detune) * t) % 1) - 1
    if kind == 'square':
        return np.sign(np.sin(ph)) * 0.7
    if kind == 'piano':  # 帶泛音、快速衰減，像鋼琴
        x = sum(np.sin(ph * k) * (0.6 ** (k - 1)) * np.exp(-t * (1.5 + k)) for k in range(1, 7))
        return x
    if kind == 'epiano':  # 電鋼琴：正弦＋輕微顫音
        return (np.sin(ph) + 0.25 * np.sin(ph * 2) * np.exp(-t * 4)) * (1 + 0.15 * np.sin(2 * np.pi * 5 * t))
    raise ValueError(kind)

class Track:
    def __init__(self, seconds):
        self.n = int(seconds * SR)
        self.L = np.zeros(self.n)
        self.R = np.zeros(self.n)
    def add(self, x, start, gain=1.0, pan=0.0):
        i = int(start * SR) % self.n
        x = x * gain
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        end = i + len(x)
        if end <= self.n:
            self.L[i:end] += x * l; self.R[i:end] += x * r
        else:  # 超出尾巴的部分繞回開頭，讓循環無縫
            k = self.n - i
            self.L[i:] += x[:k] * l; self.R[i:] += x[:k] * r
            self.L[:end - self.n] += x[k:] * l; self.R[:end - self.n] += x[k:] * r

def note(f, dur, kind, a=0.005, d=0.25, s=0.5, r=0.08, detune=0.0, cut=None):
    n = int((dur + r) * SR)
    x = osc(f, n, kind) if not detune else (osc(f, n, kind, -detune) + osc(f, n, kind, detune)) / 2
    if cut: x = lowpass(x, cut)
    return x * env(n, a, d, s, r, hold=dur)

def kick(punch=1.0):
    n = int(0.35 * SR); t = np.arange(n) / SR
    f = 50 + 90 * np.exp(-t * 30) * punch
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)

def snare():
    n = int(0.22 * SR); t = np.arange(n) / SR
    return (highpass(rng.standard_normal(n), 1500) * 0.6 + np.sin(2 * np.pi * 190 * t) * 0.4) * np.exp(-t * 18)

def hat(open_=False):
    n = int((0.25 if open_ else 0.05) * SR); t = np.arange(n) / SR
    return highpass(rng.standard_normal(n), 7000) * np.exp(-t * (12 if open_ else 60)) * 0.5

def clap():
    n = int(0.2 * SR); t = np.arange(n) / SR
    x = highpass(rng.standard_normal(n), 1000)
    e = sum(np.exp(-np.clip(t - d, 0, None) * 40) * (t >= d) for d in (0, 0.01, 0.02))
    return x * e * 0.5

def tom(f):
    n = int(0.5 * SR); t = np.arange(n) / SR
    return np.sin(2 * np.pi * np.cumsum(f * (1 + 0.5 * np.exp(-t * 20))) / SR) * np.exp(-t * 6)

def reverb(L, R, mix=0.2, decay=1.6):
    n = int(decay * SR); t = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-t * 4 / decay)
    ir = lowpass(ir, 5000)
    ir /= np.sqrt((ir ** 2).sum())
    def wet(x):  # 循環卷積：殘響尾巴繞回開頭
        X = np.fft.rfft(x); H = np.fft.rfft(ir, len(x))
        return np.fft.irfft(X * H, len(x))
    return L + mix * wet(L), R + mix * wet(R)

def chord_notes(root, quality, octave):
    iv = {'maj': [0, 4, 7], 'min': [0, 3, 7], 'maj7': [0, 4, 7, 11], 'min7': [0, 3, 7, 10], '7': [0, 4, 7, 10], 'sus2': [0, 2, 7], 'add9': [0, 4, 7, 14]}[quality]
    base = hz(root, octave)
    return [base * 2 ** (i / 12) for i in iv]

def finish(name, L, R, title):
    L, R = reverb(L, R)
    peak = max(np.abs(L).max(), np.abs(R).max())
    st = np.stack([L, R], 1) / peak * 0.8
    with tempfile.TemporaryDirectory() as d:
        w = os.path.join(d, 'x.wav')
        wavfile.write(w, SR, (st * 32767).astype(np.int16))
        out = os.path.join(OUT, f'{name}.mp3')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', w, '-af', 'loudnorm=I=-18:TP=-2:LRA=9', '-ar', '44100',
                        '-b:a', '128k', '-metadata', f'title={title}', out], check=True)
    print('wrote', out)

def song(name, title, bpm, prog, bars_per_chord, build):
    beat = 60 / bpm
    bar = beat * 4
    total_bars = max(1, round(60 / bar / (len(prog) * bars_per_chord))) * len(prog) * bars_per_chord
    tr = Track(total_bars * bar)
    for b in range(total_bars):
        ch = prog[(b // bars_per_chord) % len(prog)]
        build(tr, b, b * bar, beat, ch, total_bars)
    finish(name, tr.L, tr.R, title)

# 1 輕快流行
def pop(tr, b, t0, beat, ch, total):
    root, q = ch
    for i in range(4):
        tr.add(kick(), t0 + i * beat, 0.9)
        tr.add(hat(), t0 + i * beat + beat / 2, 0.35, 0.3)
    tr.add(clap(), t0 + beat, 0.5); tr.add(clap(), t0 + 3 * beat, 0.5)
    bass = hz(root, 2)
    for i in range(8):
        tr.add(note(bass, beat * 0.4, 'tri', d=0.1, s=0.6, cut=900), t0 + i * beat / 2, 0.55)
    notes = chord_notes(root, q, 4)
    for i in range(4):  # 切分和弦
        for f in notes:
            tr.add(note(f, beat * 0.3, 'square', d=0.08, s=0.2, cut=2500), t0 + i * beat + beat / 2, 0.09, rng.uniform(-0.4, 0.4))
    arp = notes + [notes[0] * 2]
    for i in range(8):
        tr.add(note(arp[i % len(arp)] * 2, beat * 0.25, 'sine', d=0.1, s=0.2), t0 + i * beat / 2, 0.12, 0.5 if i % 2 else -0.5)

# 2 溫馨鋼琴
def piano(tr, b, t0, beat, ch, total):
    root, q = ch
    notes = chord_notes(root, q, 3)
    tr.add(note(hz(root, 2), beat * 3.5, 'piano', d=1.5, s=0.0, r=0.6), t0, 0.5)
    pattern = [0, 2, 1, 3, 2, 1, 3, 2]
    for i, k in enumerate(pattern):
        f = notes[k % len(notes)] * (2 if k >= len(notes) else 1)
        tr.add(note(f * 2, beat * 1.2, 'piano', d=1.2, s=0.0, r=0.5), t0 + i * beat / 2, 0.32, -0.2 + 0.05 * i)
    if b % 2 == 0:
        mel = chord_notes(root, q, 5)
        tr.add(note(mel[-1], beat * 2, 'piano', d=1.6, s=0.0, r=0.8), t0 + beat * 2, 0.22, 0.3)
    for f in notes:  # 柔和襯底
        tr.add(note(f, beat * 4, 'sine', a=0.8, d=1, s=0.8, r=0.8), t0, 0.04)

# 3 科技電子
def tech(tr, b, t0, beat, ch, total):
    root, q = ch
    for i in range(4):
        tr.add(kick(1.3), t0 + i * beat, 1.0)
        tr.add(hat(open_=True), t0 + i * beat + beat / 2, 0.25, 0.2)
        for j in range(4):
            tr.add(hat(), t0 + i * beat + j * beat / 4, 0.12, -0.3)
    tr.add(clap(), t0 + beat, 0.4); tr.add(clap(), t0 + 3 * beat, 0.4)
    bass = hz(root, 1)
    for i in range(16):
        if i % 4 == 0: continue
        tr.add(note(bass * (2 if i % 8 == 7 else 1), beat * 0.2, 'saw', d=0.05, s=0.3, cut=600 + 300 * (b % 4)), t0 + i * beat / 4, 0.35)
    notes = chord_notes(root, q, 4)
    for i in range(16):
        tr.add(note(notes[i % len(notes)] * (2 if i % 8 >= 4 else 1), beat * 0.2, 'saw', d=0.05, s=0.1, cut=3000, detune=0.004), t0 + i * beat / 4, 0.06, 0.6 if i % 2 else -0.6)
    for f in notes:
        tr.add(note(f / 2, beat * 4, 'saw', a=0.3, d=1, s=0.7, r=0.3, detune=0.006, cut=1200), t0, 0.04)

# 4 輕鬆 Lo-fi
def lofi(tr, b, t0, beat, ch, total):
    root, q = ch
    sw = beat * 0.58  # 搖擺拍
    tr.add(kick(0.7), t0, 0.7); tr.add(kick(0.7), t0 + 2.5 * beat, 0.55)
    tr.add(snare(), t0 + beat, 0.35); tr.add(snare(), t0 + 3 * beat, 0.35)
    for i in range(4):
        tr.add(hat(), t0 + i * beat, 0.18, 0.3); tr.add(hat(), t0 + i * beat + sw, 0.12, 0.3)
    notes = chord_notes(root, q, 3)
    for f in notes:
        tr.add(note(f, beat * 3.6, 'epiano', a=0.01, d=1.2, s=0.4, r=0.4, cut=1800), t0, 0.12, rng.uniform(-0.3, 0.3))
    tr.add(note(hz(root, 2), beat * 1.5, 'sine', d=0.6, s=0.5), t0, 0.45)
    tr.add(note(hz(root, 2) * 1.5, beat * 1.0, 'sine', d=0.6, s=0.5), t0 + 2.5 * beat, 0.35)
    if b % 2 == 1:
        mel = chord_notes(root, q, 5)
        for i, f in enumerate(mel[:3]):
            tr.add(note(f, beat * 0.6, 'epiano', d=0.5, s=0.2, cut=2500), t0 + (1 + i) * beat, 0.1, 0.4)
    n = int(beat * 4 * SR)  # 黑膠底噪
    crackle = highpass(rng.standard_normal(n), 3000) * 0.01 * (rng.random(n) > 0.9993) * 8
    tr.add(crackle + lowpass(rng.standard_normal(n), 800) * 0.003, t0, 1.0)

# 5 激昂熱血
def epic(tr, b, t0, beat, ch, total):
    root, q = ch
    tr.add(kick(1.2), t0, 1.0); tr.add(kick(1.2), t0 + 2 * beat, 0.9)
    tr.add(snare(), t0 + beat, 0.5); tr.add(snare(), t0 + 3 * beat, 0.5)
    for i, f in enumerate([110, 98, 87, 82]):
        tr.add(tom(f), t0 + 3 * beat + i * beat / 4, 0.35 if b % 4 == 3 else 0.0)
    notes = chord_notes(root, q, 3)
    for f in notes + [notes[0] * 2]:  # 弦樂襯底
        tr.add(note(f, beat * 4, 'saw', a=0.4, d=1, s=0.8, r=0.5, detune=0.005, cut=1800), t0, 0.06, rng.uniform(-0.6, 0.6))
    for i in range(8):  # 頑固低音
        tr.add(note(hz(root, 2), beat * 0.4, 'saw', d=0.1, s=0.5, cut=500), t0 + i * beat / 2, 0.3)
    for i in range(8):
        tr.add(note(notes[i % 3] * 2, beat * 0.4, 'saw', d=0.08, s=0.3, cut=2500, detune=0.003), t0 + i * beat / 2, 0.07, 0.5 if i % 2 else -0.5)
    if b % 2 == 0:
        tr.add(note(notes[-1] * 4, beat * 2, 'tri', a=0.05, d=1, s=0.6, r=0.6), t0, 0.08)


# ---------- 撥弦（Karplus-Strong）：古箏、木吉他 ----------
def pluck(f, dur, bright=0.5, decay=0.996):
    n = int((dur + 1.5) * SR)
    N = max(2, int(SR / f))
    y = np.zeros(n)
    burst = rng.uniform(-1, 1, N)
    burst = lowpass(burst, 2000 + 6000 * bright) if N > 12 else burst
    y[:N] = burst
    i = N
    while i < n:
        prev = y[i - N:i]
        blk = decay * 0.5 * (prev + np.roll(prev, 1))
        k = min(N, n - i)
        y[i:i + k] = blk[:k]
        i += k
    t = np.arange(n) / SR
    return y * np.exp(-t * 0.6) * np.clip(1 - (t - dur - 1.2) / 0.3, 0, 1)

PENTA = [0, 2, 4, 7, 9]  # 五聲音階
def penta_note(root, step, octave):
    o, k = divmod(step, 5)
    return hz(root, octave + o) * 2 ** (PENTA[k] / 12)

# 1 琴音（古箏風）：五聲音階、慢板、句尾刮奏
QIN_PHRASES = [[0, 2, 4, 3, 2, 1, 0, None], [2, 4, 5, 7, 5, 4, 2, None], [4, 3, 2, 0, 1, 2, 4, None], [5, 4, 2, 1, 0, -1, 0, None]]
def qin(tr, b, t0, beat, ch, total):
    ph = QIN_PHRASES[b % len(QIN_PHRASES)]
    for i, st in enumerate(ph):
        if st is None:
            # 刮奏：快速上行
            for k in range(8):
                tr.add(pluck(penta_note('D', k, 4), 0.4, 0.7), t0 + i * beat / 2 + k * 0.045, 0.16, -0.3 + 0.08 * k)
            continue
        f = penta_note('D', st + 5, 3)
        tr.add(pluck(f, beat * 0.9, 0.6), t0 + i * beat / 2, 0.42, 0.15)
        if i % 2 == 0:
            tr.add(pluck(f * 2, beat * 0.5, 0.4, 0.993), t0 + i * beat / 2 + beat / 4, 0.12, 0.35)
    # 低音
    tr.add(pluck(hz('D', 2), beat * 3.5, 0.3, 0.998), t0, 0.35, -0.2)
    tr.add(pluck(hz('A', 2), beat * 1.5, 0.3, 0.998), t0 + beat * 2, 0.25, -0.2)
    # 柔和襯底
    for f in (hz('D', 3), hz('A', 3)):
        tr.add(note(f, beat * 4, 'sine', a=1.0, d=1, s=0.8, r=1.0), t0, 0.035)

# 2 長笛：氣音＋顫音的旋律，弦樂襯底
FLUTE_MELODY = [
    [(0, 'A', 5, 1.5), (1.5, 'G', 5, 0.5), (2, 'F', 5, 1), (3, 'C', 5, 1)],
    [(0, 'D', 5, 1), (1, 'F', 5, 1), (2, 'A', 5, 2)],
    [(0, 'Bb', 5, 1.5), (1.5, 'A', 5, 0.5), (2, 'G', 5, 1), (3, 'F', 5, 1)],
    [(0, 'E', 5, 1), (1, 'G', 5, 1), (2, 'C', 6, 2)],
]
def flute_tone(f, dur):
    n = int((dur + 0.3) * SR); t = np.arange(n) / SR
    vib = 1 + 0.006 * np.sin(2 * np.pi * 5.2 * t) * np.clip((t - 0.25) / 0.4, 0, 1)
    ph = 2 * np.pi * np.cumsum(f * vib) / SR
    tone = np.sin(ph) + 0.18 * np.sin(2 * ph) + 0.05 * np.sin(3 * ph)
    breath = lowpass(highpass(rng.standard_normal(n), 1800), 5000) * 0.02 * np.clip(1 - t / 0.6, 0.3, 1)
    e = np.clip(t / 0.08, 0, 1) * np.clip((dur + 0.25 - t) / 0.3, 0, 1)
    return (tone + breath) * e
def flute(tr, b, t0, beat, ch, total):
    root, q = ch
    for (st, nm, octv, d) in FLUTE_MELODY[b % len(FLUTE_MELODY)]:
        tr.add(flute_tone(hz(nm, octv), d * beat * 0.95), t0 + st * beat, 0.30, 0.1)
    for f in chord_notes(root, q, 3):
        tr.add(note(f, beat * 4, 'saw', a=0.8, d=1, s=0.8, r=0.8, detune=0.004, cut=1200), t0, 0.045, rng.uniform(-0.5, 0.5))
    tr.add(note(hz(root, 2), beat * 4, 'sine', a=0.3, d=1, s=0.7, r=0.6), t0, 0.25)
    for i in range(4):  # 輕柔撥弦
        tr.add(pluck(chord_notes(root, q, 4)[i % 3], beat * 0.8, 0.3), t0 + i * beat, 0.09, -0.4)

# 4 木吉他：指彈分解和弦
def guitar(tr, b, t0, beat, ch, total):
    root, q = ch
    notes = chord_notes(root, q, 3)
    bass = hz(root, 2)
    pattern = [bass, notes[1], notes[2] * 2 if False else notes[2], notes[0] * 2, bass * 1.5, notes[2], notes[1] * 2, notes[2]]
    for i, f in enumerate(pattern):
        tr.add(pluck(f, beat * 1.2, 0.45, 0.997), t0 + i * beat / 2, 0.30 if i % 4 == 0 else 0.22, -0.2 + 0.05 * i)
    if b % 2 == 1:
        for k, f in enumerate(chord_notes(root, q, 4)):  # 偶爾刷和弦
            tr.add(pluck(f, beat, 0.6), t0 + 3 * beat + k * 0.02, 0.12, 0.3)
    tr.add(note(hz(root, 3), beat * 4, 'sine', a=0.8, d=1, s=0.7, r=0.8), t0, 0.03)

import sys
WHICH = set(sys.argv[1:])  # 不帶參數＝全部重做
def want(n): return not WHICH or n in WHICH
if want('pop'): song('pop', '輕快流行', 112, [('C', 'maj'), ('G', 'maj'), ('A', 'min'), ('F', 'maj')], 1, pop)
if want('piano'): song('piano', '鋼琴', 76, [('F', 'maj7'), ('A', 'min7'), ('D', 'min7'), ('Bb', 'maj7')], 1, piano)
if want('qin'): song('qin', '琴音（古箏）', 66, [('D', 'maj')], 1, qin)
if want('flute'): song('flute', '長笛', 70, [('F', 'maj'), ('D', 'min'), ('Bb', 'maj'), ('C', 'maj')], 1, flute)
if want('guitar'): song('guitar', '木吉他', 84, [('C', 'maj'), ('G', 'maj'), ('A', 'min'), ('F', 'maj')], 1, guitar)
if want('tech'): song('tech', '科技電子', 124, [('A', 'min'), ('F', 'maj'), ('C', 'maj'), ('G', 'maj')], 2, tech)
if want('lofi'): song('lofi', '輕鬆 Lo-fi', 80, [('D', 'min7'), ('G', '7'), ('C', 'maj7'), ('A', 'min7')], 1, lofi)
if want('epic'): song('epic', '激昂熱血', 96, [('A', 'min'), ('F', 'maj'), ('C', 'maj'), ('G', 'maj')], 1, epic)
