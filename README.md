# 短影工坊 平價版（ReelForge OSS）

**謝邦彥 博士 設計**

流程和原版 ReelForge 一樣：**輸入需求 → AI 寫文案 → 上傳圖片 → 產生 1–3 分鐘 9:16 短視頻 → 最多修改 5 次**。
差別是：原版花錢最多的「AI 影片生成」和「AI 配音」，改用**免費、開源**的來源，一支影片的 API 費用從幾百元降到**不到 NT$3**。

| 步驟 | 原版（Gemini，付費） | 開源版預設（免費） | 設定 |
|---|---|---|---|
| 文案、分鏡、改寫 | Gemini Flash | Gemini Flash（每支不到 NT$3）或本機 Ollama（免費） | `TEXT_PROVIDER` |
| 國語配音 | Gemini TTS | 本機配音服務：Edge 台灣國語語音，或聯發科 **BreezyVoice**（開源） | `TTS_PROVIDER`、`TTS_ENGINE` |
| AI 動態畫面 | Gemini Omni（約 US$0.10／秒） | **Pixabay 免費實拍影片庫**（或 Pexels） | `VIDEO_PROVIDER` |
| AI 補圖 | nano-banana（US$0.034／張） | **Pixabay 免費圖庫**（或 Pexels） | `IMAGE_PROVIDER` |
| 說書人對嘴 | Gemini Omni | 照片＋鏡頭推移＋配音 | `LIPSYNC_PROVIDER` |
| 合成、字幕、配樂 | FFmpeg | FFmpeg（不變） | — |

每一項都可以在 `.env` 單獨改回 `gemini`，例如只有重要客戶才用 Omni 生成畫面。

---

## 一、Windows 安裝與啟動（只要一個檔案）

1. 從 GitHub 下載：
   ```powershell
   cd $env:USERPROFILE
   git clone https://github.com/stevehsieh1968-dot/reelforge-oss.git
   ```
2. 雙擊 **`啟動短影工坊平價版.bat`**，它會自動：
   - 缺 Node.js／FFmpeg／Python 時用 winget 安裝（裝完會請你重開一次）
   - 從 GitHub 更新程式、安裝套件、安裝本機配音服務
   - 建立或升級 `.env`（舊設定會保留，備份在 `.env.bak`）
   - 還沒填金鑰時打開記事本，請填：
     - `GEMINI_API_KEY`：寫文案用（https://aistudio.google.com/apikey）
     - `PIXABAY_API_KEY`：免費影片庫（到 https://pixabay.com/api/docs/ 註冊登入，頁面上就會顯示你的 key）
   - 全部就緒後啟動，瀏覽器自動打開 http://localhost:3000
3. 之後每次使用，一樣只要雙擊 **`啟動短影工坊平價版.bat`**。

`安裝BreezyVoice.bat` 是選用的進階功能（複製說書人自己的聲音），一般使用不需要。

> 原版的 `reelforge` 資料夾不受影響，兩個版本可以並存，但同時只能開一個（都用 3000 埠）。

## 二、畫面怎麼來（VIDEO_PROVIDER=pixabay）

- 「AI 動態」場景：AI 先把場景描述變成英文關鍵字（例如 `woman drinking coffee cafe`），到 Pixabay 找一段實拍影片（直式優先；橫式的會裁中間），自動裁成 1080×1920、配合旁白長度。
- 你上傳的圖：每張圖在**第一次出現的場景**照樣使用（鏡頭推移），其他 AI 動態場景用影片庫畫面，避免同一張圖重複出現。想讓上傳過圖的場景也換成影片庫，設 `STOCK_REPLACE_UPLOADS=1`。
- 不滿意某個場景的畫面：在修改頁選那個場景「換畫面」，會換成下一段搜尋結果。
- 每段影片的來源網址和作者都記在 `project.json` 的 `cost.items`（type 為 `stock`）。Pixabay／Pexels 素材可免費商用、不需標示來源，但**不可暗示畫面中的人物代言你的產品**，也不能單獨轉賣素材。
- Pexels 目前暫停核發新的 API 金鑰；已經有金鑰的人可以設 `VIDEO_PROVIDER=pexels`、`IMAGE_PROVIDER=pexels`。
- `VIDEO_PROVIDER=kenburns`：完全不用網路素材，全部用鏡頭推移（最快）。

