# Changelog

## 0.8.0

- 內建診斷：`GET /doctor`、`npx dsh-line-bot doctor [--fix] [--json]`，檢查伺服器／tunnel／公開網址／webhook／dsh-meme／表情包設定／轉圖工具／模型／圖片可送達／最近錯誤。
- 面板「進階設定」新增「執行診斷」與「自動修復（安全）」。
- 修正：Flex 圖片訊息（`hero.url`）在診斷中會被正確辨識；表情包描述改用圖庫樣本比對，長描述也能命中。
- 新增 `AGENTS.md`（給 DSH Agent 的除錯流程）與 `TROUBLESHOOTING.md`（症狀對照）。

## 0.7.2

- 匯入聊天時若成員還沒對應到 LINE 帳號，先用「名字」記住；本人第一次在群組發言時，這些記憶也會一起帶入。

## 0.7.1

- 群組卡片新增「匯入聊天」：選 LINE 匯出的 `.txt`，自動整理群組摘要、常聊主題與各成員的記憶點；比較晚加入群組也能補上背景。
- 匯入的成員記憶存成 `群組ID:name:名字`（已知帳號則用 LINE userId），會出現在面板「個人記憶」；群組回覆會帶入匯入摘要。
- 匯入結果只存在本機 `state.json` 與 `memories.json`。

## 0.7.0

- 群組內每位成員有自己的記憶點（同一個人到不同群組也分開），回覆時會注入該成員的記憶。
- 群組回覆會參考最近 4～6 則別人的訊息；沒被點名而擲骰不回時，訊息仍會留給下一輪參考。
- 群組「清空記憶」會同時清掉該群組所有成員的記憶。

## 0.6.1

- 修正模型用 `<meme#18>` 這種角度括號標記時，圖片沒送出、反而把標記當文字顯示的問題；現在支援 `<meme#N>`、`[[meme:#N]]`、`[[meme:N]]` 與 `[表情: …]`，並會清掉殘留的括號。
- 群組對話不再注入貼吧作息提示（一對一聊天與主動傳訊仍保留）。

## 0.6.0

- 支援群組與多人聊天室：被 @ 或引用（回覆某則訊息）一定回，其餘訊息依「群組回覆機率」擲骰（預設 15%）。
- 每個群組有自己的 DSH session、工作資料夾、人設與個人記憶；面板新增「群組」卡（回覆機率、開關、群組人設、清空記憶）。
- 狀態與個人記憶清單會列出群組；新增 `group-persona`／`group-reset` 動作。

## 0.5.6

- 安裝 CLI 會偵測搭配外掛（`dsh-persona-dafeiyu`、`dsh-meme`、`dsh-tieba-dive`），可互動詢問或 `--with-companions` 一起安裝；`status` 也會顯示安裝狀態。
- README（五語言）新增「搭配外掛」章節。

## 0.5.5

- 收到 LINE 貼圖時抓取貼圖圖片，透過 DSH 附件服務交給模型閱讀（模型不支援圖片時自動退回貼圖關鍵字）。
- 面板「LINE 憑證」新增「看得懂貼圖」開關；README（五語言）補說明。

## 0.5.4

- LINE 不會播放 APNG 動畫（只顯示第一幀），所以 GIF 預設改成靜態 PNG，檔案更小、載入更穩。
- 面板「表情包」卡新增「GIF 保留 APNG 動畫」開關（預設關閉）；打開才會送 APNG。

## 0.5.3

- 表情包改用 Flex Message（hero 圖片＋文字），GIF 轉成 APNG 保留動畫；APNG 過大或轉檔失敗才退回靜態 PNG。
- 送圖前先確認公開網址可用，避免 tunnel 剛換網址時送出抓不到的圖。
- 新增 `meme-send` 診斷 action，可直接送一則指定文字＋表情包到某個使用者。

## 0.5.2

- 重新發佈 0.5.1 的內容：主動傳訊（含低餘額提醒）可在句子後面加 `[[meme:#編號]]` 配表情包。
- （0.5.1 被 npm 標成 staged，沒有直接上架，因此改用 0.5.2 發佈。）

## 0.5.1

- 主動傳訊（含低餘額提醒）現在也能配表情包：預設提示詞允許在句子後面加 `[[meme:#編號]]`，不適合就純文字。

## 0.5.0

- 表情包（dsh-meme）：角色回覆時可以配圖或只回一張圖；圖片來自已安裝的 dsh-meme 圖庫（內建「大肥魚」24 張），面板可開關、限制一次最多 1～3 張、預覽圖庫樣本。
- 圖片經目前的 Cloudflare 公開網址提供給 LINE；quick tunnel 換網址後自動跟上。
- 為避免和 dsh-meme 的 chat 用法混淆，LINE 回覆會隱藏 `send_meme` 等工具，改用 `[[meme:#編號]]` 標記。

## 0.4.1

- 角色現在知道「正在用哪個 provider／模型」回答：每輪會帶入目前模型，問它「你是哪個模型」時會照實回答。
- 面板若把推理強度清空，會送出空字串而不是 `default`。

## 0.4.0

- 新增「模型與接口來源」：可選這個 DSH profile 已註冊的 provider 與模型、推理強度；留空則跟隨 DSH 預設。
- DeepSeek 餘額只適用 `deepseek-account`：切成其他 provider 時，餘額卡會反白停用、不再抓餘額，也不會主動提醒儲值。
- 面板順序調整：LINE 憑證移到第 2、Cloudflare Tunnel 第 3，模型與來源第 4。

## 0.3.1

- 修好 Windows 安裝：`npx dsh-line-bot install` 現在會找到 DeepSeek Harness 內建的 pnpm（`%LOCALAPPDATA%\Programs\…`、`%PROGRAMFILES%`），也會正確透過 `shell` 執行 `dsh.cmd` / `pnpm.cmd`。
- 找不到 pnpm 時的錯誤訊息補上 Windows 的建議（`npm install -g pnpm` 或改用面板安裝）。

## 0.3.0

- 新增「個人記憶」：每位使用者一份長期記憶（`<DSH_HOME>/line-bot/memories.json`），角色可在對話中自己呼叫 `line_memory_add` 記下重要資訊、用 `line_memory_forget` 忘掉、用 `line_memory_list` 確認。
- 有期限的記憶可帶 `ttlDays`，到期由排程自動刪除；每天（預設 4 點，面板可調）角色會自己整理一次，清掉過期或不再成立的內容。
- 每輪只注入最近 N 筆／限量字元；面板「個人記憶」卡可查看、刪除、立即清理、立即整理，並調整每人上限與每日整理時間。
- README 五種語言補上個人記憶說明。

## 0.2.1

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
