# 개인 사이트 관리

서버 주소: `https://store-ledger-private-api.heysyu84.workers.dev/mcp`

OAuth로 연결합니다. 로그인 창에서 **기존 가계부 관리자 비밀번호**를 입력합니다. 비밀번호나 Cloudflare API 토큰을 대화에 붙여 넣지 않습니다.

ChatGPT에서 지원되는 경우 **Plugins → ＋ → Add custom MCP server**에 위 주소를 등록하고 OAuth를 선택합니다. 연결 권한을 확인한 뒤 **Create as a plugin**으로 개인 연결을 만듭니다. 메뉴 이름과 제공 여부는 사용하는 환경에 따라 다릅니다. 데스크톱·CLI 등에서는 이 폴더의 `mcp.json`을 지원하는 방식으로 등록할 수도 있습니다.

조회 권한 `gagebu:read`와 수정 권한 `gagebu:write`를 구분합니다. 가계부의 **저장 · 백업 → AI 관리 연결 → 연결한 앱 확인**에서 연결 권한을 종료할 수 있습니다.

## 제공 기능

- `sites_status`: 사이트 연결 상태·장부 버전
- `ledger_find`: 필요한 거래·환불만 최대 20건 조회
- `ledger_update_transaction`: 정확한 거래 식별값과 장부 버전으로 최대 20건을 한 번에 수정
- `ledger_manage_refund`: 환불 연결·해제·집계 제외·복원
- `ledger_changes`: 변경 전후 내역과 되돌리기 가능 여부
- `ledger_undo`: 선택한 변경의 필드만 복구

수정할 거래가 여러 개면 사용자에게 대상을 확인합니다. 가장 최근 거래를 실수한 거래라고 가정하지 않습니다. 수정 후 `verified: true`인 저장 결과를 확인합니다. 충돌 시 다시 조회하며 강제로 덮어쓰지 않습니다.

일상 데이터 갱신은 GitHub 작업이나 재배포를 거치지 않습니다. UI와 일반 서버 저장 기능은 이 MCP 연결과 독립적으로 사용할 수 있습니다. **풍월관·클전은 아직 미연결**이며, 같은 서버에 도구와 별도 권한을 추가할 수 있습니다.

서버와 데이터는 Cloudflare에 있고, 이 연결을 사용하려면 해당 AI 환경에서 MCP가 지원되어야 합니다. 무료 ChatGPT에서 같은 기능이 유지된다는 보장은 하지 않습니다.
