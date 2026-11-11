"""
短影工坊 本機配音服務（免費）

兩種引擎（在 reelforge-oss\\.env 設定 TTS_ENGINE）：
  edge    微軟 Edge 線上語音（edge-tts），台灣國語，免費、不用顯卡。預設。
  breezy  聯發科 BreezyVoice（開源、台灣國語、可複製說書人聲音），在本機跑，
          需要另外安裝（見 README），3050 顯卡或 CPU 都能跑，CPU 比較慢。

API（給 Node 主程式呼叫）：
  GET  /health                      目前引擎狀態
  POST /tts     {text, voice}       回傳 WAV／MP3 音檔
  POST /voices  {name, source, transcript}   建立複製聲音（source 是 base64 WAV），回傳 {id}
"""
import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
VOICE_DIR = Path(os.environ.get("TTS_VOICE_DIR") or (ROOT / "data" / "voices"))


def load_env():
    """讀 reelforge-oss\\.env（只取簡單的 KEY=VALUE）"""
    env = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    env.update({k: v for k, v in os.environ.items() if k.startswith(("TTS_", "BREEZY_"))})
    return env


ENV = load_env()
ENGINE = (ENV.get("TTS_ENGINE") or "edge").lower()
PORT = int(ENV.get("TTS_PORT") or 5100)
HOST = ENV.get("TTS_HOST") or "127.0.0.1"
BREEZY_DIR = Path(ENV.get("BREEZY_DIR") or (ROOT / "BreezyVoice"))
BREEZY_PYTHON = ENV.get("BREEZY_PYTHON") or str(BREEZY_DIR / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))

# 內建聲線：Edge 台灣國語聲音＋語速／音高
#（breezy 引擎會先用這個聲音唸一段參考句，再交給 BreezyVoice 模仿，聲音更自然）
EDGE_VOICES = {
    "female-warm": ("zh-TW-HsiaoChenNeural", "-5%", "+0Hz"),
    "female-bright": ("zh-TW-HsiaoYuNeural", "+5%", "+0Hz"),
    "male-calm": ("zh-TW-YunJheNeural", "-5%", "-2Hz"),
    "male-upbeat": ("zh-TW-YunJheNeural", "+10%", "+3Hz"),
    # 內建說書人
    "local_preset_story-female": ("zh-TW-HsiaoChenNeural", "-12%", "-2Hz"),
    "local_preset_story-male": ("zh-TW-YunJheNeural", "-12%", "-4Hz"),
    "local_preset_bright-female": ("zh-TW-HsiaoYuNeural", "+0%", "+0Hz"),
    "local_preset_elder-male": ("zh-TW-YunJheNeural", "-20%", "-8Hz"),
}
REF_TEXT = "大家好，歡迎收看今天的影片。接下來我會用簡單的方式，跟你分享一個實用又溫暖的小故事，希望你會喜歡。"

breezy_lock = threading.Lock()  # 顯卡只有 4GB：一次只跑一句


class UserError(Exception):
    pass


def ffmpeg(*args):
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("找不到 FFmpeg，請先安裝：winget install Gyan.FFmpeg")
    r = subprocess.run([exe, "-y", "-loglevel", "error", *args], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "ignore")[-500:])


# ---------------- Edge ----------------
def edge_tts_file(text, voice_key, out_mp3):
    try:
        import edge_tts
    except ImportError:
        raise RuntimeError("沒有安裝 edge-tts，請重新執行「啟動短影工坊平價版.bat」")
    name, rate, pitch = EDGE_VOICES.get(voice_key) or EDGE_VOICES["female-warm"]

    async def go():
        await edge_tts.Communicate(text, name, rate=rate, pitch=pitch).save(str(out_mp3))

    last = None
    for _ in range(3):
        try:
            asyncio.run(go())
            if Path(out_mp3).stat().st_size > 0:
                return
        except Exception as e:  # 網路不穩時重試
            last = e
    raise RuntimeError(f"Edge 語音失敗（需要網路）：{last}")


# ---------------- BreezyVoice ----------------
def breezy_ready():
    return (BREEZY_DIR / "single_inference.py").exists() and Path(BREEZY_PYTHON).exists()


def builtin_ref(voice_key):
    """內建聲線的參考音檔（第一次用時由 Edge 唸出來，之後重複使用）"""
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    wav = VOICE_DIR / f"ref-{voice_key}.wav"
    if not wav.exists():
        with tempfile.TemporaryDirectory() as td:
            mp3 = Path(td) / "ref.mp3"
            edge_tts_file(REF_TEXT, voice_key, mp3)
            ffmpeg("-i", str(mp3), "-ar", "16000", "-ac", "1", str(wav))
    return wav, REF_TEXT


