# dsh-line-bot

把 LINE 官方帳號（Messaging API）接進 DeepSeek Harness 的插件。回覆由 DSH 的 Agent 在**同一個行程內**產生，等於在 LINE 上跟你的 DSH 助理聊天；人設有兩種來源：有安裝大肥魚（`dsh-persona-dafeiyu`）時可以直接選它的人設；也可以只用插件內建的自訂人設（不需要任何個性外掛）。

內建：

- **Webhook 伺服器**：在本機 `127.0.0.1` 開一個 HTTP server，處理 LINE 的 `X-Line-Signature` 驗章、事件去重、每位使用者各自的佇列。
- **Cloudflare Tunnel**：一鍵開 quick tunnel（`*.trycloudflare.com`，免 Cloudflare 帳號），或貼上 Cloudflare API Token 建立具名隧道＋DNS，取得固定網址；取得網址後自動把 webhook 端點寫回 LINE 並跑一次 `webhook/test`。
- **LINE 憑證**：填 Channel ID＋Channel Secret 就能自動簽發 access token（`/v2/oauth/accessToken`，約 30 天，快到期會自動續簽）；也可以直接貼上既有的 Channel Access Token。
- **人設**：面板可選大肥魚插件裡任何一個內建／自訂人設，或插件內建的自訂人設（存在 `<DSH_HOME>/line-bot/personas.json`，可新增／編輯／匯入）。人設是「逐 session」指定，不會改到你 GUI 裡其他對話的人設。
- **主動傳訊**：插件內建排程器（不用 launchd），可調機率、間隔、每日／每月上限、最短間隔、安靜時段、對方安靜多久才可打擾、指定對象與提示詞；Agent 覺得不適合時可以回 `SKIP` 跳過。
- **完整設定面板**：所有設定都在「設定 → LINE Bot」裡，存到 `<DSH_HOME>/line-bot/config.json`（權限 600）。

