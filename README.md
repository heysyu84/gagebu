# 편의점 가게부 (Store Ledger)

본 저장소는 사용자가 운영하는 편의점의 장부용이며 **WIND MOON / 풍월관 관리프로그램과 무관**합니다.

공개 사이트: https://heysyu84.github.io/store-ledger/

## 시트형 입력

- **시트형 일괄 입력**: 20행부터 시작하여 10행씩 추가, 같은 날짜 여러 건, 열에 상관없이 순서대로 또는 원하는 순서대로 입력, 전체 일괄 저장
- 키보드 `Enter`(같은 열 아래), `Shift+Enter`(위), `Tab`(옆), 방향키 이동, 복수 셀 TSV 붙여넣기
- **토토 매출상세**: 월 선택 시 28~31개 날짜 자동 준비, 일별 수수료와 판매액을 원하는 순서로 입력, 한 번에 저장. 동일 날짜는 갱신, 미입력 날짜는 보존
- **월말 가게 매출**: 해당 월 마지막 날 날짜 자동 지정, 한 달 한 건 저장, 중복 등록 대신 기존 기록 수정 확인
- 기존 단건 입력과 소분류 자동 후보, 장부 분석, JSON 내보내기·가져오기 계속 지원

## 서버 구조

GitHub Pages에는 **화면 코드만** 보관합니다. 서버는 별도 Cloudflare Worker + D1이 저장을 담당하며 관리자 인증과 버전 충돌 방지 기능을 제공합니다.

**현재 공개 사이트는 Cloudflare 서버 배포 전에도 브라우저 localStorage 모드로 동작합니다.** 서버 미배포 상태에서는 여러 기기가 자동으로 동기화되지 않습니다.

### Cloudflare 최초 설정 (계정 소유자의 1회 설정 필요)

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

최초 데이터를 파일 업로드 없이 서버에 이관하려면, 별도로 전달받은 **비공개 초기 적재 SQL**을 `db/schema.sql` 적용 뒤 한 번만 실행할 수도 있습니다. 비공개 SQL은 **GitHub에 올리지 마세요**.\n\n```bash\nnpx wrangler d1 execute store-ledger-private --remote --file=store-ledger-private-initial-seed.sql\n```\n\nWorker가 게시되면 가게부의 `데이터 관리 → 서버 저장`에 `https://....workers.dev` 주소와 관리자 비밀번호를 입력해 로그인합니다. 처음에는 **JSON 백업을 먼저 보관한 후** 기존 장부를 한 번만 서버에 올립니다. 다른 기기에서도 같은 Worker 주소로 로그인하면 서버 기록을 불러옵니다.

### 데이터 보존 안전장치

- Workers API 사용자는 관리자 비밀번호와 12시간 세션 토큰으로 인증합니다. 세션 토큰은 데이터베이스에 해시로 저장되고 브라우저 탭 `sessionStorage`에만 보관됩니다.
- 서버는 저장 시 버전 번호(CAS)를 검사하고, 다른 기기에서 먼저 변경한 경우 409로 거부하여 **덮어쓰기 충돌을 방지**합니다.
- 이전 내용은 최신 30회까지 `ledger_history` 테이블에 보관합니다.
- 서버 연결이 실패하면 브라우저에 장부 사본을 남기고 경고합니다. 복구/차이 비교 전에 자동으로 원격 장부를 덮어쓰지 않습니다.
- `Google Sheets → D1` 자동 동기화는 아직 구현하지 않았습니다. 구글 시트는 연결된 ChatGPT에서 읽어 이관 JSON으로 생성할 수 있지만, 서버에 넣으려면 본인 인증된 사이트 세션이 필요합니다.
- 데이터 백업 및 비공개 서버 데이터는 공개 저장소에 올리지 않습니다.

## 공개 저장소에 업로드 금지

2026년 실제 개인 수입·지출·카드 사용 내역, 이관 데이터 JSON/HTML, D1 백업, Worker 관리자 비밀번호, Cloudflare API 토큰, `wrangler.toml`, `.dev.vars` / `.env` / 기타 비밀 값.