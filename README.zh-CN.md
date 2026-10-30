# dsh-line-bot

<p align="center"><img src="icon.svg" width="96" height="96" alt="dsh-line-bot"></p>

**语言 / Languages:** [繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

把 LINE 官方账号（Messaging API）接进 DeepSeek Harness 的插件。回复由 DSH 的 Agent 在**同一个进程内**产生，等于在 LINE 上跟你的 DSH 助理聊天；人设有两种来源：有安装大肥鱼（`dsh-persona-dafeiyu`）时可以直接选它的人设；也可以只用插件内置的自定义人设（不需要任何个性插件）。

内置：

- **Webhook 服务器**：在本机 `127.0.0.1` 开一个 HTTP server，处理 LINE 的 `X-Line-Signature` 验签、事件去重、每位用户各自的队列。
- **Cloudflare Tunnel**：一键开 quick tunnel（`*.trycloudflare.com`，免 Cloudflare 账号），或贴入 Cloudflare API Token 创建具名隧道＋DNS，取得固定网址；取得网址后自动把 webhook 端点写回 LINE 并跑一次 `webhook/test`。
- **LINE 凭证**：填 Channel ID＋Channel Secret 就能自动签发 access token（`/v2/oauth/accessToken`，约 30 天，快到期会自动续签）；也可以直接贴入既有的 Channel Access Token。
- **人设**：面板可选大肥鱼插件里任何一个内置／自定义人设，或插件内置的自定义人设（存在 `<DSH_HOME>/line-bot/personas.json`，可新增／编辑／导入）。人设是「逐 session」指定，不会改到你 GUI 里其他对话的人设。
- **主动传讯**：插件内置排程器（不用 launchd），可调概率、间隔、每日／每月上限、最短间隔、安静时段、对方安静多久才可打扰、指定对象与提示词；Agent 觉得不适合时可以回 `SKIP` 跳过。
- **完整设置面板**：所有设置都在「设置 → LINE Bot」里，存到 `<DSH_HOME>/line-bot/config.json`（权限 600）。

> 关于「用 LINE Business ID 登录、由面板代建 bot」：LINE 自 2024-09 起只允许在 [LINE Official Account Manager](https://manager.line.biz/) 手动创建 Messaging API channel，没有公开 API；LINE Login 也只是身份验证，不能取得官方账号的管理权。所以面板不代建 bot，但会给你正确的入口链接，并把「拿到 Channel ID / Secret 之后」的所有步骤自动化（签 token、设 webhook、测试）。

## 安装

要求：DeepSeek Harness **≥ 0.2.0-rc.1**、Node.js **≥ 22**。人设插件（大肥鱼 `dsh-persona-dafeiyu`）是**可选**的——不装也能用插件内置的自定义人设。

### 方式一：面板安装（推荐）

DSH → **设置 → 插件 → 安装 bundle**，输入 `dsh-line-bot` 后安装，刷新页面。设置左侧就会多一个 **LINE Bot**。

### 方式二：npx 一键安装

先完全退出 DSH（桌面版关闭窗口后，确认菜单栏／进程没有残留），再执行：

```bash
npx dsh-line-bot install
```

它会自动判断要装进哪个 profile（默认 `desktop`，可用 `--profile <名称>` 指定），用 DSH 内置的 pnpm 安装套件、把 bundle 加进 profile，最后提醒你重开 DSH。

```bash
npx dsh-line-bot status      # 看目前装在哪個 profile、有没有启用
npx dsh-line-bot uninstall   # 移除（设置与凭证会保留）
```

### 方式三：手动

```bash
dsh plugin --profile desktop add dsh-line-bot
```

再把 `dsh-line-bot` 加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组（可参考 `npx dsh-line-bot install` 的做法），或改用面板安装。

> 还没发布到 npm 时，也可以直接从 GitHub 安装：
>
> ```bash
> npx github:Hanson0901/dsh-line-bot install --spec github:Hanson0901/dsh-line-bot
> ```
>
> 或从源码：`git clone https://github.com/Hanson0901/dsh-line-bot.git`，在 DSH 面板「安装 bundle」选那个文件夹，或 `dsh plugin --profile desktop add /path/to/dsh-line-bot`。

## 第一次上线（5 步）

1. **创建／取得凭证**：到 [LINE Official Account Manager](https://manager.line.biz/) 创建官方账号 → [LINE Developers Console](https://developers.line.biz/console/) 创建（或选用）Messaging API channel → 在「Messaging API」分页把 **Use webhook** 打开 → 复制 **Channel ID** 与 **Channel secret**。
2. **填入面板**：「LINE Bot → LINE 凭证」贴入 Channel ID、Channel Secret，按「保存更改」→「验证并读取 bot 信息」。成功会看到 bot 名称与 Basic ID。
3. **启动 webhook 服务器**：面板「状态总览」按「启动全部」，或只按「启动」让 webhook server 与 tunnel 都起来（默认会自动启动）。
4. **开隧道**：Quick tunnel 直接按「启动隧道」；要固定网址就在「Cloudflare Tunnel」贴 API Token →「验证 API Token」→「创建／更新隧道与 DNS」（API Token 权限：Account → Cloudflare Tunnel → Edit、Zone → DNS → Edit、Zone → Zone → Read）。quick tunnel 每次重启网址都会变（插件会自动把新网址写回 LINE webhook）；具名隧道的网址则固定。
5. **自动设置 webhook**：隧道就绪后会自动 PUT 到 LINE；若没成功，按「把隧道网址套到 webhook」再「测试 webhook」。之后在 LINE 加 bot 好友、传消息即可。

## 面板各区

面板最上方是**固定（sticky）保存栏**：滚到任何位置都看得到「保存更改／刷新」；保存栏下方是二级快速菜单，按一下就会跳到对应区块（滚动时也会自动高亮当前区块）。

| 区块 | 内容 |
| --- | --- |
| 状态总览 | webhook server／隧道／LINE／人设／主动传讯的绿灯状态、公开网址、一键上线与启停 |
| LINE 凭证 | Channel ID、Channel Secret、Access Token、自动签发、loading 动画、bot 信息、webhook 套用／测试、白名单 |
| Cloudflare Tunnel | quick／API Token 模式、Token、hostname、隧道名称、Account／Zone ID、下载 cloudflared、启停、自动设置 webhook、自行提供的公开网址 |
| 回复人设 | 选择人设（大肥鱼或插件自定义）、新增／编辑／删除自定义人设、把目前人设复制成自定义、强制套用、允许用户自己换人设、切换大肥鱼 session 模式、测试 Agent 回复 |
| 主动传讯 | 开关、概率、间隔、每日／每月上限、最短间隔、安静时段、idle、指定对象、提示词、立即试传、统计 |
| 用户 | 每位 LINE 用户对应的 DSH session、专属工作文件夹、目前人设（可直接改）、消息数、上次互动、清空记忆／重设 session |
| 高级设置 | 端口、Agent provider/model/effort/cwd/超时、一人一个工作文件夹（含根目录）、欢迎／错误／空回复、日志、开发用 host 重新载入 |

## 配置文件

- `<DSH_HOME>/line-bot/config.json`：所有设置，含 LINE secret／Cloudflare token（权限 600，不会回传明文给面板）。
- `<DSH_HOME>/line-bot/state.json`：LINE 用户 ↔ DSH session 对应、消息数、主动传讯计数、webhook 状态。
- `<DSH_HOME>/line-bot/logs/YYYY-MM-DD.log`：每日日志（面板也会显示最近 400 行）。

`DSH_HOME` 默认是 `~/.dsh`。

## 运作方式

1. LINE 把消息 POST 到 Cloudflare 隧道 → 插件 webhook server（验签后立刻回 200）。
2. 依 `userId` 找到（或创建）对应的 DSH session 与工作文件夹，决定这个 session 的人设：选大肥鱼时通过它的 HTTP bridge 指定 session 人设；选插件自定义人设时，先请大肥鱼在该 session 让开（`none`），再由插件把自定义人设注入 system prompt。
3. 用 `agents.create`／`agents.resume` 在同一个 DSH 进程内创建／接续 Agent，`followup` 一则用户消息，等到 turn 结束、子代理收敛、session flush。
4. 从 session 事件取出最后一段 assistant 文字，用 LINE reply 回复；reply token 过期就自动改 push。
5. 主动传讯排程器每分钟检查一次（间隔、安静时段、上限、概率），符合条件就请 Agent 主动说一句，再 push 出去。

## 人设来源

- **大肥鱼（可选）**：有安装 `dsh-persona-dafeiyu` 时，面板会列出它的人设（内置＋你自定义的），LINE 会逐 session 指定，不会改到 GUI 其他对话。需要它处于 `session` 模式；面板会提示并可一键切换。
- **插件内置自定义人设**：不需要任何个性插件。面板「回复人设 → 自定义人设」可新增／编辑／删除，数据存在 `<DSH_HOME>/line-bot/personas.json`（0600）。选到自定义人设时，插件会请大肥鱼在该 session 停用（若它有安装），再把自定义人设注入这个 agent 的 system prompt。
- 两种人设可以在同一个下拉菜单里选；用户自己用 LINE 指令切换时也一样（`人设`、`人设 2`、`人设 名字`）。

## 每位用户各自的记忆与人设

- **记忆不共享**：每个 LINE 用户都有自己的 DSH session，以及自己的 Agent 工作文件夹 `<DSH_HOME>/line-bot/users/<LINE userId>/`。Agent 看到的文件、`AGENTS.md`、工作区记忆都是该用户专属的，不会读到别人的。
  可在「高级设置 → 一人一个文件夹」关闭（关闭后全部共享 `agent.cwd`，等于回到旧行为）；也能用 `agent.workspaceRoot` 指定放在哪个根目录。
- **人设可自选**：「回复人设 → 允许用户自己换人设」开启时，LINE 用户可以传：
  - `人设`（或 `人格`／`persona`）→ 列出可用人设与目前使用中的人设。
  - `人设 2` → 用列表编号切换；`人设 阿茶` → 用名字切换；`人设 预设` → 回到面板默认。
  切换只影响该用户，下一次回复就会套用；管理员也可以直接在「用户」表的人设下拉帮他改。
- **清空记忆**：用户表按「清空记忆」会删掉该用户的 session 与专属工作文件夹（含里面的文件），重建后从空白开始；只按「重设 session」则保留文件夹。

## 贴吧学习自动同步

「刷贴吧」插件每天最多演化一次自己的语气（存在 `<DSH_HOME>/tieba-duty/persona.json`），这和 LINE 用的大肥鱼人设（`<DSH_HOME>/storages/dsh-persona-dafeiyu/personas.json`）原本是两套、互不相通。这个插件可以把它们接起来：

- 面板「回复人设 → 贴吧学习同步」可设置开关、同步目标人设（只能选大肥鱼的人设；默认关闭，请先选一个）、检查间隔（默认 60 分钟）、是否同步性格数值、写入后是否重载大肥鱼插件。这项功能需要安装大肥鱼插件。
- 每次检查会比对贴吧人设版本；有新版本才动作。写入时只替换目标人设正文中的 `## 貼吧學來的口氣` 段落（没有就附加），不会覆盖其他手写内容；性格数值（温柔／毒舌／抽象／话痨／发图倾向）可一并更新。
- 写入前会备份到 `<DSH_HOME>/line-bot/persona-backups/personas-<时间>.json`。
- 写入后默认会通过 Cordis loader 重启 `dsh-persona-dafeiyu`，让它重新读取 store；重启失败只会记警告，人设文字仍已写入，下次插件重载时生效。
- 贴吧插件若没在跑、或贴吧人设不存在，检查会跳过（`pending` 显示尚未同步的原因）。

## 贴吧动态（让角色知道自己刚刷过）

面板「进阶设置 → 让 Agent 知道贴吧动态」（默认开）会在每次回复前，把「刷贴吧」插件留下的记录整理成一小段背景事实注入 system prompt：

- 最近一次刷贴吧的时间（例如「昨天 22:41，5 小时前」）
- 今天已刷的场次（中午／晚上）
- 今天的贴吧日报有没有生成
- 贴吧人设版本与最后一次回复时间

用户问「你刚刚有刷贴吧吗？」「今天刷过了吗？」时，角色会按实际时间回答，不会编造。这个功能只读 `<DSH_HOME>/tieba-duty/` 的文件，不需要贴吧插件正在运行，也不会写入任何东西；读不到记录时就不注入。

## 疑难排解

- **面板显示「无法连接到 LINE Bot 运行时」**：webServer 可能还没就绪，刷新即可；仍失败就看 DSH 日志里 `[line-bot]` 的消息。
- **webhook 测试失败**：确认 `Use webhook` 已在 LINE console 打开、隧道网址是 https、且本机 webhook server 正在跑（面板绿灯）。
- **改了 lib/*.mjs 没生效**：按「高级设置 → 重新载入 host 模块（开发用）」，不用重装插件。
- **贴吧同步没动作**：先看面板同步状态的 `lastError`；确认贴吧插件的人设文件存在、目标人设 id 正确。按「预览差异」可比对目前段落与即将写入的内容。
- **cloudflared 找不到**：按「下载 cloudflared」，插件会抓官方 release 放到 `<DSH_HOME>/line-bot/bin/`；也可以自己放一份并在 `tunnel.binaryPath` 指定。
- **Agent 回复 403（模型只开放给 Codex）**：在「高级设置 → Agent 模型」把 provider／model 改成 `deepseek-account` / `deepseek-flash`（本机默认已设好），保存后再测一次。
- **人设没套用**：选大肥鱼时，它必须是 `session` 模式；面板会提示，按「切换到大肥鱼 session 模式」即可（这是它官方支持的设置，只影响「可不可以逐 session 指定人设」）。选插件自定义人设则不受此限制。
- **Cloudflare 回 530 / error code 1016**：具名隧道的 DNS CNAME 目标必须是 `<tunnel-id>.cfargotunnel.com`（不是 `.cfd.tunnel`）；另外该子域名若同时被 A 记录占用，边缘会先回那台主机，请确认 DNS 只留一笔 CNAME。

## 隐私

- 这个插件不连任何第三方服务器（除了你设置的 Cloudflare API、LINE API）。没有遥测、没有账号。
- 所有设置与凭证只存在本机 `<DSH_HOME>/line-bot/config.json`（权限 600）；面板只显示遮罩后的值。
- LINE 用户的 session、工作文件夹与人设选择都存在本机，不会上传。
- 仓库与 npm 套件不含任何人的凭证、LINE userId、Cloudflare 账号或域名。

## 安全提醒

- 这等同把 DSH Agent 接到公开的 LINE 账号：拿到 bot 的人可以让 Agent 使用你电脑上的工具。建议在「白名单用户 ID」填入自己的 LINE userId，只允许自己使用。
- 所有凭证都存在本机 `config.json`（600），面板只会看到遮罩后的值；API 只挂在 `127.0.0.1` 的 DSH webServer 上。
- Cloudflare API Token 建议只给必要权限，并在不用时撤销。

## 开发

- host 逻辑：`lib/*.mjs`（`util`／`config`／`line-api`／`persona`／`agent-runner`／`webhook-server`／`cloudflare`／`tunnel`／`nudge`／`tieba-sync`／`host`）。
- 面板：`client.js`（`window.__ModuleLoader__` 注册 `settings.section`）。
- 进入点：`index.js`（挂 `/api/line-bot`、dev reload、卸载清理）。
