# 편의점 가게부 (Store Ledger)

본 저장소는 사용자가 운영하는 편의점의 장부용이며 **WIND MOON / 풍월관 관리프로그램과 무관**합니다.

공개 사이트: https://heysyu84.github.io/gagebu/

## 시트형 입력

- **시트형 일괄 입력**: 20행부터 시작하여 10행씩 추가, 같은 날짜 여러 건, 열에 상관없이 순서대로 또는 원하는 순서대로 입력, 전체 일괄 저장
- 키보드 `Enter`(같은 열 아래), `Shift+Enter`(위), `Tab`(옆), 방향키 이동, 복수 셀 TSV 붙여넣기
- **토토 매출상세**: 월 선택 시 28~31개 날짜 자동 준비, 일별 수수료와 판매액을 원하는 순서로 입력, 한 번에 저장. 동일 날짜는 갱신, 미입력 날짜는 보존
- **월말 가게 매출**: 해당 월 마지막 날 날짜 자동 지정, 한 달 한 건 저장, 중복 등록 대신 기존 기록 수정 확인
- 기존 단건 입력과 소분류 자동 후보, 장부 분석, JSON 내보내기·가져오기 계속 지원

## 서버 구조

GitHub Pages에는 **화면 코드만** 보관합니다. 서버는 별도 Cloudflare Worker + D1이 저장을 담당하며 관리자 인증과 버전 충돌 방지 기능을 제공합니다.

**현재 공개 사이트는 Cloudflare 서버 배포 전에도 브라우저 localStorage 모드로 동작합니다.** 서버 미배포 상태에서는 여러 기기가 자동으로 동기화되지 않습니다.

## Work 없이 서버 설치: GitHub Actions (권장)

PC에 Node.js 설치나 PowerShell 명령 입력 없이 진행하는 방법입니다. **아직 서버가 배포된 상태는 아닙니다.**
이 저장소의 `.github/workflows/deploy-cloudflare.yml`은 소유자가 직접 실행할 때만 Cloudflare D1/Worker를 만들거나 갱신합니다.

