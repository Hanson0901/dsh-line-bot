# dsh-line-bot

<p align="center"><img src="icon.svg" width="96" height="96" alt="dsh-line-bot"></p>

**Languages / 語言:** [繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

A plugin that connects a LINE Official Account (Messaging API) to DeepSeek Harness. Replies are produced by the DSH Agent **in the same process** — essentially chatting with your DSH assistant on LINE. Personas can come from the dafeiyu plugin (`dsh-persona-dafeiyu`) when it is installed, or from the plugin's own custom personas (no persona plugin required).

Built in:

- **Webhook server**: opens a local HTTP server on `127.0.0.1`, handling LINE's `X-Line-Signature` verification, event deduplication, and a separate queue per user.
- **Cloudflare Tunnel**: one click opens a quick tunnel (`*.trycloudflare.com`, no Cloudflare account needed), or paste a Cloudflare API token to create a named tunnel + DNS for a fixed URL; once the URL is ready it writes the webhook endpoint back to LINE and runs `webhook/test`.
- **LINE credentials**: fill in Channel ID + Channel Secret and it issues an access token automatically (`/v2/oauth/accessToken`, about 30 days, auto-renewed near expiry); you can also paste an existing Channel Access Token.
- **Personas**: pick any built-in or custom persona from the dafeiyu plugin in the panel, or use the plugin's own custom personas (stored in `<DSH_HOME>/line-bot/personas.json`, add/edit/import). Persona selection is per-session and does not affect other conversations in the GUI.
- **Proactive messages**: a scheduler built into the plugin (no launchd). Each user gets an independent randomized countdown (between a minimum and maximum interval); it only speaks when the countdown is due and the user has been idle long enough. Configurable min/max interval, daily/monthly caps, minimum gap, quiet hours, idle time, unanswered limit (pause after that many unanswered proactive messages, reset when the user replies), target users and prompt. The Agent can reply `SKIP` when it is not a good moment.
- **Full settings panel**: every setting lives under Settings → LINE Bot and is stored in `<DSH_HOME>/line-bot/config.json` (mode 600).

> About "log in with LINE Business ID and have the panel create the bot": since 2024-09 LINE only allows creating a Messaging API channel manually in [LINE Official Account Manager](https://manager.line.biz/), with no public API; LINE Login only authenticates identity and cannot grant management rights over an Official Account. So the panel does not create the bot, but it gives you the correct entry links and automates everything after "you have the Channel ID / Secret" (issuing the token, setting the webhook, testing it).

## Installation

Requirements: DeepSeek Harness **≥ 0.2.0-rc.1**, Node.js **≥ 22**. The persona plugin (dafeiyu, `dsh-persona-dafeiyu`) is **optional** — the plugin's built-in custom personas work without it.

### Option 1: Install from the panel (recommended)

In DSH: **Settings → Plugins → Install bundle**, enter `dsh-line-bot` and install, then refresh the page. A **LINE Bot** page appears in Settings.

### Option 2: One-line npx install

First quit DSH completely (on the desktop app, close the window and make sure no process is left), then run:

```bash
npx dsh-line-bot install
```

It detects which profile to install into (defaults to `desktop`; use `--profile <name>` to choose), installs the package with DSH's bundled pnpm, adds the bundle to the profile, and reminds you to restart DSH.

```bash
npx dsh-line-bot status      # which profile it is installed in, and whether it is enabled
npx dsh-line-bot uninstall   # remove it (settings and credentials are kept)
```

### Option 3: Manual

```bash
dsh plugin --profile desktop add dsh-line-bot
```

Then add `dsh-line-bot` to the `dsh.profile.bundles` array in `~/.dsh/profiles/desktop/package.json` (see what `npx dsh-line-bot install` does), or install from the panel instead.

> If it is not on npm yet, you can install directly from GitHub:
>
> ```bash
> npx github:Hanson0901/dsh-line-bot install --spec github:Hanson0901/dsh-line-bot
> ```
>
> Or from source: `git clone https://github.com/Hanson0901/dsh-line-bot.git`, then choose that folder in the DSH panel's "Install bundle", or run `dsh plugin --profile desktop add /path/to/dsh-line-bot`.

## Companion plugins (optional)

The bot works on its own; these plugins add capabilities:

| Plugin | What it adds | Recommended |
| --- | --- | --- |
| `dsh-persona-dafeiyu` | Persona catalog and Tieba sync | Yes |
| `dsh-meme` | Image/sticker replies | Yes |
| `dsh-tieba-dive` | Source of Tieba learning sync | Optional |

The install CLI detects what is missing and offers to install it:

```bash
npx dsh-line-bot install --with-companions
npx dsh-line-bot install --no-companions
```

Without them: no dafeiyu means only plugin-local personas; no dsh-meme means text-only replies; no dsh-tieba-dive means Tieba sync stays off.

## First run (5 steps)

1. **Create / obtain credentials**: go to [LINE Official Account Manager](https://manager.line.biz/) and create an Official Account → [LINE Developers Console](https://developers.line.biz/console/) and create (or pick) a Messaging API channel → open the **Use webhook** toggle on the "Messaging API" tab → copy the **Channel ID** and **Channel secret**.
2. **Fill in the panel**: under "LINE Bot → LINE credentials", paste the Channel ID and Channel Secret, click "Save changes" → "Verify and read bot info". On success you will see the bot's name and Basic ID.
3. **Start the webhook server**: on "Overview", click "Start all", or "Start" to bring up both the webhook server and the tunnel (auto-start is on by default).
4. **Open the tunnel**: for a quick tunnel just click "Start tunnel"; for a fixed URL, paste an API token under "Cloudflare Tunnel" → "Verify API token" → "Create/update tunnel and DNS" (token permissions: Account → Cloudflare Tunnel → Edit, Zone → DNS → Edit, Zone → Zone → Read). A quick tunnel's URL changes on every restart (the plugin writes the new URL back to the LINE webhook automatically); a named tunnel's URL is fixed.
5. **Auto-configure the webhook**: once the tunnel is ready the endpoint is PUT to LINE automatically; if that fails, click "Apply tunnel URL to webhook" and then "Test webhook". After that, add the bot as a friend in LINE and send it a message; the first message lands in the pending queue — approve your userId under Users in the panel before the bot replies (the allowlist starts empty).

## Panel sections

At the top of the panel is a **sticky save bar**: "Save changes / Refresh" stays visible wherever you scroll. Below it is a quick navigation menu; clicking an item jumps to that section (the current section is highlighted while scrolling).

| Section | Contents |
| --- | --- |
| Overview | Green-light status for webhook server / tunnel / LINE / persona / proactive messages, public URL, one-click bring-up and start/stop |
| LINE credentials | Channel ID, Channel Secret, Access Token, auto-issue, loading animation, bot info, webhook apply/test, allow-list |
| Cloudflare Tunnel | quick / API token modes, token, hostname, tunnel name, Account/Zone ID, download cloudflared, start/stop, auto-configure webhook, bring your own public URL |
| Model & provider | Pick the provider/model and reasoning effort for LINE replies; disables DeepSeek balance when the provider is not deepseek-account |
| Reply persona | Choose a persona (dafeiyu or a plugin custom one), add/edit/delete custom personas, copy the current persona into a custom one, enforce, allow users to switch personas, switch dafeiyu to session mode, test an Agent reply |
| Tieba learning sync | Writes Tieba tone samples into the persona (built-ins use an overlay), preview diff, sync now |
| Jokes | Text joke library: built-in seeds, Tieba quotes, wanjiqi barrage memes; per-source toggles, per-turn injection count, add/delete entries |
| Personal memory | Per-user long-term memory, expiry cleanup, daily self-review, manual delete |
| Memes | Reply with images/stickers from the dsh-meme library, enable/disable, image limit, and sample previews |
| Sticker & image vision | Fetch incoming LINE stickers or images and show them to the model; when the model cannot read images, describe them with modlens or a vision model (can be disabled) |
| DeepSeek balance | Current balance, per-turn context, low-balance proactive reminder, threshold and cooldown (deepseek-account only) |
| Proactive messages | Toggle, per-user countdown, min/max interval, unanswered limit, daily/monthly caps, minimum gap, quiet hours, idle, target users, prompt, send a test now, statistics (next possible time and paused users) |
| Users | Pending approval queue (approve / deny), the DSH session each LINE user maps to, their own workspace folder, their current persona (editable), message count, last interaction, clear memory / reset session |
| Groups | Per-group session, workspace folder, persona, message count; reply chance when not addressed; always reply on @ / quote; clear group memory |
| Advanced | Port, Agent provider/model/effort/cwd/timeout, one workspace per user (and its root), welcome/error/empty replies, logs, reload host modules (dev) |

## Configuration files

- `<DSH_HOME>/line-bot/config.json`: all settings, including the LINE secret and Cloudflare token (mode 600; plaintext is never returned to the panel).
- `<DSH_HOME>/line-bot/state.json`: LINE user ↔ DSH session mapping, message counts, proactive-message counters, webhook state.
- `<DSH_HOME>/line-bot/logs/YYYY-MM-DD.log`: daily logs (the panel also shows the last 400 lines).

`DSH_HOME` defaults to `~/.dsh`.

## How it works

1. LINE POSTs a message to the Cloudflare tunnel → the plugin's webhook server (after signature verification it returns 200 immediately).
2. It finds (or creates) the DSH session and workspace folder for that `userId`, then decides the session's persona: for dafeiyu it sets the session persona through dafeiyu's HTTP bridge; for a plugin custom persona it first asks dafeiyu to step aside in that session (`none`), then injects the custom persona into the system prompt.
3. It creates/resumes the Agent in the same DSH process with `agents.create` / `agents.resume`, sends one user message with `followup`, and waits for the turn to end, subagents to settle, and the session to flush.
4. It takes the last assistant text from the session events and replies with LINE reply; if the reply token has expired it falls back to push.
5. Every minute the scheduler checks each user's countdown; when it is due and the user has been idle long enough it asks the Agent to say something on its own and pushes it. After too many unanswered proactive messages it pauses until the user replies.

## Model & provider

The "Model & provider" card chooses the provider/model used for LINE replies:

- Providers come from this DSH profile; models are fetched live and the first one is preselected when you pick a provider.
- "Follow DSH default" leaves the choice to `agentDefaultModel` (the panel shows the effective value).
- Reasoning effort can stay empty to use the provider default.
- DeepSeek balance and low-balance reminders only work when the provider is `deepseek-account`; other providers grey out that card, and switching back restores it.

## Persona sources

- **dafeiyu (optional)**: when `dsh-persona-dafeiyu` is installed, the panel lists its personas (built-in + your own); LINE selects them per session, without changing other GUI conversations. It must be in `session` mode; the panel tells you and offers a one-click switch.
- **Plugin custom personas**: no persona plugin required. In "Reply persona → Custom personas" you can add/edit/delete them; data lives in `<DSH_HOME>/line-bot/personas.json` (0600). When a custom persona is selected, the plugin asks dafeiyu to opt out in that session (if it is installed), then injects the custom persona into that agent's system prompt.
- Both kinds appear in the same dropdown. The same applies when a user switches with a LINE command (`人設`, `人設 2`, `人設 <name>`).

## Groups and multi-user chats

When the bot is added to a group (or a multi-user room):

- **Being @-mentioned always triggers a reply**, and **quoting any message always triggers a reply**; any other message is answered only when a dice roll against the *group reply chance* (default 15%) succeeds, otherwise it stays quiet.
- Each group gets its own **DSH session, workspace folder, persona and personal memory**, separate from direct chats and other groups.
- The `persona` command works in groups too; the panel's **Groups** card lets you tune the reply chance, toggles, per-group persona and clear a group's memory.
- Each member has **their own memory points** inside a group; replies also look at the last 4–6 messages from others so the bot can pick up the thread.
- If you join a group late, use **Import chat** on the Groups card and pick a LINE-exported `.txt`; it builds a group summary and per-member memory points (stored locally only).
- Proactive messages and DeepSeek balance reminders still target direct chats only.

## Per-user memory and personas

- **Memory is not shared**: every LINE user gets their own DSH session and their own Agent workspace folder `<DSH_HOME>/line-bot/users/<LINE userId>/`. The files the Agent sees, `AGENTS.md`, and workspace memory are specific to that user; nobody reads anyone else's.
  You can turn this off under "Advanced → One workspace per user" (off means everyone shares `agent.cwd`, i.e. the old behaviour); you can also point `agent.workspaceRoot` at another root.
- **Users can choose their persona**: when "Reply persona → Allow users to switch personas" is on, LINE users can send:
  - `人設` (or `人格` / `persona`) → lists available personas and the current one.
  - `人設 2` → switch by list index; `人設 阿茶` → switch by name; `人設 預設` → back to the panel default.
  The switch only affects that user and applies from the next reply; an admin can also change it from the persona dropdown in the "Users" table.
- **Clear memory**: "Clear memory" in the Users table deletes that user's session and their workspace folder (including files), starting from a clean slate; "Reset session" only keeps the folder.

## Tieba learning auto-sync

The "dive into Tieba" plugin evolves its own tone at most once a day (stored in `<DSH_HOME>/tieba-duty/persona.json`), and that is a separate system from the dafeiyu persona LINE uses (`<DSH_HOME>/storages/dsh-persona-dafeiyu/personas.json`). This plugin can bridge them:

- In the panel, "Reply persona → Tieba learning sync" lets you set the toggle, the target persona (any dafeiyu persona, including built-ins), the check interval (default 60 minutes), whether to sync personality numbers, and whether to reload the dafeiyu plugin after writing. Built-in personas cannot be edited in place, so their learning goes to `<DSH_HOME>/line-bot/persona-overlays/<id>.md` and is injected every turn without reloading; custom personas are edited directly.
- Each check compares the Tieba persona version; it only acts on a new version. It replaces only the `## 貼吧學來的口氣` section of the target persona text (appending it if missing) and never overwrites other hand-written content; the personality numbers (gentle / sharp / abstract / talkative / image bias) can be updated too.
- Before writing it backs up to `<DSH_HOME>/line-bot/persona-backups/personas-<time>.json`.
- After writing it restarts `dsh-persona-dafeiyu` through the Cordis loader so it re-reads the store; a failed restart is only a warning — the text is already written and takes effect on the next plugin reload.
- If the Tieba plugin is not running or the Tieba persona does not exist, the check is skipped (`pending` shows why it has not synced yet).

## Jokes and memes (text)

The **Jokes** panel lets the persona use a little wordplay. Three sources can be toggled independently:

- **Built-in seeds**: 10 common internet jokes with usage notes.
- **Tieba quotes**: import highly-liked short replies from the Tieba style library.
- **wanjiqi memes**: 6657 live-room barrage memes (optional; heavier style, off by default).

Each turn injects a few entries; at most one per reply. The prompt tells the model not to explain the joke, not to force it, and not to use jokes in serious situations. Add your own by filling in the text and usage fields, then **Add to joke library**; the file lives at `<DSH_HOME>/line-bot/jokes.json`.

**Add meme bars to Tieba** appends 弱智吧, 抽象吧, 搞笑吧 and 梗吧 to the Tieba plugin's bar list (with a backup). You still need to start a Tieba round for it to learn.

## Tieba activity awareness

With **Advanced → Let the agent know about Tieba activity** enabled (default), each reply is preceded by a small block of background facts injected into the system prompt, built from the Tieba plugin's records:

- when the character last browsed Tieba (e.g. "yesterday 22:41, 5 hours ago")
- which sessions already ran today (noon / night)
- whether today's Tieba report exists
- the Tieba persona version and the last reply time

So when someone asks "did you just browse Tieba?" or "have you been on today?", the character answers from the real timestamps instead of making things up. It only reads files under `<DSH_HOME>/tieba-duty/`; the Tieba plugin does not need to be running, and nothing is written. If no records exist, nothing is injected.

## DeepSeek balance

The **DeepSeek balance** card reads the wallet balance of the DeepSeek account DSH is signed in with (read-only; it never tops up):

- Every reply includes the current balance in the persona's background context, so you can just ask "how much do I have left?".
- When it drops below the threshold (default ¥10, adjustable in the panel), the persona sends you a message **in its own words** asking you to top up. The wording is generated on the spot, not a fixed template.
- Reminders have a cooldown (default 12 hours) and reuse the proactive-messaging quiet hours and target-user settings.
- Requires DSH to be signed in to a DeepSeek account (deepseek-account). If it is not, the card explains why and everything else keeps working.
- The threshold is money, not tokens: Platform shows a wallet balance, and token conversion varies by model and cache hits.

## Personal memory

The character keeps its own memory at `<DSH_HOME>/line-bot/memories.json`, separated per user:

- When something important comes up (preferences, current situation, promises, notable events), it saves it with `line_memory_add` on its own.
- Time-limited items (exams, trips, short-term situations) can carry an expiry date and are deleted automatically; you can also just tell it to forget something.
- Once a day (4 AM by default, configurable in the panel) it reviews the list and removes expired items, one-off events that are over, or facts that no longer hold.
- Each turn only injects the most recent N entries (20 entries / 2000 characters by default); the rest stay in the file. The per-user cap defaults to 120 entries and evicts the oldest.
- Passwords, tokens, ID numbers and similar secrets should not be stored; it avoids them.
- The "Personal memory" panel card shows what it remembers, lets you delete entries, prune expired ones, or trigger a review right away.
## Memes (dsh-meme)

- Sent images are copied to `<DSH_HOME>/line-bot/media/` and kept for 90 days, so LINE can still fetch them when the chat is opened later. With a quick tunnel the public URL changes on restart and older images stop loading; use a named tunnel (API token + your own hostname) for permanent URLs.


The persona can attach a sticker to a text reply, or reply with just an image. Images come from the installed dsh-meme plugin's library (the built-in "大肥鱼" pack has 24 images):

- Each turn injects a numbered sample of the library into context; when the persona wants a picture, it appends `[[meme:#N]]` (or a caption) at the end of its reply, and the plugin turns that into a LINE image message.
- Images are served to LINE through the current Cloudflare public URL (`<url>/media/<token>`), and the URL follows quick-tunnel restarts automatically.
- The panel's "Memes" card can disable the feature, limit images per reply (1–3), and preview library samples. To add or re-tag images, use dsh-meme's own settings.
- When a LINE sticker arrives, the bot fetches the image and shows it to the model; vision-capable models read it directly, otherwise the bot asks modlens, then tries another vision model, and only then falls back to the keywords LINE provides. Turn "Understand stickers" off in the LINE credentials card to use keywords only.
- Regular images work the same way: the bot downloads them through LINE's content API and attaches them to the message; if the model cannot read images, the same modlens / vision-model description path is used. Turn "Understand images" off in the LINE credentials card to skip them.
- Without dsh-meme installed, the feature stays off and replies are text only.
## Diagnostics
- Panel → Advanced → Run diagnostics checks the server, tunnel, public URL, webhook, dsh-meme library, image converters, model, and recent errors; Safe repair only reconnects the tunnel and re-applies the webhook.
- CLI: `npx dsh-line-bot doctor`, `doctor --fix`, `doctor --json`.
- Agent playbook: `AGENTS.md`; symptom table: `TROUBLESHOOTING.md`.

## Troubleshooting

- **The panel says "cannot connect to the LINE Bot runtime"**: webServer may not be ready yet; refresh. If it still fails, look for `[line-bot]` messages in the DSH logs.
- **Webhook test fails**: make sure `Use webhook` is on in the LINE console, the tunnel URL is https, and the local webhook server is running (green in the panel).
- **Changes to `lib/*.mjs` do not take effect**: click "Advanced → Reload host modules (dev)"; you do not need to reinstall the plugin.
- **Tieba sync does nothing**: check `lastError` in the panel's sync status; confirm the Tieba persona file exists and the target persona id is correct. "Preview diff" compares the current section with what is about to be written.
- **cloudflared not found**: click "Download cloudflared" and the plugin fetches the official release into `<DSH_HOME>/line-bot/bin/`; you can also place your own copy and set `tunnel.binaryPath`.
- **Agent replies with 403 (model only available to Codex)**: under "Advanced → Agent model", change provider/model to `deepseek-account` / `deepseek-flash` (already the local default), save, and test again.
- **Persona not applied**: with dafeiyu selected it must be in `session` mode; the panel tells you and offers "Switch dafeiyu to session mode" (an officially supported setting; it only decides whether personas can be picked per session). Plugin custom personas are not affected.
- **Cloudflare returns 530 / error code 1016**: the DNS CNAME target of a named tunnel must be `<tunnel-id>.cfargotunnel.com` (not `.cfd.tunnel`); also, if the subdomain is simultaneously taken by an A record, the edge answers from that host — make sure DNS has only the CNAME.

## Privacy

- The plugin talks to no third-party server other than the Cloudflare API and LINE API you configure. No telemetry, no account.
- All settings and credentials live only on this machine in `<DSH_HOME>/line-bot/config.json` (mode 600); the panel only shows masked values.
- LINE users' sessions, workspace folders and persona choices are stored locally and never uploaded.
- The repository and the npm package contain no credentials, LINE userIds, Cloudflare accounts or domains.

## Security notes

- The allowlist starts empty: unknown users are only queued as pending, with no session and no tool access, until you approve them under Users in the panel.
- This attaches the DSH Agent to LINE: anyone you approve can make the Agent use tools on your computer. Approve only LINE accounts you trust, and review the Users list periodically.
- All credentials are stored locally in `config.json` (600); the panel only shows masked values; the API only listens on the DSH webServer at `127.0.0.1`.
- Give the Cloudflare API token only the permissions it needs, and revoke it when you no longer use it.

## Development

- Host logic: `lib/*.mjs` (`util` / `config` / `line-api` / `persona` / `agent-runner` / `webhook-server` / `cloudflare` / `tunnel` / `nudge` / `tieba-sync` / `host`).
- Panel: `client.js` (registers `settings.section` via `window.__ModuleLoader__`).
- Entry point: `index.js` (mounts `/api/line-bot`, dev reload, cleanup on unload).
