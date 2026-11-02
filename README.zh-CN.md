# dsh-line-bot

<p align="center"><img src="icon.svg" width="96" height="96" alt="dsh-line-bot"></p>

**语言 / Languages:** [繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

把 LINE 官方账号（Messaging API）接进 DeepSeek Harness 的插件。回复由 DSH 的 Agent 在**同一个进程内**产生，等于在 LINE 上跟你的 DSH 助理聊天；人设有两种来源：有安装大肥鱼（`dsh-persona-dafeiyu`）时可以直接选它的人设；也可以只用插件内置的自定义人设（不需要任何个性插件）。

内置：

- **Webhook 服务器**：在本机 `127.0.0.1` 开一个 HTTP server，处理 LINE 的 `X-Line-Signature` 验签、事件去重、每位用户各自的队列。
- **Cloudflare Tunnel**：一键开 quick tunnel（`*.trycloudflare.com`，免 Cloudflare 账号），或贴入 Cloudflare API Token 创建具名隧道＋DNS，取得固定网址；取得网址后自动把 webhook 端点写回 LINE 并跑一次 `webhook/test`。
- **LINE 凭证**：填 Channel ID＋Channel Secret 就能自动签发 access token（`/v2/oauth/accessToken`，约 30 天，快到期会自动续签）；也可以直接贴入既有的 Channel Access Token。
- **没有大肥鱼插件时**：自动改用插件内置的繁体中文版本（大肥鱼／阿茶／听澜），存在同一个 `personas.json`，可以像自定义人设一样点开编辑；装回大肥鱼插件后会自动切回插件的人设。
- **主动传讯**：插件内置排程器（不用 launchd），每位使用者各自倒数（最短～最长间隔随机）；可调最短／最长间隔、每日／每月上限、两则间距、安静时段、对方安静多久才可打扰、连续未回复上限（达上限暂停，对方回话后归零）、指定对象与提示词；Agent 觉得不适合时可以回 `SKIP` 跳过。
- **分段回复**：可把回复依空行（段落）或每个换行拆成多个 LINE 消息框，最多 5 条，不再全部挤在同一条；面板可切换分段方式或关闭。
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

## 搭配插件（可选）

LINE Bot 可以独立运行；装上下面这些插件会多出对应功能：

| 插件 | 用途 | 建议 |
| --- | --- | --- |
| `dsh-persona-dafeiyu` | 人设清单、贴吧同步 | 建议 |
| `dsh-meme` | 让角色回图片/贴图 | 建议 |
| `dsh-tieba-dive` | 贴吧学习同步的来源 | 可选 |

安装时 CLI 会检测缺哪些，并询问要不要一起安装：

```bash
npx dsh-line-bot install --with-companions
npx dsh-line-bot install --no-companions
```

少了它们的影响：没有大肥鱼 → 人设只剩插件自定义的；没有 dsh-meme → 只能回文字；没有刷贴吧 → 贴吧同步自动停用。

## 第一次上线（5 步）

1. **创建／取得凭证**：到 [LINE Official Account Manager](https://manager.line.biz/) 创建官方账号 → [LINE Developers Console](https://developers.line.biz/console/) 创建（或选用）Messaging API channel → 在「Messaging API」分页把 **Use webhook** 打开 → 复制 **Channel ID** 与 **Channel secret**。
2. **填入面板**：「LINE Bot → LINE 凭证」贴入 Channel ID、Channel Secret，按「保存更改」→「验证并读取 bot 信息」。成功会看到 bot 名称与 Basic ID。
3. **启动 webhook 服务器**：面板「状态总览」按「启动全部」，或只按「启动」让 webhook server 与 tunnel 都起来（默认会自动启动）。
4. **开隧道**：Quick tunnel 直接按「启动隧道」；要固定网址就在「Cloudflare Tunnel」贴 API Token →「验证 API Token」→「创建／更新隧道与 DNS」（API Token 权限：Account → Cloudflare Tunnel → Edit、Zone → DNS → Edit、Zone → Zone → Read）。quick tunnel 每次重启网址都会变（插件会自动把新网址写回 LINE webhook）；具名隧道的网址则固定。
5. **自动设置 webhook**：隧道就绪后会自动 PUT 到 LINE；若没成功，按「把隧道网址套到 webhook」再「测试 webhook」。之后在 LINE 加 bot 好友、传消息；第一条消息会进入「待审核」，到面板「使用者」按「核准」后才会开始回复（白名单默认为空）。

## 面板各区

面板最上方是**固定（sticky）保存栏**：滚到任何位置都看得到「保存更改／刷新」；保存栏下方是二级快速菜单，按一下就会跳到对应区块（滚动时也会自动高亮当前区块）。

| 区块 | 内容 |
| --- | --- |
| 状态总览 | webhook server／隧道／LINE／人设／主动传讯的绿灯状态、公开网址、一键上线与启停 |
| LINE 凭证 | Channel ID、Channel Secret、Access Token、自动签发、loading 动画、分段回复、bot 信息、webhook 套用／测试、白名单 |
| Cloudflare Tunnel | quick／API Token 模式、Token、hostname、隧道名称、Account／Zone ID、下载 cloudflared、启停、自动设置 webhook、自行提供的公开网址 |
| 模型与接口来源 | 选择 LINE 回复的 provider／模型与推理强度；非 deepseek-account 时自动停用 DeepSeek 余额 |
| 回复人设 | 选择人设（大肥鱼或插件自定义）、新增／编辑／删除自定义人设、把目前人设复制成自定义、强制套用、允许用户自己换人设、切换大肥鱼 session 模式、测试 Agent 回复 |
| 贴吧学习同步 | 把刷贴吧学到的语气写回人设（内置人设用覆盖层）、预览差异、立即同步 |
| 玩梗 | 文字梗库：内置种子、贴吧金句、wanjiqi 弹幕梗；三个来源可分别开关、每轮注入几条、新增／删除梗 |
| 个人记忆 | 每位用户分开的长期记忆、到期自动删除、每日请角色整理、手动删除 |
| 表情包 | 使用 dsh-meme 图库回图片/贴图、开关、每次最多几张、图库样本 |
| 贴图与图片理解 | 收到 LINE 贴图或一般图片时抓图给模型看；模型不吃图时用 modlens 或另一个视觉模型描述（可关闭） |
| DeepSeek 余额 | 当前余额、每轮注入、低于门槛时由角色主动提醒、提醒门槛与冷却（仅 deepseek-account） |
| 主动传讯 | 开关、每位使用者的倒数、最短／最长间隔、连续未回复上限、每日／每月上限、两则间距、安静时段、idle、指定对象、提示词、立即试传、统计（下次可能时间与暂停人数） |
| 用户 | 每位 LINE 用户对应的 DSH session、专属工作文件夹、目前人设（可直接改）、消息数、上次互动、清空记忆／重设 session |
| 群组 | 每个群组的 session、工作文件夹、人设、消息数；没被点名时的回复概率；被 @／引用一定回；清空群组记忆 |
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
5. 主动传讯排程器每分钟检查一次：逐位使用者到期、且沉默够久才请 Agent 主动说一句，再 push 出去；连续未回复达上限会暂停，对方回话后重新倒数。

## 模型与接口来源

「模型与接口来源」卡决定 LINE 回复要用哪个 provider／模型：

- 来源清单来自这个 DSH profile 已注册的 provider；模型清单即时读取，选 provider 后会自动带入第一个模型。
- 「跟随 DSH 默认」＝不覆写，使用 `agentDefaultModel` 目前的 provider／model（面板会显示实际值）。
- 推理强度可留空跟随 provider 默认。
- 只有 provider 是 `deepseek-account` 时，DeepSeek 余额与低余额提醒才会运作；切到其他来源时该卡会反白停用，切回即恢复。

## 人设来源

- **大肥鱼（可选）**：有安装 `dsh-persona-dafeiyu` 时，面板会列出它的人设（内置＋你自定义的），LINE 会逐 session 指定，不会改到 GUI 其他对话。需要它处于 `session` 模式；面板会提示并可一键切换。
- **插件内置自定义人设**：不需要任何个性插件。面板「回复人设 → 自定义人设」可新增／编辑／删除，数据存在 `<DSH_HOME>/line-bot/personas.json`（0600）。选到自定义人设时，插件会请大肥鱼在该 session 停用（若它有安装），再把自定义人设注入这个 agent 的 system prompt。
- 两种人设可以在同一个下拉菜单里选；用户自己用 LINE 指令切换时也一样（`人设`、`人设 2`、`人设 名字`）。

## 群组与多人聊天室

Bot 被加入群组（或多人聊天室）后：

- **被 @ 一定回**、**被引用（回复某条消息）一定回**；其他消息按「群组回复概率」掷骰（默认 15%），没中就安静。
- 每个群组有自己的 **DSH session、工作文件夹、人设与个人记忆**，和一对一聊天、其他群组分开。
- 群组里也能用 `人设` 指令；面板「群组」卡可调回复概率、开关、个别群组的人设与清空记忆。
- 每个成员在群组里有**自己的记忆点**；回复时也会参考最近 4～6 条别人的消息，接得上话题。
- 比较晚加入群组时，可以在面板“群组”卡片按“汇入聊天”，选择 LINE 导出的 `.txt`；会整理出群组摘要与各成员的记忆点（只存本机）。
- 主动传讯与 DeepSeek 余额提醒仍然只找一对一的对象。

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

- 面板「回复人设 → 贴吧学习同步」可设置开关、同步目标人设（可选大肥鱼的人设，含内置）、检查间隔（默认 60 分钟）、是否同步性格数值、写入后是否重载大肥鱼插件。内置人设（大肥鱼／阿茶／听澜）不能改原文，会写入 `<DSH_HOME>/line-bot/persona-overlays/<id>.md` 覆盖层，每轮注入、不用重载；自订人设才直接改本文。
- 每次检查会比对贴吧人设版本；有新版本才动作。写入时只替换目标人设正文中的 `## 貼吧學來的口氣` 段落（没有就附加），不会覆盖其他手写内容；性格数值（温柔／毒舌／抽象／话痨／发图倾向）可一并更新。
- 写入前会备份到 `<DSH_HOME>/line-bot/persona-backups/personas-<时间>.json`。
- 写入后默认会通过 Cordis loader 重启 `dsh-persona-dafeiyu`，让它重新读取 store；重启失败只会记警告，人设文字仍已写入，下次插件重载时生效。
- 贴吧插件若没在跑、或贴吧人设不存在，检查会跳过（`pending` 显示尚未同步的原因）。

## 玩梗（文字梗）

面板「玩梗」让角色自然用一点文字梗，三个来源可分别开关：

- **内置种子**：10 条常见网络梗，附使用时机。
- **贴吧金句**：从「刷贴吧」的风格库导入高赞短句。
- **wanjiqi 梗库**：6657 直播间弹幕梗（可选；风格较重，默认关闭）。

每轮只带入几条给角色参考，一次回复最多用一个；提示词要求不要解释梗、不要硬塞、正经或难过时不要用。想自己加梗，在卡片下方填写「梗」与「用法」后按「新增到梗库」；梗库位于 `<DSH_HOME>/line-bot/jokes.json`。

「加入梗类贴吧」会把弱智吧、抽象吧、搞笑吧、梗吧加入刷贴吧的 bars（会先备份设置）；要让它真的去刷，仍需要在刷贴吧那边启动。

## 贴吧动态（让角色知道自己刚刷过）

面板「进阶设置 → 让 Agent 知道贴吧动态」（默认开）会在每次回复前，把「刷贴吧」插件留下的记录整理成一小段背景事实注入 system prompt：

- 最近一次刷贴吧的时间（例如「昨天 22:41，5 小时前」）
- 今天已刷的场次（中午／晚上）
- 今天的贴吧日报有没有生成
- 贴吧人设版本与最后一次回复时间

用户问「你刚刚有刷贴吧吗？」「今天刷过了吗？」时，角色会按实际时间回答，不会编造。这个功能只读 `<DSH_HOME>/tieba-duty/` 的文件，不需要贴吧插件正在运行，也不会写入任何东西；读不到记录时就不注入。

## DeepSeek 余额

面板的「DeepSeek 余额」卡会读取 DSH 当前登录的 DeepSeek 账号钱包余额（只读，不会充值）：

- 每轮回复都会把当前余额放进角色的背景信息，所以可以直接问它「我还剩多少」。
- 低于门槛（默认 ¥10，可在面板调整）时，它会用**自己的语气**发一条消息提醒你充值；内容不是固定模板。
- 提醒有冷却时间（默认 12 小时），并沿用「主动传讯」的静音时段与目标用户设置。
- 需要 DSH 已登录 DeepSeek 账号（deepseek-account）。未登录或该 profile 没有这个服务时，卡片会说明原因，其他功能不受影响。
- 门槛用的是钱包金额，不是 token 数。

## 个人记忆

角色有一份自己的记忆，保存在 `<DSH_HOME>/line-bot/memories.json`，每位用户分开：

- 对话中出现它觉得重要的信息（喜好、近况、承诺、重要事件），它会自己用 `line_memory_add` 记下来，不用你交代。
- 有期限的事（考试、旅行、短期状况）可以标到期日，时间到自动删除；你也可以直接叫它「忘掉这件事」。
- 每天（默认凌晨 4 点，面板可改）它会自己整理一次：把过期、一次性事件已结束、或明显不再成立的记忆删掉。
- 每轮只带入最近的 N 笔（默认 20 笔、2000 字），其余仍留在文件里；每人上限默认 120 笔，超过时删除最旧的。
- 密码、token、证件号等敏感资料不该叫它记，它也会避免。
- 面板的「个人记忆」卡可以看目前记了什么、手动删除、立即清理到期、或现在就叫它整理一次。
## 表情包（dsh-meme）

- 送出的图片会复制到 `<DSH_HOME>/line-bot/media/`（保留 90 天），LINE 之后才打开聊天室也抓得到。公开网址若用 quick tunnel，重启后网址会变，旧消息里的图片会失效；要永久固定请改用自定义域名（API Token 隧道）。


角色可以在文字后面配一张贴图，也可以只回一张图。图片来自已安装的 dsh-meme 插件的图库（内置「大肥鱼」24 张）：

- 每轮会把图库样本（编号＋描述）带进 context；角色想配图时在回复最后加 `[[meme:#编号]]`（或描述），插件再组成 LINE 的 image message。
- 图片通过当前的 Cloudflare 公开网址（`<网址>/media/<token>`）提供给 LINE；quick tunnel 换网址后会自动跟上。
- 面板「表情包」卡可以开关、限制每次最多几张（1～3），并预览图库样本。要新增图片或改分类，请用 dsh-meme 自己的设置。
- 收到 LINE 贴图时，会抓贴图图片交给模型看；模型支持图片就直接读，否则先用 modlens 描述，再不支持就改用另一个视觉模型，最后才退回 LINE 提供的关键词。可在「LINE 凭证」卡关闭「看得懂贴图」。
- 一般图片也一样：通过 LINE content API 下载后直接附给模型；模型不吃图时走同一套 modlens／视觉模型描述。可在「LINE 凭证」卡关闭「看得懂一般图片」。
- 没安装 dsh-meme 时该功能会自动停用，只回文字。
## 诊断与修复
- 面板「高级设置 → 执行诊断」会检查服务器、Tunnel、公开网址、webhook、表情包图库、转图工具、模型与最近错误；「自动修复（安全）」只会重连 tunnel、重设 webhook。
- 终端：`npx dsh-line-bot doctor`、`npx dsh-line-bot doctor --fix`、`doctor --json`。
- 给 Agent 的调试流程在 `AGENTS.md`，症状对照在 `TROUBLESHOOTING.md`。

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

- 白名单默认为空：陌生人发消息只会进入待审核，不会建立 session、不会调用工具；在面板「使用者」核准后才会开始回复。
- 这等同把 DSH Agent 接到公开的 LINE 账号：拿到 bot 的人可以让 Agent 使用你电脑上的工具。建议在「白名单用户 ID」填入自己的 LINE userId，只允许自己使用。
- 所有凭证都存在本机 `config.json`（600），面板只会看到遮罩后的值；API 只挂在 `127.0.0.1` 的 DSH webServer 上。
- Cloudflare API Token 建议只给必要权限，并在不用时撤销。

## 开发

- host 逻辑：`lib/*.mjs`（`util`／`config`／`line-api`／`persona`／`agent-runner`／`webhook-server`／`cloudflare`／`tunnel`／`nudge`／`tieba-sync`／`host`）。
- 面板：`client.js`（`window.__ModuleLoader__` 注册 `settings.section`）。
- 进入点：`index.js`（挂 `/api/line-bot`、dev reload、卸载清理）。
