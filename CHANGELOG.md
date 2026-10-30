# Changelog

## 未發佈

- 新增「DeepSeek 餘額」：每輪把錢包餘額放進角色背景資訊；低於門檻時由角色用自己的語氣主動提醒儲值（冷卻、靜音時段、可在面板調整）。

- 貼吧動態：每次回覆前把「剛剛有沒有刷貼吧／今天幾場／日報狀態」注入 system prompt，角色可照實回答；面板「進階設定」可關閉。

## 0.1.0

第一個公開版本。

- LINE Messaging API webhook server（`X-Line-Signature` 驗章、事件去重、每位使用者佇列、reply 失敗自動改 push、loading 動畫）。
- Cloudflare Tunnel：quick tunnel（`*.trycloudflare.com`）與 API Token 具名隧道（自動建立 tunnel、ingress、DNS CNAME、`cfargotunnel.com` 目標），取得網址後自動設定並測試 LINE webhook。
- LINE 憑證：Channel ID + Channel Secret 自動簽發／續簽 access token；也可貼上既有 token。
- 回覆走 DSH 行程內的 Agent（`agents.create`／`resume`），可逐 session 指定人設。
- 人設來源：大肥魚（`dsh-persona-dafeiyu`，選用）或插件內建的自訂人設（`<DSH_HOME>/line-bot/personas.json`）；面板可新增／編輯／刪除／把大肥魚人設複製成自訂。選自訂人設時會請大肥魚在該 session 停用，再由插件注入 system prompt，不需要任何個性外掛。
- 每位 LINE 使用者獨立 session 與工作資料夾（記憶不互通），可用「人設」指令自行切換人設。
- 主動傳訊排程：機率、間隔、每日／每月上限、最短間隔、安靜時段、idle、指定對象、提示詞，Agent 可回 `SKIP`。
- 完整設定面板（`settings.section`）：狀態總覽、LINE 憑證、Cloudflare Tunnel、人設、貼吧學習同步、主動傳訊、使用者、進階設定；固定儲存列與二級快速選單。
- 貼吧學習同步：把「刷貼吧」演化的語氣樣本與性格數值寫回指定自訂人設，寫入前備份、寫入後重載大肥魚外掛。
- 安裝工具：`npx dsh-line-bot install` / `uninstall` / `status`，自動選擇 profile 並寫入 `dsh.profile.bundles`。
