@echo off
chcp 65001 >nul
title 安裝 BreezyVoice（進階，選用）
cd /d "%~dp0"
echo ============================================================
echo  BreezyVoice：聯發科開源台灣國語語音，可複製說書人的聲音。
echo  需要 Python 3.10、Git，約 5GB 空間，第一次會下載模型。
echo  官方以 Linux 為主，Windows 上如果失敗，可改用 WSL 或 Docker 安裝，
echo  或先用預設的 edge 引擎（不影響其他功能）。
echo ============================================================
pause

py -3.10 --version >nul 2>&1
if errorlevel 1 (
  echo [錯誤] 需要 Python 3.10：winget install Python.Python.3.10
  pause
  exit /b 1
)

if not exist BreezyVoice (
  git clone https://github.com/mtkresearch/BreezyVoice.git BreezyVoice
  if errorlevel 1 (echo [錯誤] 下載失敗 & pause & exit /b 1)
)
cd BreezyVoice
git submodule update --init --recursive

if not exist .venv py -3.10 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 (
  echo [錯誤] 套件安裝失敗，請把上面的訊息複製給 Claude。
  pause
  exit /b 1
)
rem 有 NVIDIA 顯卡：改用 GPU 版 onnxruntime
.venv\Scripts\python.exe -m pip uninstall -y onnxruntime
.venv\Scripts\python.exe -m pip install onnxruntime-gpu

echo.
echo 測試 BreezyVoice（第一次會下載模型，需要幾分鐘）...
set PYTHONUTF8=1
.venv\Scripts\python.exe single_inference.py --content_to_synthesize "你好，這是 BreezyVoice 測試。" --speaker_prompt_audio_path "./data/example.wav" --output_path "results/test.wav"
if errorlevel 1 (
  echo [錯誤] 測試失敗，請把上面的訊息複製給 Claude。
  pause
  exit /b 1
)
cd ..
echo.
echo ==== 安裝完成！請用記事本打開 .env，把 TTS_ENGINE=edge 改成 TTS_ENGINE=breezy ====
pause