def clone_ref(voice_id):
    wav = VOICE_DIR / f"{voice_id}.wav"
    if not wav.exists():
        raise UserError("找不到這個複製聲音的樣本，請在品牌設定重新錄一次")
    txt = VOICE_DIR / f"{voice_id}.txt"
    return wav, (txt.read_text(encoding="utf-8").strip() if txt.exists() else "")


def breezy_tts_file(text, voice_key, out_wav):
    if not breezy_ready():
        raise UserError(f"還沒安裝 BreezyVoice（找不到 {BREEZY_DIR}\\single_inference.py），請執行「安裝BreezyVoice.bat」，或把 TTS_ENGINE 改成 edge")
    ref, transcript = clone_ref(voice_key) if voice_key.startswith("local_clone_") else builtin_ref(voice_key)
    cmd = [
        BREEZY_PYTHON, "single_inference.py",
        "--content_to_synthesize", text,
        "--speaker_prompt_audio_path", str(ref),
        "--output_path", str(out_wav),
    ]
    if transcript:  # 沒有逐字稿時，BreezyVoice 會自己用 Whisper 聽寫
        cmd += ["--speaker_prompt_text_transcription", transcript]
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    with breezy_lock:
        r = subprocess.run(cmd, cwd=str(BREEZY_DIR), env=env, capture_output=True, timeout=900)
    if r.returncode != 0 or not Path(out_wav).exists():
        err = (r.stderr or r.stdout).decode("utf-8", "ignore")[-800:]
        raise RuntimeError(f"BreezyVoice 失敗：{err}")


# ---------------- 對外 ----------------
def synthesize(text, voice_key):
    """回傳 (bytes, mime)"""
    text = (text or "").strip()
    if not text:
        raise UserError("沒有要唸的文字")
    with tempfile.TemporaryDirectory() as td:
        if ENGINE == "breezy":
            out = Path(td) / "out.wav"
            try:
                breezy_tts_file(text, voice_key, out)
                return out.read_bytes(), "audio/wav"
            except UserError:
                raise
            except Exception as e:
                if voice_key.startswith("local_clone_"):
                    raise
                print(f"[tts] BreezyVoice 失敗，這句改用 Edge：{e}", flush=True)
        if voice_key.startswith("local_clone_"):
            raise UserError("「說書人自己的聲音」需要 BreezyVoice：請在 .env 設 TTS_ENGINE=breezy 並安裝 BreezyVoice，或改選內建聲線")
        out = Path(td) / "out.mp3"
        edge_tts_file(text, voice_key, out)
        return out.read_bytes(), "audio/mpeg"


def create_voice(name, source_b64, transcript):
    if ENGINE != "breezy":
        raise UserError("複製說書人的聲音需要 BreezyVoice：請在 .env 設 TTS_ENGINE=breezy，並執行「安裝BreezyVoice.bat」")
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    vid = f"local_clone_{uuid.uuid4().hex[:12]}"
    raw = VOICE_DIR / f"{vid}.in.wav"
    raw.write_bytes(base64.b64decode(source_b64))
    # BreezyVoice 的參考音建議 5–15 秒：取前 15 秒、16kHz 單聲道
    ffmpeg("-i", str(raw), "-t", "15", "-ar", "16000", "-ac", "1", str(VOICE_DIR / f"{vid}.wav"))
    raw.unlink(missing_ok=True)
    if transcript:
        (VOICE_DIR / f"{vid}.txt").write_text(transcript, encoding="utf-8")
    (VOICE_DIR / f"{vid}.json").write_text(json.dumps({"name": name}, ensure_ascii=False), encoding="utf-8")
    return vid


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, mime="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
            mime = "text/plain; charset=utf-8"
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "engine": ENGINE, "breezyInstalled": breezy_ready(), "voices": list(EDGE_VOICES)})
        self._send(404, "not found")

    def do_POST(self):
        try:
            if self.path.startswith("/tts"):
                b = self._json()
                data, mime = synthesize(b.get("text"), b.get("voice") or "female-warm")
                return self._send(200, data, mime)
            if self.path.startswith("/voices"):
                b = self._json()
                if not b.get("source"):
                    raise UserError("沒有聲音樣本")
                return self._send(200, {"id": create_voice(b.get("name") or "說書人", b["source"], b.get("transcript") or "")})
            self._send(404, "not found")
        except UserError as e:
            self._send(400, str(e))
        except Exception as e:
            traceback.print_exc()
            self._send(500, str(e))

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        data, mime = synthesize("你好，這是配音測試。", "female-warm")
        print("ok", mime, len(data))
        sys.exit(0)
    print(f"本機配音服務已啟動：http://{HOST}:{PORT}  引擎：{ENGINE}" + ("（BreezyVoice 已安裝）" if breezy_ready() else ""), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
