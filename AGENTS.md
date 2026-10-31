# dsh-line-bot：給 DSH Agent 的除錯指南

這份檔案是給「在這台電腦上除錯 LINE Bot」的 DSH Agent 看的。遇到使用者說「Bot 沒回」「叫他傳表情包沒傳」「圖片顯示不出來」時，照下面的順序做，不要先改程式。

## 0. 先跑診斷

```bash
node bin/cli.mjs doctor --json      # 或 npx dsh-line-bot doctor --json
```

- 伺服器在跑時，doctor 會打本機 `http://127.0.0.1:8791/doctor`，檢查：伺服器、Cloudflare Tunnel、公開網址健康、LINE webhook、dsh-meme 圖庫、表情包設定、轉圖工具、模型、圖片可送達測試、最近錯誤。
- 伺服器沒跑時會退成離線檢查（設定檔、憑證、dsh-meme、轉圖工具、日誌）。
- `--fix` 會做安全修復：重啟 tunnel、重設 webhook、重新讀 bot 資訊；不會改設定、不會刪資料。

也可以直接看：

```bash
curl -s http://127.0.0.1:8791/doctor | jq .
curl -s http://127.0.0.1:8791/health
```

## 1. 症狀對照表

| 症狀 | 先看哪個 check | 常見原因 | 安全修法 |
| --- | --- | --- | --- |
| 完全沒回覆 | `server`、`tunnel`、`webhook` | webhook 指到舊 tunnel；LINE「Use webhook」沒開；伺服器沒啟動 | `doctor --fix`；面板「套用 Webhook」；到 LINE console 開 Use webhook |
| 有回文字但沒圖片 | `dsh-meme`、`meme-config`、`public-url`、`media`、`converters` | 沒裝 dsh-meme；`stickers.enabled=false`；公開網址還沒就緒；GIF/webp 沒有轉圖工具 | 面板「表情包」開啟並看圖庫；`doctor --fix`；安裝 ffmpeg |
| 回覆出現 `[[meme:…]]`、`<meme#18>` 文字 | 版本 | 舊版不認得標記格式 | 升級到 0.6.1+（目前 0.8.x） |
| 貼圖看不懂 | `model` | 目前模型不吃圖（`inputModalities` 沒有 image） | 面板「模型與接口來源」換成有 `text+image` 的模型 |
| 群組不回 | 面板「群組」 | 沒被 @／引用、擲骰沒中、群組功能關閉 | 看面板回覆機率與開關 |
| 主動訊息沒出現 | 面板「主動傳訊」 | 機率、每日／每月上限、靜音時段、冷卻、沒有 session 的使用者 | 看 `status.nudge` 與日誌 |
| 餘額提醒沒出現 | `balance` | provider 不是 `deepseek-account`、餘額高於門檻、冷卻中、靜音 | 面板「DeepSeek 餘額」看 `applicable`、`lastAskAt` |
| Windows 安裝失敗 | CLI | 找不到 DSH 內建 pnpm；舊版 spawn `.cmd` 失敗 | 用面板安裝，或升級 CLI；必要時 `npm i -g pnpm` |
| npm `ETARGET` | — | registry／CDN 還沒傳播 | 等 1–5 分鐘再試 |

## 2. 圖片沒送出的排查順序

1. `dsh-meme` 是否可用、`count > 0`：`curl -s localhost:8791/doctor`。
2. 面板「表情包」是否開啟、`maxPerReply >= 1`。
3. `public-url` 與 `media` 是否 OK：`media` 會真的組一則 Flex 圖片並抓 `/media/<token>`。
4. 看日誌關鍵字：`找不到表情包`、`表情包格式不支援`、`公開網址尚未就緒`、`LINE 400`。
5. 轉圖工具：macOS 有 `sips`；GIF／APNG 需要 `ffmpeg`；Windows 沒有 `sips`，webp／gif 需要 `ffmpeg`。
6. 模型有沒有照格式輸出？面板「測試 Agent 回覆」或 `meme-preview` 可驗證；支援標記：`[[meme:描述]]`、`[[meme:#編號]]`、`<meme#編號>`、`[表情: 描述]`。

## 3. 檔案與端點

- `lib/host.mjs`：主要流程（webhook 事件、回覆、tunnel、人設、記憶、表情包、診斷）。
- `lib/line-api.mjs`：LINE API（reply/push/loading/webhook endpoint）。
- `lib/tunnel.mjs`：cloudflared 管理。
- `lib/meme-source.mjs`：讀 dsh-meme。
- `lib/chat-import.mjs`：LINE 匯出聊天解析。
- `lib/diagnostics.mjs`：doctor 用的檢查工具。
- `bin/cli.mjs`：安裝／`doctor`。
- HTTP：`/api/line-bot/status|config|action|doctor`（webServer）、`http://127.0.0.1:<port>/doctor|health|media/<id>|webhook`（外掛自己的伺服器）。
- 資料：`$DSH_HOME/line-bot/`（config.json 600、state.json、memories.json、logs、personas、cache、users）。

## 4. 安全規則

- 不要把 `config.json`、state、token、userId 貼進回覆或 commit；doctor 輸出已避開秘密。
- 不要手改 `~/.dsh/profiles/*`；要改設定用面板或 `POST /api/line-bot/config`。
- 不要在未經使用者確認時清空記憶、群組或工作資料夾。
- `doctor --fix` 只會重連 tunnel／重設 webhook；其他修復請照 check 的 `fix` 指示。
- 改程式後：`node --check`，再 `POST /api/line-bot/dev/reload`（等 tunnel 換網址後重新套 webhook），最後再跑一次 `doctor` 驗證。

## 5. 修好後要回報什麼

- 哪個 check 從 fail/warn 變成 ok。
- 做了哪個安全修復（例如「重設 webhook 到新 tunnel」）。
- 若需要使用者操作（LINE console 開 Use webhook、安裝 ffmpeg、換模型），明確列出來。
