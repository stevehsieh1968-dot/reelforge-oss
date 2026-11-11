@echo off
chcp 65001 >nul
title 上傳 reelforge-oss 到 GitHub
cd /d "%~dp0"
echo 準備上傳到 https://github.com/stevehsieh1968-dot/reelforge-oss （請先確認已在 GitHub 建好這個空的 repo）
pause

git config --global user.email >nul 2>&1 || git config --global user.email "stevehsieh1968@gmail.com"
git config --global user.name >nul 2>&1 || git config --global user.name "Steve Hsieh"
if not exist .git (
  git init -b main
  git add -A
  git commit -m "reelforge-oss：開源省錢版（Pexels 影片庫、本機配音、可切換 Gemini）"
)
git remote remove origin >nul 2>&1
git remote add origin https://github.com/stevehsieh1968-dot/reelforge-oss.git
git push -u origin main
if errorlevel 1 (
  echo [錯誤] 上傳失敗：請確認上面已建立 reelforge-oss，並在跳出的視窗登入 GitHub。
) else (
  echo.
  echo ==== 上傳完成：https://github.com/stevehsieh1968-dot/reelforge-oss ====
)
pause
