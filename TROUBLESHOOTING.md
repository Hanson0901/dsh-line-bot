# 疑難排解

先跑一次診斷，把結果貼給 DSH 的 Agent，它就能照 `AGENTS.md` 的流程修：

```bash
npx dsh-line-bot doctor
npx dsh-line-bot doctor --fix   # 安全修復：重連 tunnel、重設 webhook
```

面板「進階設定」也有「執行診斷」與「自動修復（安全）」。

## 常見症狀

### Bot 完全沒回
- 檢查 `server`、`tunnel`、`webhook` 三個檢查。
- LINE console → Messaging API → Webhook 設定要開「Use webhook」。
- quick tunnel 每次重啟會換網址；`doctor --fix` 會把 webhook 指到目前網址。
- LINE 不會重送失敗的 webhook，斷線期間的訊息會直接遺失。

### 回文字但沒有圖片
- 面板「表情包」要開啟，且偵測到 `dsh-meme` 圖庫（`count > 0`）。
- `public-url`、`media` 檢查要 OK；quick tunnel 剛換網址的前幾秒 LINE 抓不到圖，會先不附圖。
- GIF／webp 需要轉圖：macOS 內建 `sips`，GIF／APNG 與 Windows 建議裝 `ffmpeg`。
- 日誌關鍵字：`找不到表情包`、`表情包格式不支援`、`公開網址尚未就緒`。
- 用面板「測試 Agent 回覆」或 `meme-preview` 確認模型有輸出標記。

### 回覆裡出現 `[[meme:…]]` 或 `<meme#18>`
- 舊版不認得標記格式；升級到 0.6.1 以上（目前 0.9.x）。

### 貼圖／圖片看不懂
- 模型支援圖片（`inputModalities` 含 `image`）時會直接看圖；面板「模型與接口來源」可換模型。
- 模型不支援時，插件會先用 modlens 描述，再改用另一個視覺模型，最後才退回貼圖關鍵字。
- modlens 可在「進階 → 診斷」看 `vision` check；失敗通常是 provider 額度或 503。一般圖片可在面板「LINE 憑證」關閉「看得懂一般圖片」。

### 語音沒送出或一直回文字
- 面板「語音回覆」要開啟、確認聲音使用權，並按過「一鍵配置環境」（第一次會下載模型）。
- macOS 需要 Apple Silicon + Python 3.10+；Windows 需要 `ffmpeg`。音檔上傳後可按「測試語音」試聽。
- 合成約需 20–40 秒；reply token 過期時會自動改用 push。日誌看 `語音回覆`、`語音合成失敗`。
- 模型只有在語言上下文有語音提示時才會加 `[[voice]]`；可先用「測試 Agent 回覆」確認。

### APNG 不會動
- LINE 不播放 APNG，只顯示第一幀。保持 `stickers.apng=false` 即可。

### Windows 安裝失敗
- 優先用 DSH 面板「設定 → 外掛 → 安裝 bundle」。
- 或用新版 CLI（0.3.1+）並先 `npm install -g pnpm`；沒有 `sips` 時裝 ffmpeg。

### 群組不回
- 面板「群組」：被 @／引用一定回；其他訊息依機率擲骰（預設 15%）。
- 群組要開「在群組裡運作」。

### 主動訊息沒出現
- 面板「主動傳訊」：機率、每日／每月上限、靜音時段、閒置分鐘、冷卻。
- 沒有對話過的使用者不會被主動找。

### 餘額提醒沒出現
- 只有 `provider = deepseek-account` 才適用。
- 餘額要高於門檻才會提醒；冷卻（預設 12 小時）與靜音時段會跳過。
- 面板「DeepSeek 餘額」可看 `applicable`、`lastAskAt`、`nextCheckAt`。

### npm 安裝出現 ETARGET
- registry／CDN 傳播延遲，等 1–5 分鐘；必要時 `npm cache clean --force`。
