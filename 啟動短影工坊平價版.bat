@echo off
chcp 65001 >nul
title 短影工坊 平價版
cd /d "%~dp0"
echo ============================================================
echo   短影工坊 平價版：安裝、設定、啟動 一次完成
echo ============================================================
taskkill /f /im node.exe >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq ReelForge-TTS*" >nul 2>&1

rem ===== 1. 檢查基本工具（沒有就用 winget 安裝） =====
set NEED_RESTART=
where node >nul 2>&1 || (
  echo [安裝] Node.js ...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  set NEED_RESTART=1
)
where ffmpeg >nul 2>&1 || (
  echo [安裝] FFmpeg ...
  winget install -e --id Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements
  set NEED_RESTART=1
)
set PY=
where py >nul 2>&1 && set PY=py -3
if not defined PY (where python >nul 2>&1 && python -c "import sys" >nul 2>&1 && set PY=python)
if not defined PY (
  echo [安裝] Python ...
  winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
  set NEED_RESTART=1
)
if defined NEED_RESTART (
  echo.
  echo [完成安裝] 請「關掉這個視窗」，再雙擊一次 啟動短影工坊平價版.bat（讓新安裝的工具生效）。
  pause
  exit /b 0
)

rem ===== 2. 檢查更新（從 GitHub 下載的才會有 .git） =====
if exist .git (
  echo 檢查更新...
  git pull --ff-only >nul 2>&1
  if errorlevel 1 (echo [略過更新] 離線或有本機修改，使用目前版本。) else (echo 已是最新版。)
)

rem ===== 3. 安裝套件 =====
echo 檢查程式套件...
call npm install --no-audit --no-fund --loglevel=error
if not exist tts-server\.venv\Scripts\python.exe (
  echo [安裝] 本機配音服務（第一次約 1 分鐘）...
  %PY% -m venv tts-server\.venv
)
tts-server\.venv\Scripts\python.exe -c "import edge_tts" >nul 2>&1
if errorlevel 1 (
  tts-server\.venv\Scripts\python.exe -m pip install -q --disable-pip-version-check -r tts-server\requirements.txt
  if errorlevel 1 (
    echo [錯誤] 配音服務安裝失敗，請把上面的訊息複製給 Claude。
    pause
    exit /b 1
  )
)

rem ===== 4. 設定檔 .env：沒有就建立；舊版自動升級（保留已填的金鑰） =====
if not exist .env copy .env.example .env >nul
findstr /b /c:"PIXABAY_API_KEY=" .env >nul
if errorlevel 1 (
  copy /y .env .env.bak >nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = Get-Content '.env' -Encoding UTF8; $t = $t -replace '^VIDEO_PROVIDER=pexels$','VIDEO_PROVIDER=pixabay' -replace '^IMAGE_PROVIDER=pexels$','IMAGE_PROVIDER=pixabay' -replace '^PEXELS_REPLACE_UPLOADS=','STOCK_REPLACE_UPLOADS='; $t += ''; $t += '# Pixabay free API key: https://pixabay.com/api/docs/'; $t += 'PIXABAY_API_KEY='; [IO.File]::WriteAllLines((Resolve-Path '.env').Path, [string[]]$t, (New-Object Text.UTF8Encoding $false))"
  echo [設定檔已升級] 改用 Pixabay 免費影片庫，舊設定備份在 .env.bak
)
set NEEDKEY=
findstr /x /c:"TEXT_PROVIDER=gemini" .env >nul && findstr /x /c:"GEMINI_API_KEY=" .env >nul && set NEEDKEY=1
findstr /x /c:"VIDEO_PROVIDER=pixabay" .env >nul && findstr /x /c:"PIXABAY_API_KEY=" .env >nul && set NEEDKEY=1
if defined NEEDKEY (
  echo.
  echo [請先填金鑰] 記事本會打開 .env，請填入：
  echo     GEMINI_API_KEY=   到 https://aistudio.google.com/apikey 取得
  echo     PIXABAY_API_KEY=  到 https://pixabay.com/api/docs/ 登入後取得
  echo   存檔、關掉記事本後，再雙擊一次 啟動短影工坊平價版.bat
  notepad .env
  pause
  exit /b 0
)

rem ===== 5. 啟動 =====
echo 啟動本機配音服務...
start "ReelForge-TTS" /min tts-server\.venv\Scripts\python.exe tts-server\server.py
echo.
echo ==== 短影工坊 平價版 啟動中，請不要關閉這個視窗 ====
echo ==== 關閉這個視窗就會停止 ====
echo.
start "" cmd /c "timeout /t 5 >nul & start http://localhost:3000"
call npm start
echo.
echo [短影工坊 平價版已停止] 如果上面有紅色錯誤訊息，請複製給 Claude。
pause
