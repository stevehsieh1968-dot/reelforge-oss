@echo off
chcp 65001 >nul
title 安裝 SadTalker 免費對嘴（選用）
cd /d "%~dp0"
if not exist package.json (
  if exist "%USERPROFILE%\reelforge-oss\package.json" (cd /d "%USERPROFILE%\reelforge-oss") else (echo [錯誤] 找不到程式資料夾 & pause & exit /b 1)
)
echo ============================================================
echo  SadTalker：用一張說書人照片＋配音，做出會說話的畫面（免費、在你的電腦上跑）
echo  需要：NVIDIA 顯卡（4GB 以上）、Python 3.10、約 8GB 硬碟空間
echo  第一次安裝約 15–30 分鐘（要下載約 3GB），請保持網路連線
echo ============================================================
pause

py -3.10 --version >nul 2>&1
if errorlevel 1 (
  echo [安裝] Python 3.10 ...
  winget install -e --id Python.Python.3.10 --silent --accept-package-agreements --accept-source-agreements
  echo.
  echo [完成] 請關掉這個視窗，再執行一次 安裝SadTalker對嘴.bat
  pause
  exit /b 0
)

if not exist SadTalker (
  git clone --depth 1 https://github.com/OpenTalker/SadTalker.git SadTalker
  if errorlevel 1 (echo [錯誤] 下載 SadTalker 失敗 & pause & exit /b 1)
)
cd SadTalker

if not exist .venv py -3.10 -m venv .venv
set PYX=.venv\Scripts\python.exe
%PYX% -m pip install --upgrade pip -q
echo [1/3] 安裝 PyTorch（支援 NVIDIA 顯卡，約 2.5GB）...
%PYX% -m pip install torch==2.0.1 torchvision==0.15.2 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cu118
if errorlevel 1 (echo [錯誤] PyTorch 安裝失敗，請把上面的訊息複製給 Claude & pause & exit /b 1)

echo [2/3] 安裝其他套件...
findstr /v /i "gradio" requirements.txt > requirements-reelforge.txt
%PYX% -m pip install -r requirements-reelforge.txt
if errorlevel 1 (echo [錯誤] 套件安裝失敗，請把上面的訊息複製給 Claude & pause & exit /b 1)

echo [3/3] 下載模型...
if not exist checkpoints mkdir checkpoints
if not exist gfpgan\weights mkdir gfpgan\weights
set R=https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc
set FX=https://github.com/xinntao/facexlib/releases/download
call :get checkpoints\mapping_00109-model.pth.tar %R%/mapping_00109-model.pth.tar || goto dlfail
call :get checkpoints\mapping_00229-model.pth.tar %R%/mapping_00229-model.pth.tar || goto dlfail
call :get checkpoints\SadTalker_V0.0.2_256.safetensors %R%/SadTalker_V0.0.2_256.safetensors || goto dlfail
call :get checkpoints\SadTalker_V0.0.2_512.safetensors %R%/SadTalker_V0.0.2_512.safetensors || goto dlfail
call :get gfpgan\weights\alignment_WFLW_4HG.pth %FX%/v0.1.0/alignment_WFLW_4HG.pth || goto dlfail
call :get gfpgan\weights\detection_Resnet50_Final.pth %FX%/v0.1.0/detection_Resnet50_Final.pth || goto dlfail
call :get gfpgan\weights\GFPGANv1.4.pth https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth || goto dlfail
call :get gfpgan\weights\parsing_parsenet.pth %FX%/v0.2.2/parsing_parsenet.pth || goto dlfail
goto dlok

rem 下載到 .part，完整下載才改名；中斷後重跑會從斷點續傳
:get
if exist "%~1" exit /b 0
curl -L --fail --retry 5 --retry-delay 3 -C - -o "%~1.part" "%~2"
if errorlevel 1 exit /b 1
move /y "%~1.part" "%~1" >nul
exit /b 0

:dlfail
echo [錯誤] 模型下載失敗（網路不穩）。請再執行一次 安裝SadTalker對嘴.bat，會從中斷的地方繼續下載。
pause
exit /b 1

:dlok
echo.
echo 測試對嘴（用 SadTalker 內附的範例，約 1–3 分鐘）...
set PYTHONUTF8=1
%PYX% inference.py --driven_audio examples\driven_audio\bus_chinese.wav --source_image examples\source_image\full_body_1.png --result_dir results-test --still --preprocess full --size 256
if errorlevel 1 (
  echo [錯誤] 測試失敗，請把上面的訊息複製給 Claude。
  pause
  exit /b 1
)
cd ..
echo.
echo ==== 安裝完成！重新執行「啟動短影工坊平價版.bat」，在品牌設定勾選「說書人對嘴」即可使用 ====
pause