1. [Cloudflare 대시보드](https://dash.cloudflare.com/)에서 편의점 가게부를 배포할 계정을 선택하여 **Account ID**를 확인합니다.
2. Cloudflare의 **API Tokens → Create Token**에서 이 계정만 대상으로 한 토큰을 생성합니다. D1 데이터베이스 생성·SQL 실행 권한(계정 D1 Edit)과 새 Worker 생성·배포 권한(Workers Admin/필요한 Workers Scripts 권한)이 필요합니다. 권한을 다른 계정까지 확대하지 마세요.
3. [gagebu GitHub Actions secrets](https://github.com/heysyu84/gagebu/settings/secrets/actions)에 아래 네 가지를 추가합니다.
   - `CLOUDFLARE_ACCOUNT_ID`: 1번 계정 ID
   - `CLOUDFLARE_API_TOKEN`: 2번에서 만든 토큰
   - `STORE_LEDGER_ADMIN_PASSWORD`: 본인만 아는 16자 이상 새 관리자 비밀번호
   - `STORE_LEDGER_SESSION_PEPPER`: 관리자 비밀번호와 **다른** 32자 이상의 무작위 비밀 문자열
4. [Deploy private ledger API](https://github.com/heysyu84/gagebu/actions/workflows/deploy-cloudflare.yml) → **Run workflow** → `main` → Run workflow를 누릅니다.
5. 작업이 **초록색 Success**로 끝나면 실행 로그의 `https://...workers.dev` 주소를 복사합니다. [가게부 사이트](https://heysyu84.github.io/gagebu/) → 데이터 관리 → 서버 저장에 이 주소와 관리자 비밀번호를 넣고 로그인합니다.
6. 기존 브라우저의 장부를 **JSON으로 먼저 백업**하고, 서버가 비어 있는 것을 확인한 후 처음 한 번만 서버로 올립니다. 실제 금융 데이터를 GitHub 저장소나 GitHub Secrets에 붙여넣지 마세요.

**보안:** API 토큰, 관리자 비밀번호, SESSION_PEPPER는 이 채팅·공개 저장소·스크린샷에 노출하지 마세요.
배포 워크플로는 민감한 값을 GitHub Actions Secrets에서 읽고 임시 파일로 Worker에 전달하며, 장부 내용을 GitHub에 넣지 않습니다.
D1 초기화 SQL은 테이블이 없을 때만 생성하며 기존 데이터를 삭제하지 않습니다.
실행 실패 시 Secrets 권한 및 Actions 오류를 확인합니다. 워크플로 등록만으로 서버가 생기지는 않습니다.

### 수동 배포: 명령줄 방식 (대안)

Cloudflare 계정이 로그인된 명령줄에서 저장소를 복제한 뒤 다음 명령을 실행합니다.

```bash
npx wrangler login
npx wrangler d1 create store-ledger-private --location apac
```

반환되는 데이터베이스 ID를 `wrangler.toml.example`의 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 자리에 기입하고 해당 파일을 `wrangler.toml`로 복사합니다.

```bash
npx wrangler d1 execute store-ledger-private --remote --file=db/schema.sql
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_PEPPER
npx wrangler deploy
```

`ADMIN_PASSWORD`는 **길고 고유한 관리자 비밀번호**, `SESSION_PEPPER`는 **별도의 랜덤 문자열**을 입력합니다. 둘 다 GitHub, 브라우저 코드, JSON 파일에 적지 마세요. `wrangler.toml`의 `ALLOWED_ORIGINS`는 접속 사이트가 바뀌는 경우에만 수정하세요.

최초 데이터를 파일 업로드 없이 서버에 이관하려면, 별도로 전달받은 **비공개 초기 적재 SQL**을 `db/schema.sql` 적용 뒤 한 번만 실행할 수도 있습니다. 비공개 SQL은 **GitHub에 올리지 마세요**. 

```bash
npx wrangler d1 execute store-ledger-private --remote --file=store-ledger-private-initial-seed.sql 
```

Worker가 게시되면 가게부의 `데이터 관리 → 서버 저장`에 `https://....workers.dev` 주소와 관리자 비밀번호를 입력해 로그인합니다. 처음에는 **JSON 백업을 먼저 보관한 후** 기존 장부를 한 번만 서버에 올립니다. 다른 기기에서도 같은 Worker 주소로 로그인하면 서버 기록을 불러옵니다.

### 데이터 보존 안전장치

- Workers API 사용자는 관리자 비밀번호와 12시간 세션 토큰으로 인증합니다. 세션 토큰은 데이터베이스에 해시로 저장되고 브라우저 탭 `sessionStorage`에만 보관됩니다.
- 서버는 저장 시 버전 번호(CAS)를 검사하고, 다른 기기에서 먼저 변경한 경우 409로 거부하여 **덮어쓰기 충돌을 방지**합니다.
- 이전 내용은 최신 30회까지 `ledger_history` 테이블에 보관합니다.
- 서버 연결이 실패하면 브라우저에 장부 사본을 남기고 경고합니다. 복구/차이 비교 전에 자동으로 원격 장부를 덮어쓰지 않습니다.
- `Google Sheets → D1` 자동 동기화는 아직 구현하지 않았습니다. 구글 시트는 연결된 ChatGPT에서 읽어 이관 JSON으로 생성할 수 있지만, 서버에 넣으려면 본인 인증된 사이트 세션이 필요합니다.
- 데이터 백업 및 비공개 서버 데이터는 공개 저장소에 올리지 않습니다.

## 공개 저장소에 업로드 금지

2026년 실제 개인 수입·지출·카드 사용 내역, 이관 데이터 JSON/HTML, D1 백업, Worker 관리자 비밀번호, Cloudflare API 토큰, `wrangler.toml`, `.dev.vars` / `.env` / 기타 비밀 값.