## 三、配音（TTS_PROVIDER=local）

本機配音服務在 `tts-server/`，有兩種引擎（`.env` 的 `TTS_ENGINE`）：

| 引擎 | 說明 | 適合 |
|---|---|---|
| `edge`（預設） | 微軟 Edge 的台灣國語神經語音（曉臻、曉雨、雲哲），免費、要網路、不用顯卡 | 一般使用 |
| `breezy` | 聯發科 **BreezyVoice**（開源，專為台灣國語調整，破音字更準），**可以複製說書人自己的聲音**，聲音資料留在你的電腦 | 說書人範本、要用本人聲音 |

安裝 BreezyVoice：雙擊 **`安裝BreezyVoice.bat`**（需要 Python 3.10、約 5GB），完成後把 `.env` 改成 `TTS_ENGINE=breezy`。
模型很小（約 3 億參數），RTX 3050 筆電（4GB）或 CPU 都能跑。目前的做法是每一句都重新載入模型，所以**比 edge 慢很多**，一支影片的配音可能要十幾分鐘；做好的配音會快取，修改時不會重做。
BreezyVoice 官方以 Linux 為主，Windows 若安裝失敗，可以先用 `edge`，或在 WSL／Docker 安裝。
內建聲線在 `breezy` 模式下，會先用 Edge 唸一段參考句，再讓 BreezyVoice 模仿，聲音更自然。

## 四、完全不用 Gemini（選用）

