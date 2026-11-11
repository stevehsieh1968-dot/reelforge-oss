@echo off
chcp 65001 >nul
title 安裝本機配音服務
cd /d "%~dp0"

set PY=
where py >nul 2>&1 && set PY=py -3
if "%PY%"=="" (where python >nul 2>&1 && set PY=python)
if "%PY%"=="" (
  echo [錯誤] 找不到 Python。請先安裝：winget install Python.Python.3.12
  pause
  exit /b 1
)

echo 建立配音服務的 Python 環境...
if not exist tts-server\.venv %PY% -m venv tts-server\.venv
tts-server\.venv\Scripts\python.exe -m pip install --upgrade pip -q
tts-server\.venv\Scripts\python.exe -m pip install -r tts-server\requirements.txt -q
if errorlevel 1 (
  echo [錯誤] 安裝失敗，請把上面的訊息複製給 Claude。
  pause
  exit /b 1
)

echo.
echo 測試配音（需要網路）...
tts-server\.venv\Scripts\python.exe tts-server\server.py --selftest
if errorlevel 1 (
  echo [錯誤] 配音測試失敗，請把上面的訊息複製給 Claude。
) else (
  echo.
  echo ==== 安裝完成！之後執行「啟動短影工坊.bat」就會自動啟動配音服務 ====
)
pause