> 關於「用 LINE Business ID 登入、由面板代建 bot」：LINE 自 2024-09 起只允許在 [LINE Official Account Manager](https://manager.line.biz/) 手動建立 Messaging API channel，沒有公開 API；LINE Login 也只是身分驗證，不能取得官方帳號的管理權。所以面板不代建 bot，但會給你正確的入口連結，並把「拿到 Channel ID / Secret 之後」的所有步驟自動化（簽 token、設 webhook、測試）。

## 安裝

需求：DeepSeek Harness **≥ 0.2.0-rc.1**、Node.js **≥ 22**。人設外掛（大肥魚 `dsh-persona-dafeiyu`）是**選用**的——不裝也能用插件內建的自訂人設。

### 方式一：面板安裝（推薦）

DSH → **設定 → 外掛 → 安裝 bundle**，輸入 `dsh-line-bot` 後安裝，重新整理頁面。設定左側就會多一個 **LINE Bot**。

### 方式二：npx 一鍵安裝

先完全結束 DSH（桌面版關閉視窗後，確認選單列／程序沒有殘留），再執行：

```bash
npx dsh-line-bot install
```

它會自動判斷要裝進哪個 profile（預設 `desktop`，可用 `--profile <名稱>` 指定），用 DSH 內建的 pnpm 安裝套件、把 bundle 加進 profile，最後提醒你重開 DSH。

```bash
npx dsh-line-bot status      # 看目前裝在哪個 profile、有沒有啟用
npx dsh-line-bot uninstall   # 移除（設定與憑證會保留）
```

### 方式三：手動

```bash
dsh plugin --profile desktop add dsh-line-bot
```

再把 `dsh-line-bot` 加進 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 陣列（可參考 `npx dsh-line-bot install` 的做法），或改用面板安裝。

> 還沒發佈到 npm 時，也可以直接從 GitHub 安裝：
>
> ```bash
> npx github:Hanson0901/dsh-line-bot install --spec github:Hanson0901/dsh-line-bot
> ```
>
> 或從原始碼：`git clone https://github.com/Hanson0901/dsh-line-bot.git`，在 DSH 面板「安裝 bundle」選那個資料夾，或 `dsh plugin --profile desktop add /path/to/dsh-line-bot`。

## 第一次上線（5 步）

1. **建立／取得憑證**：到 [LINE Official Account Manager](https://manager.line.biz/) 建立官方帳號 → [LINE Developers Console](https://developers.line.biz/console/) 建立（或選用）Messaging API channel → 在「Messaging API」分頁把 **Use webhook** 打開 → 複製 **Channel ID** 與 **Channel secret**。
2. **填入面板**：「LINE Bot → LINE 憑證」貼上 Channel ID、Channel Secret，按「儲存變更」→「驗證並讀取 bot 資訊」。成功會看到 bot 名稱與 Basic ID。
3. **啟動 webhook 伺服器**：面板「狀態總覽」按「啟動全部」，或只按「啟動」讓 webhook server 與 tunnel 都起來（預設會自動啟動）。
4. **開隧道**：Quick tunnel 直接按「啟動隧道」；要固定網址就在「Cloudflare Tunnel」貼 API Token →「驗證 API Token」→「建立／更新隧道與 DNS」（API Token 權限：Account → Cloudflare Tunnel → Edit、Zone → DNS → Edit、Zone → Zone → Read）。quick tunnel 每次重啟網址都會變（插件會自動把新網址寫回 LINE webhook）；具名隧道的網址則固定。
5. **自動設定 webhook**：隧道就緒後會自動 PUT 到 LINE；若沒成功，按「把隧道網址套到 webhook」再「測試 webhook」。之後在 LINE 加 bot 好友、傳訊息即可。

## 面板各區

面板最上方是**固定（sticky）儲存列**：捲到任何位置都看得到「儲存變更／重新整理」；儲存列下方是二級快速選單，按一下就會跳到對應區塊（捲動時也會自動高亮目前區塊）。

| 區塊 | 內容 |
| --- | --- |
| 狀態總覽 | webhook server／隧道／LINE／人設／主動傳訊的綠燈狀態、公開網址、一鍵上線與啟停 |
| LINE 憑證 | Channel ID、Channel Secret、Access Token、自動簽發、loading 動畫、bot 資訊、webhook 套用／測試、白名單 |
| Cloudflare Tunnel | quick／API Token 模式、Token、hostname、隧道名稱、Account／Zone ID、下載 cloudflared、啟停、自動設定 webhook、自行提供的公開網址 |
| 回覆人設 | 選擇人設（大肥魚或插件自訂）、新增／編輯／刪除自訂人設、把目前人設複製成自訂、強制套用、允許使用者自己換人設、切換大肥魚 session 模式、測試 Agent 回覆 |
| 主動傳訊 | 開關、機率、間隔、每日／每月上限、最短間隔、安靜時段、idle、指定對象、提示詞、立即試傳、統計 |
| 使用者 | 每位 LINE 使用者對應的 DSH session、專屬工作資料夾、目前人設（可直接改）、訊息數、上次互動、清空記憶／重設 session |
| 進階設定 | 連接埠、Agent provider/model/effort/cwd/逾時、一人一個工作資料夾（含根目錄）、歡迎／錯誤／空回覆、日誌、開發用 host 重新載入 |

## 設定檔

- `<DSH_HOME>/line-bot/config.json`：所有設定，含 LINE secret／Cloudflare token（權限 600，不會回傳明文給面板）。
- `<DSH_HOME>/line-bot/state.json`：LINE 使用者 ↔ DSH session 對應、訊息數、主動傳訊計數、webhook 狀態。
- `<DSH_HOME>/line-bot/logs/YYYY-MM-DD.log`：每日日誌（面板也會顯示最近 400 行）。

`DSH_HOME` 預設是 `~/.dsh`。

## 運作方式

1. LINE 把訊息 POST 到 Cloudflare 隧道 → 插件 webhook server（驗章後立刻回 200）。
2. 依 `userId` 找到（或建立）對應的 DSH session 與工作資料夾，決定這個 session 的人設：選大肥魚時透過它的 HTTP bridge 指定 session 人設；選插件自訂人設時，先請大肥魚在該 session 讓開（`none`），再由插件把自訂人設注入 system prompt。
3. 用 `agents.create`／`agents.resume` 在同一個 DSH 行程內建立／接續 Agent，`followup` 一則使用者訊息，等到 turn 結束、子代理收斂、session flush。
4. 從 session 事件取出最後一段 assistant 文字，用 LINE reply 回覆；reply token 過期就自動改 push。
5. 主動傳訊排程器每分鐘檢查一次（間隔、安靜時段、上限、機率），符合條件就請 Agent 主動說一句，再 push 出去。

## 人設來源

- **大肥魚（選用）**：有安裝 `dsh-persona-dafeiyu` 時，面板會列出它的人設（內建＋你自訂的），LINE 會逐 session 指定，不會改到 GUI 其他對話。需要它處於 `session` 模式；面板會提示並可一鍵切換。
- **插件內建自訂人設**：不需要任何個性外掛。面板「回覆人設 → 自訂人設」可新增／編輯／刪除，資料存在 `<DSH_HOME>/line-bot/personas.json`（0600）。選到自訂人設時，插件會請大肥魚在該 session 停用（若它有安裝），再把自訂人設注入這個 agent 的 system prompt。
- 兩種人設可以在同一個下拉選單裡選；使用者自己用 LINE 指令切換時也一樣（`人設`、`人設 2`、`人設 名字`）。

## 每位使用者各自的記憶與人設

- **記憶不共用**：每個 LINE 使用者都有自己的 DSH session，以及自己的 Agent 工作資料夾 `<DSH_HOME>/line-bot/users/<LINE userId>/`。Agent 看到的檔案、`AGENTS.md`、工作區記憶都是該使用者專屬的，不會讀到別人的。
  可在「進階設定 → 一人一個資料夾」關閉（關閉後全部共用 `agent.cwd`，等於回到舊行為）；也能用 `agent.workspaceRoot` 指定放哪個根目錄。
- **人設可自選**：「回覆人設 → 允許使用者自己換人設」開啟時，LINE 使用者可以傳：
  - `人設`（或 `人格`／`persona`）→ 列出可用人設與目前使用中的人設。
  - `人設 2` → 用清單編號切換；`人設 阿茶` → 用名字切換；`人設 預設` → 回到面板預設。
  切換只影響該使用者，下一次回覆就會套用；管理員也可以直接在「使用者」表的人設下拉幫他改。
- **清空記憶**：使用者表按「清空記憶」會刪掉該使用者的 session 與專屬工作資料夾（含裡面的檔案），重建後從空白開始；只按「重設 session」則保留資料夾。

## 貼吧學習自動同步

「刷貼吧」外掛每天最多演化一次自己的語氣（存在 `<DSH_HOME>/tieba-duty/persona.json`），這和 LINE 用的大肥魚人設（`<DSH_HOME>/storages/dsh-persona-dafeiyu/personas.json`）原本是兩套、互不相通。這個外掛可以把它接起來：

- 面板「回覆人設 → 貼吧學習同步」可設定開關、同步目標人設（只能選大肥魚的人設；預設關閉，請先選一個）、檢查間隔（預設 60 分鐘）、是否同步性格數值、寫入後是否重載大肥魚外掛。這項功能需要安裝大肥魚外掛。
- 每次檢查會比對貼吧人設版本；有新版本才動作。寫入時只替換目標人設正文中的 `## 貼吧學來的口氣` 段落（沒有就附加），不會覆蓋其他手寫內容；性格數值（溫柔／毒舌／抽象／話癆／發圖傾向）可一併更新。
- 寫入前會備份到 `<DSH_HOME>/line-bot/persona-backups/personas-<時間>.json`。
- 寫入後預設會透過 Cordis loader 重啟 `dsh-persona-dafeiyu`，讓它重新讀取 store；重啟失敗只會記警告，人設文字仍已寫入，下次外掛重載時生效。
- 貼吧外掛若沒在跑、或貼吧人設不存在，檢查會跳過（`pending` 顯示尚未同步的原因）。

## 疑難排解

- **面板顯示「無法連線到 LINE Bot 執行期」**：webServer 可能還沒就緒，重新整理即可；仍失敗就看 DSH 日誌裡 `[line-bot]` 的訊息。
- **webhook 測試失敗**：確認 `Use webhook` 已在 LINE console 打開、隧道網址是 https、且本機 webhook server 正在跑（面板綠燈）。
- **改了 lib/*.mjs 沒生效**：按「進階設定 → 重新載入 host 模組（開發用）」，不用重裝插件。
- **貼吧同步沒動作**：先看面板同步狀態的 `lastError`；確認貼吧外掛的人設檔存在、目標人設 id 正確。按「預覽差異」可比對目前段落與即將寫入的內容。
- **cloudflared 找不到**：按「下載 cloudflared」，插件會抓官方 release 放到 `<DSH_HOME>/line-bot/bin/`；也可以自己放一份並在 `tunnel.binaryPath` 指定。
- **Agent 回覆 403（模型只開放給 Codex）**：在「進階設定 → Agent 模型」把 provider／model 改成 `deepseek-account` / `deepseek-flash`（本機預設已設好），儲存後再測一次。
- **人設沒套用**：選大肥魚時，它必須是 `session` 模式；面板會提示，按「切換到大肥魚 session 模式」即可（這是它官方支援的設定，只影響「可不可以逐 session 指定人設」）。選插件自訂人設則不受此限制。
- **Cloudflare 回 530 / error code 1016**：具名隧道的 DNS CNAME 目標必須是 `<tunnel-id>.cfargotunnel.com`（不是 `.cfd.tunnel`）；另外該子網域若同時被 A 記錄佔用，邊緣會先回那台主機，請確認 DNS 只留一筆 CNAME。

## 隱私

- 這個插件不連任何第三方伺服器（除了你設定的 Cloudflare API、LINE API）。沒有遙測、沒有帳號。
- 所有設定與憑證只存在本機 `<DSH_HOME>/line-bot/config.json`（權限 600）；面板只顯示遮罩後的值。
- LINE 使用者的 session、工作資料夾與人設選擇都存在本機，不會上傳。
- 倉庫與 npm 套件不含任何人的憑證、LINE userId、Cloudflare 帳號或網域。

## 安全提醒

- 這等同把 DSH Agent 接到公開的 LINE 帳號：拿到 bot 的人可以讓 Agent 使用你電腦上的工具。建議在「白名單使用者 ID」填入自己的 LINE userId，只允許自己使用。
- 所有憑證都存在本機 `config.json`（600），面板只會看到遮罩後的值；API 只掛在 `127.0.0.1` 的 DSH webServer 上。
- Cloudflare API Token 建議只給必要權限，並在不用時撤銷。

## 開發

- host 邏輯：`lib/*.mjs`（`util`／`config`／`line-api`／`persona`／`agent-runner`／`webhook-server`／`cloudflare`／`tunnel`／`nudge`／`tieba-sync`／`host`）。
- 面板：`client.js`（`window.__ModuleLoader__` 註冊 `settings.section`）。
- 進入點：`index.js`（掛 `/api/line-bot`、dev reload、卸載清理）。
