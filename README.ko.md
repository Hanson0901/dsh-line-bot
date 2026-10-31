# dsh-line-bot

<p align="center"><img src="icon.svg" width="96" height="96" alt="dsh-line-bot"></p>

**언어 / Languages:** [繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

LINE 공식 계정(Messaging API)을 DeepSeek Harness에 연결하는 플러그인입니다. 답장은 DSH Agent가 **같은 프로세스 안에서** 생성하므로, LINE에서 내 DSH 어시스턴트와 대화하는 것과 같습니다. 페르소나는 大肥魚(`dsh-persona-dafeiyu`)가 설치되어 있으면 그 페르소나를 그대로 고를 수 있고, 페르소나 플러그인 없이 플러그인 내장 커스텀 페르소나만 사용할 수도 있습니다.

내장 기능:

- **Webhook 서버**: 로컬 `127.0.0.1`에 HTTP 서버를 열고 LINE의 `X-Line-Signature` 검증, 이벤트 중복 제거, 사용자별 큐를 처리합니다.
- **Cloudflare Tunnel**: 원클릭 quick tunnel(`*.trycloudflare.com`, Cloudflare 계정 불필요) 또는 Cloudflare API 토큰을 붙여 넣어 이름 있는 터널＋DNS를 만들고 고정 URL을 얻습니다. URL이 준비되면 webhook 엔드포인트를 LINE에 다시 쓰고 `webhook/test`를 실행합니다.
- **LINE 자격 증명**: Channel ID와 Channel Secret을 입력하면 access token을 자동 발급합니다(`/v2/oauth/accessToken`, 약 30일, 만료 전 자동 갱신). 기존 Channel Access Token을 붙여 넣어도 됩니다.
- **페르소나**: 패널에서 大肥魚 플러그인의 내장／커스텀 페르소나를 고르거나, 플러그인 내장 커스텀 페르소나(`<DSH_HOME>/line-bot/personas.json`, 추가/편집/가져오기)를 쓸 수 있습니다. 페르소나는 세션 단위로 지정되며 GUI의 다른 대화에는 영향을 주지 않습니다.
- **능동 메시지**: 플러그인 내장 스케줄러(launchd 불필요). 확률, 간격, 일일/월간 상한, 최소 간격, 조용한 시간대, 상대가 얼마나 조용했을 때 말을 걸지, 대상 사용자, 프롬프트를 설정할 수 있습니다. Agent가 지금은 아니라고 판단하면 `SKIP`을 반환해 건너뜁니다.
- **전체 설정 패널**: 모든 설정이 "설정 → LINE Bot"에 있으며 `<DSH_HOME>/line-bot/config.json`(모드 600)에 저장됩니다.

> "LINE Business ID로 로그인해서 패널에서 bot을 만드는" 것에 대해: LINE은 2024-09부터 Messaging API 채널 생성을 [LINE Official Account Manager](https://manager.line.biz/)에서 수동으로만 허용하며 공개 API가 없습니다. LINE Login도 신원 확인일 뿐 공식 계정 관리 권한을 얻을 수 없습니다. 그래서 패널은 bot을 만들지 않지만, 올바른 진입 링크를 알려 주고 "Channel ID / Secret을 얻은 뒤"의 모든 단계(토큰 발급, webhook 설정, 테스트)를 자동화합니다.

## 설치

요구 사항: DeepSeek Harness **≥ 0.2.0-rc.1**, Node.js **≥ 22**. 페르소나 플러그인(大肥魚 `dsh-persona-dafeiyu`)은 **선택**입니다 — 설치하지 않아도 플러그인 내장 커스텀 페르소나를 쓸 수 있습니다.

### 방법 1: 패널에서 설치(권장)

DSH → **설정 → 플러그인 → bundle 설치**에서 `dsh-line-bot`을 입력해 설치하고 페이지를 새로 고칩니다. 설정 왼쪽에 **LINE Bot**이 생깁니다.

### 방법 2: npx 원라인 설치

먼저 DSH를 완전히 종료합니다(데스크톱 앱은 창을 닫고 메뉴 막대／프로세스가 남아 있지 않은지 확인). 그다음 실행합니다.

```bash
npx dsh-line-bot install
```

어느 profile에 설치할지 자동으로 판단하고(기본 `desktop`, `--profile <이름>`으로 지정 가능), DSH 내장 pnpm으로 패키지를 설치한 뒤 bundle을 profile에 추가하고 DSH 재시작을 안내합니다.

```bash
npx dsh-line-bot status      # 어느 profile에 설치되어 있고 활성화되어 있는지
npx dsh-line-bot uninstall   # 제거(설정과 자격 증명은 유지)
```

### 방법 3: 수동

```bash
dsh plugin --profile desktop add dsh-line-bot
```

그다음 `~/.dsh/profiles/desktop/package.json`의 `dsh.profile.bundles` 배열에 `dsh-line-bot`을 추가합니다(`npx dsh-line-bot install`이 하는 일 참고). 패널 설치를 써도 됩니다.

> 아직 npm에 배포하지 않았다면 GitHub에서 바로 설치할 수 있습니다.
>
> ```bash
> npx github:Hanson0901/dsh-line-bot install --spec github:Hanson0901/dsh-line-bot
> ```
>
> 소스에서 설치하려면 `git clone https://github.com/Hanson0901/dsh-line-bot.git` 후 DSH 패널의 "bundle 설치"에서 그 폴더를 선택하거나 `dsh plugin --profile desktop add /path/to/dsh-line-bot`을 실행합니다.

## 함께 쓰는 플러그인 (선택)

LINE Bot은 단독으로도 동작하며, 아래 플러그인을 설치하면 기능이 늘어납니다:

| 플러그인 | 추가 기능 | 권장 |
| --- | --- | --- |
| `dsh-persona-dafeiyu` | 페르소나 목록, 톄바 동기화 | 권장 |
| `dsh-meme` | 이미지/스티커 답장 | 권장 |
| `dsh-tieba-dive` | 톄바 학습 동기화 소스 | 선택 |

설치 CLI는 없는 것을 감지해 함께 설치할지 물어봅니다:

```bash
npx dsh-line-bot install --with-companions
npx dsh-line-bot install --no-companions
```

없을 때: 대비어 없음 → 플러그인 자체 페르소나만, dsh-meme 없음 → 텍스트만, 톄바 플러그인 없음 → 톄바 동기화 꺼짐.

## 첫 구동(5단계)

1. **자격 증명 준비**: [LINE Official Account Manager](https://manager.line.biz/)에서 공식 계정 생성 → [LINE Developers Console](https://developers.line.biz/console/)에서 Messaging API 채널 생성(또는 선택) → "Messaging API" 탭에서 **Use webhook** 켜기 → **Channel ID**와 **Channel secret** 복사.
2. **패널에 입력**: "LINE Bot → LINE 자격 증명"에 Channel ID와 Channel Secret을 붙여 넣고 "변경 저장" → "검증하고 bot 정보 읽기"를 누릅니다. 성공하면 bot 이름과 Basic ID가 표시됩니다.
3. **webhook 서버 시작**: "개요"에서 "모두 시작"을 누르거나 "시작"을 눌러 webhook 서버와 터널을 함께 올립니다(기본값은 자동 시작).
4. **터널 열기**: Quick tunnel은 "터널 시작"만 누르면 됩니다. 고정 URL이 필요하면 "Cloudflare Tunnel"에서 API 토큰을 붙여 넣고 → "API 토큰 검증" → "터널과 DNS 생성／업데이트"(토큰 권한: Account → Cloudflare Tunnel → Edit, Zone → DNS → Edit, Zone → Zone → Read). quick tunnel은 재시작할 때마다 URL이 바뀌며(플러그인이 새 URL을 LINE webhook에 자동으로 다시 씁니다), 이름 있는 터널의 URL은 고정입니다.
5. **webhook 자동 설정**: 터널이 준비되면 자동으로 LINE에 PUT합니다. 실패하면 "터널 URL을 webhook에 적용" → "webhook 테스트"를 누릅니다. 그다음 LINE에서 bot을 친구 추가하고 메시지를 보내면 됩니다.

## 패널 구성

패널 맨 위에는 **고정(sticky) 저장 바**가 있어 어디까지 스크롤해도 "변경 저장／새로 고침"이 보입니다. 그 아래에는 빠른 이동 메뉴가 있으며 누르면 해당 섹션으로 이동합니다(스크롤 중에는 현재 섹션이 자동으로 강조됩니다).

| 섹션 | 내용 |
| --- | --- |
| 개요 | webhook 서버／터널／LINE／페르소나／능동 메시지 상태, 공개 URL, 원클릭 기동과 시작/중지 |
| LINE 자격 증명 | Channel ID, Channel Secret, Access Token, 자동 발급, 로딩 표시, bot 정보, webhook 적용/테스트, 허용 목록 |
| Cloudflare Tunnel | quick／API 토큰 모드, 토큰, hostname, 터널 이름, Account／Zone ID, cloudflared 다운로드, 시작/중지, webhook 자동 설정, 직접 제공하는 공개 URL |
| 모델과 공급자 | LINE 답장에 쓸 provider／모델과 추론 강도 선택. deepseek-account가 아니면 DeepSeek 잔액 자동 비활성화 |
| 답장 페르소나 | 페르소나 선택(大肥魚 또는 플러그인 커스텀), 커스텀 페르소나 추가/편집/삭제, 현재 페르소나를 커스텀으로 복사, 강제 적용, 사용자 직접 전환 허용, 大肥魚를 session 모드로 전환, Agent 답장 테스트 |
| 貼吧 학습 동기화 | 貼吧에서 배운 말투를 페르소나의 「貼吧学来的口气」 섹션으로 기록, 차이 미리보기, 지금 동기화 |
| 개인 기억 | 사용자별 장기 기억, 만료 자동 삭제, 매일 자기 정리, 수동 삭제 |
| 이모티콘 | dsh-meme 라이브러리로 이미지/스티커 답장, 켜기/끄기, 1회 최대 장수, 샘플 미리보기 |
| 스티커 이해 | LINE 스티커를 받으면 이미지를 가져와 모델에 보여 줌 (끌 수 있음) |
| DeepSeek 잔액 | 현재 잔액, 매 턴 주입, 잔액이 적을 때 캐릭터가 먼저 알림, 기준 금액과 쿨다운(deepseek-account 전용) |
| 능동 메시지 | 켜기/끄기, 확률, 간격, 일일/월간 상한, 최소 간격, 조용한 시간대, idle, 대상 사용자, 프롬프트, 지금 시험 발송, 통계 |
| 사용자 | LINE 사용자별 DSH 세션, 전용 작업 폴더, 현재 페르소나(직접 변경 가능), 메시지 수, 마지막 상호작용, 기억 지우기／세션 재설정 |
| 그룹 | 그룹별 세션, 작업 폴더, 페르소나, 메시지 수; 호출되지 않았을 때 답장 확률; @／인용 시 항상 답장; 그룹 기억 지우기 |
| 고급 설정 | 포트, Agent provider/model/effort/cwd/타임아웃, 사용자별 작업 폴더(루트 포함), 환영／오류／빈 답장, 로그, 개발용 host 리로드 |

## 설정 파일

- `<DSH_HOME>/line-bot/config.json`: 모든 설정. LINE secret과 Cloudflare 토큰 포함(모드 600, 평문은 패널에 반환하지 않음).
- `<DSH_HOME>/line-bot/state.json`: LINE 사용자 ↔ DSH 세션 매핑, 메시지 수, 능동 메시지 카운터, webhook 상태.
- `<DSH_HOME>/line-bot/logs/YYYY-MM-DD.log`: 일별 로그(패널에도 최근 400줄 표시).

`DSH_HOME`의 기본값은 `~/.dsh`입니다.

## 동작 방식

1. LINE이 메시지를 Cloudflare 터널로 POST → 플러그인 webhook 서버(서명 검증 후 즉시 200 반환).
2. `userId`로 해당 DSH 세션과 작업 폴더를 찾거나 만들고, 그 세션의 페르소나를 정합니다. 大肥魚를 고르면 大肥魚의 HTTP bridge로 세션 페르소나를 지정하고, 플러그인 커스텀 페르소나를 고르면 먼저 大肥魚에게 그 세션에서 물러나 달라고 한 뒤(`none`) 플러그인이 커스텀 페르소나를 system prompt에 주입합니다.
3. `agents.create`／`agents.resume`로 같은 DSH 프로세스 안에서 Agent를 만들거나 이어 받고, `followup`으로 사용자 메시지 하나를 보낸 뒤 turn 종료, 하위 에이전트 수렴, 세션 flush를 기다립니다.
4. 세션 이벤트에서 마지막 assistant 텍스트를 꺼내 LINE reply로 답장합니다. reply token이 만료되었으면 자동으로 push로 전환합니다.
5. 능동 메시지 스케줄러가 1분마다 확인하고(간격, 조용한 시간대, 상한, 확률) 조건을 만족하면 Agent에게 한마디 하게 한 뒤 push합니다.

## 모델과 공급자

「모델과 공급자」카드는 LINE 답장에 쓸 provider／모델을 정합니다:

- provider는 이 DSH profile에 등록된 목록, 모델은 실시간으로 읽어 오며 provider를 고르면 첫 모델이 자동 입력됩니다.
- 「DSH 기본값 따르기」는 `agentDefaultModel`의 provider／모델을 그대로 씁니다(패널에 실제 값 표시).
- 추론 강도는 비워 두면 provider 기본값.
- provider가 `deepseek-account`일 때만 DeepSeek 잔액과 잔액 알림이 동작합니다. 다른 provider에서는 카드가 회색으로 비활성화되고, 돌아오면 복구됩니다.

## 페르소나 출처

- **大肥魚(선택)**: `dsh-persona-dafeiyu`가 설치되어 있으면 패널에 그 페르소나(내장＋직접 만든 것)가 나옵니다. LINE에서는 세션 단위로 지정되며 GUI의 다른 대화는 바뀌지 않습니다. `session` 모드여야 하며, 패널이 안내하고 원클릭으로 전환할 수 있습니다.
- **플러그인 내장 커스텀 페르소나**: 페르소나 플러그인이 필요 없습니다. "답장 페르소나 → 커스텀 페르소나"에서 추가/편집/삭제할 수 있고 데이터는 `<DSH_HOME>/line-bot/personas.json`(0600)에 저장됩니다. 커스텀 페르소나를 고르면 플러그인은 (설치되어 있다면) 大肥魚에게 그 세션에서 중지해 달라고 한 뒤 커스텀 페르소나를 해당 agent의 system prompt에 주입합니다.
- 두 종류 모두 같은 드롭다운에서 선택할 수 있습니다. 사용자가 LINE 명령으로 바꾸는 경우도 같습니다(`人設`, `人設 2`, `人設 이름`).

## 그룹 및 다인 채팅

Bot이 그룹(또는 다인 룸)에 추가되면:

- **@로 호출되면 항상 답장**하고, **인용(답장)되면 항상 답장**합니다. 그 외에는 "그룹 답장 확률"(기본 15%) 주사위를 굴려 당첨될 때만 답장합니다.
- 그룹마다 **DSH 세션, 작업 폴더, 페르소나, 개인 기억**이 따로 있으며 1:1 채팅이나 다른 그룹과 분리됩니다.
- 그룹에서도 `人設` 명령을 쓸 수 있습니다. 패널의 "그룹" 카드에서 답장 확률, 스위치, 그룹별 페르소나, 기억 지우기를 설정할 수 있습니다.
- 그룹 안에서도 **멤버마다 별도의 기억**을 가집니다. 답장할 때 최근 4~6개의 다른 사람 메시지도 참고해 대화를 이어갑니다.
- 그룹에 늦게 참여했다면 패널의 “그룹” 카드에서 **채팅 가져오기**를 눌러 LINE에서 내보낸 `.txt`를 선택하세요. 그룹 요약과 멤버별 기억 포인트를 만들어 줍니다(로컬에만 저장).
- 자발적 메시지와 DeepSeek 잔액 알림은 여전히 1:1 대상에게만 갑니다.

## 사용자별 기억과 페르소나

- **기억은 공유되지 않습니다**: LINE 사용자마다 자신의 DSH 세션과 전용 Agent 작업 폴더 `<DSH_HOME>/line-bot/users/<LINE userId>/`가 있습니다. Agent가 보는 파일, `AGENTS.md`, 작업 공간 기억은 그 사용자 전용이며 다른 사람의 것은 읽지 않습니다.
  "고급 설정 → 사용자별 폴더"에서 끌 수 있습니다(끄면 모두 `agent.cwd`를 공유해 예전 동작으로 돌아갑니다). `agent.workspaceRoot`로 루트를 지정할 수도 있습니다.
- **사용자가 페르소나를 직접 선택 가능**: "답장 페르소나 → 사용자 직접 전환 허용"이 켜져 있으면 LINE 사용자는 다음을 보낼 수 있습니다.
  - `人設`(또는 `人格`／`persona`) → 사용 가능한 페르소나와 현재 페르소나 목록.
  - `人設 2` → 목록 번호로 전환. `人設 阿茶` → 이름으로 전환. `人設 預設` → 패널 기본값으로 복귀.
  전환은 그 사용자에게만 적용되며 다음 답장부터 반영됩니다. 관리자가 "사용자" 표의 페르소나 드롭다운에서 바꿀 수도 있습니다.
- **기억 지우기**: "사용자" 표에서 "기억 지우기"를 누르면 그 사용자의 세션과 전용 작업 폴더(안의 파일 포함)가 삭제되어 빈 상태에서 다시 시작합니다. "세션 재설정"만 누르면 폴더는 유지됩니다.

## 貼吧(Tieba) 학습 자동 동기화

"刷貼吧" 플러그인은 하루에 최대 한 번 자신의 말투를 진화시킵니다(`<DSH_HOME>/tieba-duty/persona.json`). 이것은 LINE이 쓰는 大肥魚 페르소나(`<DSH_HOME>/storages/dsh-persona-dafeiyu/personas.json`)와 별개 계통이라 원래 서로 연결되지 않습니다. 이 플러그인이 둘을 이어 줍니다.

- 패널의 "답장 페르소나 → 貼吧 학습 동기화"에서 켜기/끄기, 동기화 대상 페르소나(大肥魚 페르소나, 내장 포함, 기본 꺼짐). 내장 페르소나는 본문을 직접 수정할 수 없어 `<DSH_HOME>/line-bot/persona-overlays/<id>.md`에 기록하고 매 턴 주입하며 재로딩이 필요 없습니다. 사용자 정의 페르소나는 본문을 직접 수정합니다., 확인 간격(기본 60분), 성격 수치 동기화 여부, 기록 후 大肥魚 플러그인 리로드 여부를 설정할 수 있습니다. 이 기능에는 大肥魚 플러그인이 필요합니다.
- 확인할 때마다 貼吧 페르소나 버전을 비교해 새 버전일 때만 동작합니다. 기록할 때는 대상 페르소나 본문의 `## 貼吧學來的口氣` 섹션만 바꾸고(없으면 덧붙임) 다른 직접 쓴 내용은 덮어쓰지 않습니다. 성격 수치(温柔／毒舌／抽象／話癆／發図傾向)도 함께 갱신할 수 있습니다.
- 기록 전 `<DSH_HOME>/line-bot/persona-backups/personas-<시간>.json`으로 백업합니다.
- 기록 후 기본적으로 Cordis loader를 통해 `dsh-persona-dafeiyu`를 재시작해 store를 다시 읽게 합니다. 재시작 실패는 경고만 남기고, 본문은 이미 기록되어 다음 플러그인 리로드 때 반영됩니다.
- 貼吧 플러그인이 실행 중이 아니거나 貼吧 페르소나가 없으면 확인을 건너뜁니다(`pending`에 미동기화 이유 표시).

## 말장난(텍스트 밈)

**말장난** 패널에서 페르소나가 자연스럽게 텍스트 밈을 쓸 수 있습니다. 세 가지 출처를 각각 켜고 끌 수 있습니다.

- **내장 시드**: 흔한 인터넷 밈 10개와 사용 시점.
- **貼吧 명언**: 貼吧 스타일 라이브러리의 고득점 짧은 댓글을 가져옵니다.
- **wanjiqi 밈**: 6657 라이브 방송 탄막 밈(선택 사항, 스타일이 강해 기본 꺼짐).

매 턴 몇 개만 프롬프트에 들어가고, 답장에서는 최대 1개만 사용합니다. 밈을 설명하지 말고, 억지로 넣지 말고, 진지하거나 슬플 때는 쓰지 말라는 규칙이 함께 들어갑니다. 카드 아래에서 직접 추가할 수 있으며 파일은 `<DSH_HOME>/line-bot/jokes.json`에 저장됩니다.

**梗類 貼吧 추가**는 弱智吧, 抽象吧, 搞笑吧, 梗吧를 貼吧 플러그인의 bars에 추가합니다(설정은 백업됨). 실제 학습은 貼吧 쪽에서 실행을 시작해야 합니다.

## 貼吧 활동 인지

패널의 "고급 설정 → Agent가 貼吧 활동을 알도록 함"(기본 켜짐)을 켜면, 답장 전마다 "刷貼吧" 플러그인의 기록에서 만든 짧은 배경 정보를 system prompt에 주입합니다:

- 마지막으로 貼吧를 본 시각(예: "어제 22:41, 5시간 전")
- 오늘 이미 돈 회차(점심／저녁)
- 오늘 貼吧 리포트 생성 여부
- 貼吧 페르소나 버전과 마지막 답글 시각

"방금 貼吧 봤어?" "오늘 봤어?"라고 물으면 캐릭터는 실제 시각대로 답하고 지어내지 않습니다. 이 기능은 `<DSH_HOME>/tieba-duty/` 아래 파일만 읽으며, 貼吧 플러그인이 실행 중일 필요도 없고 아무것도 쓰지 않습니다. 기록이 없으면 주입하지 않습니다.

## DeepSeek 잔액

**DeepSeek 잔액** 카드는 DSH에 로그인된 DeepSeek 계정의 지갑 잔액을 읽습니다(읽기 전용, 충전하지 않음):

- 매 답변마다 현재 잔액이 페르소나의 배경 정보에 포함되어 "얼마 남았어?"라고 바로 물을 수 있습니다.
- 기준값(기본 ¥10, 패널에서 조정 가능)보다 낮아지면 페르소나가 **자기 말투로** 충전을 권하는 메시지를 보냅니다. 문구는 고정 템플릿이 아니라 그때 만듭니다.
- 알림에는 쿨다운(기본 12시간)이 있고, "主動傳訊"의 조용한 시간대와 대상 사용자 설정을 따릅니다.
- DSH가 DeepSeek 계정(deepseek-account)에 로그인되어 있어야 합니다. 아니면 카드에 이유가 표시되며 다른 기능은 그대로 동작합니다.
- 기준값은 금액이며 token 수가 아닙니다.

## 개인 기억

캐릭터는 `<DSH_HOME>/line-bot/memories.json`에 자기 기억을 저장하며, 사용자별로 분리됩니다:

- 선호, 근황, 약속, 중요한 사건처럼 나중에 쓸 만한 정보는 `line_memory_add`로 스스로 기록합니다.
- 기한이 있는 일(시험, 여행, 단기 상황)은 만료일을 붙일 수 있고, 기한이 지나면 자동으로 삭제됩니다. "잊어줘"라고 하면 지웁니다.
- 매일(기본 새벽 4시, 패널에서 변경 가능) 한 번 정리하며, 만료된 항목·끝난 일회성 사건·더 이상 맞지 않는 내용을 삭제합니다.
- 매 턴에는 최근 N개(기본 20개·2000자)만 주입하고 나머지는 파일에 남깁니다. 사용자당 상한은 기본 120개이며, 넘으면 오래된 것부터 지웁니다.
- 비밀번호, token, 신분증 번호 같은 민감 정보는 기록하지 않습니다.
- 패널의 "개인 기억" 카드에서 기록 내용 확인, 수동 삭제, 만료 일괄 정리, 지금 정리를 할 수 있습니다.
## 이모티콘(dsh-meme)

캐릭터는 텍스트 답장에 스티커 이미지를 붙이거나 이미지만 보낼 수 있습니다. 이미지는 설치된 dsh-meme 플러그인의 라이브러리(내장 「대비어」 24장)에서 가져옵니다.

- 매 턴 라이브러리 샘플(번호＋설명)을 context에 넣습니다. 이미지를 붙이려면 답장 끝에 `[[meme:#번호]]`(또는 설명)를 붙입니다. 플러그인이 LINE image message로 바꿔 보냅니다.
- 이미지는 현재 Cloudflare 공개 URL(`<URL>/media/<token>`)을 통해 LINE에 전달됩니다. 보낸 이미지는 `<DSH_HOME>/line-bot/media/`에 90일간 보관되므로 나중에 채팅을 열어도 LINE이 가져갈 수 있습니다.
- quick tunnel은 재시작하면 URL이 바뀌므로 이전 메시지의 이미지는 표시되지 않습니다. 영구 URL이 필요하면 API Token named tunnel과 사용자 도메인을 사용하세요.
- 패널의 「이모티콘」 카드에서 켜고 끄기, 답장당 최대 장수(1~3), 라이브러리 샘플 미리보기를 할 수 있습니다. 이미지 추가나 분류 변경은 dsh-meme 설정에서 하세요.
- LINE 스티커를 받으면 스티커 이미지를 가져와 모델에 보여 줍니다(이미지 지원 모델은 바로 읽고, 아니면 LINE 키워드로 대체). 「LINE 자격 증명」 카드에서 「스티커 이해」를 끌 수 있습니다.
- dsh-meme이 설치되어 있지 않으면 이 기능은 꺼지고 텍스트만 답장합니다.
## 진단
- 패널의 "고급 설정 → 진단 실행"에서 서버, Tunnel, 공개 URL, webhook, dsh-meme 라이브러리, 이미지 변환 도구, 모델, 최근 오류를 확인할 수 있습니다. "안전 복구"는 tunnel 재연결과 webhook 재설정만 수행합니다.
- CLI: `npx dsh-line-bot doctor`, `doctor --fix`, `doctor --json`.
- Agent용 절차는 `AGENTS.md`, 증상별 안내는 `TROUBLESHOOTING.md`.

## 문제 해결

- **패널에 "LINE Bot 런타임에 연결할 수 없습니다"**: webServer가 아직 준비되지 않았을 수 있습니다. 새로 고침하세요. 그래도 실패하면 DSH 로그의 `[line-bot]` 메시지를 확인합니다.
- **webhook 테스트 실패**: LINE 콘솔에서 `Use webhook`이 켜져 있는지, 터널 URL이 https인지, 로컬 webhook 서버가 실행 중인지(패널이 초록인지) 확인합니다.
- **`lib/*.mjs` 수정이 반영되지 않음**: "고급 설정 → host 모듈 리로드(개발용)"를 누르세요. 플러그인을 다시 설치할 필요는 없습니다.
- **貼吧 동기화가 동작하지 않음**: 패널 동기화 상태의 `lastError`를 보고, 貼吧 플러그인의 페르소나 파일이 있는지, 대상 페르소나 id가 맞는지 확인합니다. "차이 미리 보기"로 현재 섹션과 기록될 내용을 비교할 수 있습니다.
- **cloudflared를 찾을 수 없음**: "cloudflared 다운로드"를 누르면 공식 릴리스를 `<DSH_HOME>/line-bot/bin/`에 받습니다. 직접 넣고 `tunnel.binaryPath`로 지정해도 됩니다.
- **Agent가 403 반환(모델이 Codex 전용)**: "고급 설정 → Agent 모델"에서 provider／model을 `deepseek-account` / `deepseek-flash`로 바꾸고(로컬 기본값은 이미 이렇게 설정됨) 저장한 뒤 다시 테스트합니다.
- **페르소나가 적용되지 않음**: 大肥魚를 고른 경우 `session` 모드여야 합니다. 패널이 안내하며 "大肥魚를 session 모드로 전환"을 누르면 됩니다(공식 지원 설정이며 "세션별 페르소나 지정 가능 여부"에만 영향을 줍니다). 플러그인 커스텀 페르소나는 이 제한을 받지 않습니다.
- **Cloudflare가 530 / error code 1016 반환**: 이름 있는 터널의 DNS CNAME 대상은 `<tunnel-id>.cfargotunnel.com`이어야 합니다(`.cfd.tunnel` 아님). 또한 그 하위 도메인이 A 레코드와 겹치면 엣지가 그 호스트로 먼저 응답하므로 DNS에 CNAME 하나만 남기세요.

## 개인정보

- 이 플러그인은 사용자가 설정한 Cloudflare API와 LINE API 외에는 어떤 제3자 서버에도 연결하지 않습니다. 텔레메트리도 계정도 없습니다.
- 모든 설정과 자격 증명은 이 컴퓨터의 `<DSH_HOME>/line-bot/config.json`(모드 600)에만 저장되며, 패널에는 마스킹된 값만 표시됩니다.
- LINE 사용자의 세션, 작업 폴더, 페르소나 선택은 로컬에 저장되며 업로드되지 않습니다.
- 저장소와 npm 패키지에는 누구의 자격 증명, LINE userId, Cloudflare 계정, 도메인도 포함되어 있지 않습니다.

## 보안 안내

- 이는 DSH Agent를 공개된 LINE 계정에 연결하는 것과 같습니다. bot을 아는 사람은 당신의 컴퓨터에 있는 도구를 Agent가 사용하게 할 수 있습니다. "허용 목록 사용자 ID"에 자신의 LINE userId를 넣어 자신만 사용하도록 하는 것을 권장합니다.
- 모든 자격 증명은 로컬 `config.json`(600)에 저장되고 패널에는 마스킹된 값만 보입니다. API는 `127.0.0.1`의 DSH webServer에만 열립니다.
- Cloudflare API 토큰은 필요한 권한만 주고, 사용하지 않을 때는 폐기하세요.

## 개발

- host 로직: `lib/*.mjs`(`util`／`config`／`line-api`／`persona`／`agent-runner`／`webhook-server`／`cloudflare`／`tunnel`／`nudge`／`tieba-sync`／`host`).
- 패널: `client.js`(`window.__ModuleLoader__`로 `settings.section` 등록).
- 진입점: `index.js`(`/api/line-bot` 마운트, dev reload, 언로드 정리).