文案也想免費：安裝 [Ollama](https://ollama.com)，執行 `ollama pull qwen3:8b`，然後在 `.env` 設：
```
TEXT_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen3:8b
```
注意：3050 筆電的 4GB 顯示記憶體跑 8B 模型會很慢（部分用 CPU），而且小模型寫的文案品質明顯比 Gemini Flash 差。
文案每支只要 NT$1–3，**建議文案繼續用 Gemini**。任何 OpenAI 相容服務（LM Studio、OpenRouter、DeepSeek 等）都可以用同樣的設定。

連線檢查：瀏覽器打開 http://localhost:3000/api/diag 。

## 四之一、Docker

```bash
cp .env.example .env   # 填好金鑰
docker compose up -d --build
```
會同時啟動主程式和配音服務（edge 引擎）。

---

## 五、功能與規則（和原版相同）

**步驟 1　需求**：影片長度可選 1／2／3 分鐘（建議場景數分別為 6／8／10）。可以先選 13 個影片範本之一，包括 3 個「說書人」範本（宗教溫馨、產品信任、品牌風格），以及（痛點→解方、開箱實測、門市探店、教學步驟、顧客見證、限時促銷、品牌故事、比較評測、常見問答、生活日常），每個範本都排好 10 個場景的結構，AI 會照著寫；也可以選「AI 自由發揮」。
然後填填品牌、受眾、目的、賣點、語氣、旁白語言、平台，以及場景數（6–18，建議 10，每場約 18 秒）。
- **AI 一鍵成片**：填好需求、選方案後按一下，AI 會自動寫文案、生成每個場景的圖、讓畫面動起來、配音、加上字幕和音樂，直接做出影片（約 10–20 分鐘），之後一樣可以修改 5 次。
- 長場景（超過約 9 秒）的 AI 動態會拆成多個連續鏡頭：第 2 鏡從第 1 鏡的最後一格接著拍，動作連續，不會停格。

**步驟 2　文案**：AI 依你選的場景數產生每個場景的旁白、畫面建議、3 個標題、貼文說明和 Hashtag。
- 可以直接改字，也可以「用一句話叫 AI 改」（能只改勾選的場景）。
- 這個階段**不限次數，不扣修改次數**。

**步驟 3　素材**：拖曳上傳圖片，系統會自動配對到場景，可以逐一調整。
- 素材不夠：按「AI 補齊缺的圖」或每個場景的「AI 生圖」，用 Gemini（`gemini-nano-banana-2.1`）依文案生成 9:16 寫實照片，每張約 US$0.034。
- AI 動態的場景就算沒有圖片，也會依文案直接生成真人實拍感的畫面（文字生影片）。
- AI 動態會要求畫面裡的人和物「真的在動」，例如走路、手勢、表情、使用產品，不只是鏡頭推移。
- 新專案預設「高階版」，全部場景都用 AI 動態。
- 每個場景可以選「AI 動態」（Veo 圖生影片）或「鏡頭推移」（FFmpeg 推近、平移，免費）。
- 方案決定 AI 動態的場景比例：經濟版約 20%、標準版 50%、高階版全部。後端也會強制執行這個上限。
- 背景音樂：內建 5 首免費配樂（1. 琴音（古箏）、2. 長笛、3. 鋼琴、4. 木吉他、5. 輕快流行），AI 一鍵成片和手動製作都可以選，也可以上傳自己的 MP3。播旁白時，背景音樂會自動壓低。
  內建音樂是 `scripts/make-music.py` 用程式合成的，沒有版權問題。

**步驟 4　預覽與修改**
- 一句話改全片：輸入「開場更有梗、節奏快一點、音樂換激昂的」，AI 會先列出打算怎麼改（不扣次數），確認後才套用。要重做 AI 畫面的場景超過 4 個，算全片重做，扣 2 次。
- 語速：文案頁、素材頁、修改頁都有滑桿，可以調 0.8–1.5 倍。
- 每支影片**最多修改 5 次**（`MAX_REVISIONS`）。
- 每次最多選 4 個場景（`MAX_SCENES_PER_REVISION`）。**只重做選到的場景**，其他場景直接用快取，不重複付 AI 費用。
- 可修改的項目：換畫面或動態、改旁白（手動輸入，或依修改說明由 AI 改寫）、換聲線、字幕樣式、背景音樂。
- 「全片重做」扣 2 次（`FULL_REDO_COST`）。
- **產生失敗會自動退回修改次數。**伺服器重啟時中斷的任務，次數也會退回。
- 每個版本都保留，可以播放、下載和比較。
- 預覽時影片旁會顯示目前播放到第幾個場景和該段旁白；點時間軸上的場景，影片會跳到那一段。

**畫面效果**
- 場景轉場：淡入淡出、滑動、推近，或直接切換。
- 重點大字：每個場景開頭在畫面上方彈出 2–8 個字的重點。AI 會自動產生，可以在文案頁修改或留白。
- 字幕樣式：白字黑框、品牌色底、逐字跳出。

**說書人**
- 說書人照片：上傳自己的照片，或選 5 位內建虛擬說書人之一。內建說書人是 AI 生成的虛構人物，第一次使用時生成並保存，約 US$0.034。
- 說書人聲音（Gemini 3.8 TTS）：
  - 內建 4 種說書人聲音：用聲音設計做出溫暖女聲、沉穩男聲等，第一次使用時建立。
  - 用說書人自己的聲音：錄 10–30 秒的聲音樣本，再錄一句同意聲明（國語唸「我是此聲音的擁有者並授權谷歌使用此聲音創建語音合成模型」），系統就會建立說書人的聲音，之後 AI 用這個聲音唸所有旁白。這只能用於本人或已取得同意的人，聲音會保存在你的 Google 專案一年。
  - 一鍵成片卡片和品牌設定頁都可以設定；聲線選單裡選「說書人的聲音」就會使用。
- 也可以在品牌設定上傳說書人照片和名字。用說書人範本時，開場、價值主張、結尾等場景會由說書人出鏡（AI 讓照片動起來），其他場景則在左下角顯示圓形小頭像。步驟 3 可以逐場勾選「說書人出鏡」。
- 每個場景可以按 🎙 直接錄音，或上傳音檔，用說書人的真人聲音取代 AI 配音。影片做好後，要重錄某個場景，在修改頁選「改旁白文字」再錄。
- 限制：出鏡畫面的嘴型不會完全對上錄音；真人照片比較容易被 Google 安全過濾擋下，被擋時會改用鏡頭推移。

**品牌設定**（上方選單「品牌設定」，設定一次每支都套用）
- Logo 浮水印、片頭 Logo、片尾卡（Logo＋品牌名＋行動呼籲＋小字）、品牌色。
- 已經做好的影片要套用新的品牌設定，請在修改頁選「字幕／轉場／大字」重新產生。這樣不會重做 AI 影片，也不會花 AI 費用。

**封面圖**：每個版本自動產生，用第 1 場畫面加上標題。在預覽頁可以改標題，或暫停在任何畫面按「用目前畫面重做封面」，免費。

**輸出規格**：MP4，H.264 + AAC，1080×1920，30fps，約 180 秒，字幕直接燒進畫面。

---

## 六、成本比較（每支 3 分鐘、10 場景）

| 設定 | 初版費用 | 修改一個場景 |
|---|---|---|
| 原版高階版（全部 Omni） | 約 NT$600 | 約 NT$60 |
| **開源版預設**（Gemini 文案＋Pixabay＋本機配音） | **約 NT$1–3** | **約 NT$0.1** |
| 開源版＋Ollama 文案 | NT$0 | NT$0 |
| 混合：只有 2 個關鍵場景用 Omni（`VIDEO_PROVIDER=gemini` 並選經濟版） | 約 NT$120 | 約 NT$60 |

預覽頁下方顯示的費用，會依照目前的來源設定計算（免費來源記為 0）。

---

## 七、測試

```bash
# 開一個模擬模式的伺服器
MOCK=1 DATA_DIR=./data-test PORT=3100 npm start
# 另開終端機跑完整流程（約 10 分鐘）
BASE_URL=http://localhost:3100 DATA_DIR=./data-test npm run test:e2e
```

這個測試會檢查：文案 18 場、素材自動配對、方案上限、輸出為 1080×1920、長度約 180 秒、有音軌、修改只重做選到的場景、5 次上限、全片重做扣 2 次、第 6 次修改被擋。

---

## 八、正式上線前請注意

1. **一定要設 `ACCESS_PASSWORD`**，否則任何人都能用你的額度產生影片。之後要做會員和金流（綠界、Stripe），可以加在 `src/server.js` 的密碼中介層位置。
2. 目前用單機檔案儲存（`data/`）和單機佇列，適合起步階段，每天幾十支沒問題。量大時建議：
   - 資料改存 PostgreSQL（替換 `src/store.js`）
   - 檔案改存 Cloud Storage 或 S3
   - 佇列改用 Redis + BullMQ，多台機器分工
3. 部署建議：Google Cloud Run 或一台 4 核心 8GB 的 VM。FFmpeg 合成一支約 2–4 分鐘，Veo 生成約 1–3 分鐘一段（會平行處理）。
4. 背景音樂和上傳的圖片要有授權。Veo 可能因安全過濾拒絕某些圖片（例如真人臉部、名人、未成年人），這時任務會失敗並退回次數。
5. Veo 和 TTS 目前是預覽版模型，名稱可能變動。被停用時改 `.env` 的 `VIDEO_MODEL`、`TTS_MODEL` 即可。

---

## 九、程式結構

```
src/
  server.js    API 路由、修改次數規則、上傳
  pipeline.js  影片產生流程：配音 → 對時 → 畫面 → 字幕 → 合成，含快取
  gemini.js    文案、改寫（Gemini 或 OpenAI 相容服務）、Gemini TTS／Omni 呼叫
  providers.js 來源切換：本機配音、Pixabay／Pexels 影片庫與圖庫、Gemini（付費）
  media.js     FFmpeg 工具：鏡頭推移、片段對時、字幕 ASS、混音
  store.js     檔案型資料庫
  queue.js     任務佇列
  config.js    所有設定
public/        前端（原生 JS，不需編譯）
scripts/e2e.js 端到端測試
tts-server/   本機配音服務（Python：edge-tts／BreezyVoice）
```

### API 一覽

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/config` | 方案、聲線、規則 |
| POST | `/api/projects` | 建立專案 `{ brief }` |
| GET | `/api/projects/:id` | 專案狀態（含進度、剩餘次數） |
| POST | `/api/projects/:id/script` | 產生文案 |
| PATCH | `/api/projects/:id/script` | 手動改，或 `{ instruction, indexes }` 交給 AI 改 |
| POST | `/api/projects/:id/assets` | 上傳（multipart `files`） |
| PUT | `/api/projects/:id/scenes` | 分鏡對應與方案設定 |
| POST | `/api/projects/:id/render` | 產生初版 |
| POST | `/api/projects/:id/revise` | 修改 `{ scenes, types, note, sceneEdits, settings, full }` |
| POST | `/api/projects/:id/retry` | 初版失敗後重試 |
| GET | `/api/projects/:id/versions/v1.mp4` | 播放或下載（加 `?download=1`） |
