@echo off
chcp 65001 >nul
title ReelForge OSS
cd /d "%~dp0"
taskkill /f /im node.exe >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq ReelForge-TTS*" >nul 2>&1

if exist .git (
  echo 檢查更新...
  git pull --ff-only >nul 2>&1
  if errorlevel 1 (echo [略過更新] 離線或有本機修改，使用目前版本。) else (echo 已是最新版。)
)

call npm install --no-audit --no-fund --loglevel=error
if not exist .env copy .env.example .env >nul

rem ---- 舊版設定檔自動升級：保留已填的金鑰，Pexels 改成 Pixabay、補上 PIXABAY_API_KEY ----
findstr /b /c:"PIXABAY_API_KEY=" .env >nul
if errorlevel 1 (
  copy /y .env .env.bak >nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = Get-Content '.env' -Encoding UTF8; $t = $t -replace '^VIDEO_PROVIDER=pexels$','VIDEO_PROVIDER=pixabay' -replace '^IMAGE_PROVIDER=pexels$','IMAGE_PROVIDER=pixabay' -replace '^PEXELS_REPLACE_UPLOADS=','STOCK_REPLACE_UPLOADS='; $t += ''; $t += '# Pixabay free API key: https://pixabay.com/api/docs/'; $t += 'PIXABAY_API_KEY='; [IO.File]::WriteAllLines((Resolve-Path '.env').Path, [string[]]$t, (New-Object Text.UTF8Encoding $false))"
  echo [設定檔已升級] 改用 Pixabay 免費影片庫，舊設定備份在 .env.bak
)

rem ---- 還沒填金鑰：打開記事本 ----
set NEEDKEY=
findstr /x /c:"TEXT_PROVIDER=gemini" .env >nul && findstr /x /c:"GEMINI_API_KEY=" .env >nul && set NEEDKEY=1
findstr /x /c:"VIDEO_PROVIDER=pixabay" .env >nul && findstr /x /c:"PIXABAY_API_KEY=" .env >nul && set NEEDKEY=1
if defined NEEDKEY (
  echo.
  echo [請先填金鑰] 用記事本打開 .env，填入 GEMINI_API_KEY 和 PIXABAY_API_KEY，存檔後再執行一次。
  notepad .env
  pause
  exit /b 0
)

if exist tts-server\.venv\Scripts\python.exe (
  echo 啟動本機配音服務...
  start "ReelForge-TTS" /min tts-server\.venv\Scripts\python.exe tts-server\server.py
) else (
  echo [提醒] 還沒安裝本機配音服務，請先執行「安裝配音服務.bat」（或在 .env 設 TTS_PROVIDER=gemini）
)

echo.
echo ==== 短影工坊（開源省錢版）啟動中，請不要關閉這個視窗 ====
echo ==== 關閉這個視窗就會停止 ====
echo.
start "" cmd /c "timeout /t 5 >nul & start http://localhost:3000"
call npm start
echo.
echo [短影工坊已停止] 如果上面有紅色錯誤訊息，請複製給 Claude。
pause
