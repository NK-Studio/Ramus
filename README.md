# GitVcs (데스크톱)

Unity 패키지 [com.nkstudio.gitvcs](https://github.com/NK-Studio/com.nkstudio.gitvcs) 를 Unity 밖에서 혼자 도는 앱으로 옮긴 Git 클라이언트입니다.
PC 에 설치된 `git` 을 실행하고, 화면은 웹뷰(wry)로 그립니다. 대상은 macOS(Apple Silicon)·Windows 입니다.

## 내려받기

[Releases](https://github.com/NK-Studio/gitvcs-desktop/releases/latest) 에서 받습니다.

- macOS(Apple Silicon): `GitVcs-<버전>-macos-arm64.zip` — 서명하지 않은 빌드라 처음 한 번 `xattr -dr com.apple.quarantine /Applications/GitVcs.app` 을 실행합니다.
- Windows 10/11(x64): `GitVcs-<버전>-windows-x64.zip` — 압축을 풀고 `GitVcs.exe` 를 실행합니다(WebView2 런타임 사용).

PC 에 `git` 이 설치되어 있어야 합니다.

## 구성

- `crates/gitvcs-core` — git 실행·파싱(status·log·그래프 열 배치), SSL `-c` 설정, 설정·최근 레포지토리. 화면과 상관없어 테스트로 확인합니다.
- `crates/gitvcs-app` — tao 창 + wry 웹뷰, 화면과 JSON 메시지로 주고받기, 폴더 고르기.
- `ui/` — 화면(HTML·CSS·JS, 빌드 도구 없음). 실행 파일 안에 묻어 넣습니다.

## 빌드·실행

```bash
cargo test
node tests/ui/syntax.test.mjs     # 문법 색(원본 GitTextEditorTests 의 Tokenize 시험)
cargo run -p gitvcs-app
scripts/bundle-macos.sh release   # target/release/GitVcs.app
```

개발 중에는 `GITVCS_UI_DIR=$PWD/ui` 를 주면 화면 파일을 디스크에서 바로 읽습니다. `GITVCS_SETTINGS` 로 설정 파일 위치를 바꿀 수 있습니다.

## 주요 기능

- 레포지토리 탭(여러 레포지토리를 열어 두고 전환), 최근 레포지토리, 열기, Clone
- GitKraken 식 커밋 그래프(가지 선·병합·작성자 아바타·브랜치/태그 이름표), 사이드바(로컬·원격·태그·Stash)
- 변경 목록: 파일·hunk·줄 단위 Stage/Unstage/버리기, Inline·Split diff, 커밋(Amend·커밋 후 푸시)
- 페치(자동 페치)·풀(앞으로 감기만·병합·Rebase)·푸시, 바깥 변경 실시간 감지
- 브랜치 만들기·체크아웃·이름 바꾸기·지우기, 병합·Rebase·Cherry-pick·Revert·Reset, 태그, Stash
- 병합 충돌 편집기(A·B·출력, 덩어리·줄 단위 고르기, 출력 직접 고치기), 진행 중인 작업 이어가기·건너뛰기·중단
- 회사망: SSL 인증서 설정(검증 끄기·CA 파일·Windows schannel·해지 확인 끄기)을 git 호출마다 `-c` 로 붙임, 연결 테스트,
  GitHub 가 아닌 서버가 로그인을 요구하면 로그인 창(SSH 는 `SSH_ASKPASS` 도우미에 환경 변수로만, http(s) 는 `git credential approve`)
- GitHub: 연결 화면(Device Flow 로그인, 토큰은 OS 자격 증명 저장소), 레포지토리마다 계정 고르기(gh·자격 증명 도우미·앱 로그인, 인증 실패 뒤 고르면 다시 시도),
  사이드바 풀 리퀘스트 구역(묶음·검색 문법·상세·병합·코멘트·만들기), 원격 추가의 GitHub 탭(기존 레포지토리·새로 만들기)
- 배치 3종(GitKraken · Fork · Unity VCS), 브랜치 탐색기·워크스페이스·체인지 세트, 파일 히스토리·Blame·비교·편집기·이미지 diff
- JetBrains 다크·라이트·시스템 테마, UI 배율

## 단계

1. ✅ 레포지토리 열기·최근 목록, 커밋 그래프, 변경 목록(파일 단위 Stage·Unstage), 커밋(Amend·커밋 후 푸시), 푸시, 다크·라이트 테마
2. ✅ diff 보기, 줄·hunk 단위 Stage, 버리기, 풀·페치·자동 페치, 파일 감시
3. ✅ 브랜치·태그·stash 작업, 커밋 우클릭 메뉴
4. ✅ 병합 충돌 해결
5. ✅ clone·레포지토리 탭 전환, 설정 화면(SSL 인증서·연결 테스트·키체인 내보내기), GitHub 가 아닌 서버 로그인(SSH 비밀번호·http(s) 계정)
6. ✅ 1.0.0 M1~M6: 원본 1.2.0 과 같은 화면(그래프·틀·스테이징/diff·도구·배치, diff·Blame 문법 색, 문맥 줄 −/+·파일 전체 보기)과 GitHub 연동 — [스펙](docs/Spec_1.0.0.md)
7. ✅ 배포: GitHub Actions 가 `v*` 태그마다 macOS(Apple Silicon) .app·Windows .exe 를 빌드해 릴리즈에 올림 — [워크플로](.github/workflows/release.yml)

## 개발 빌드 점검 통로

디버그 빌드를 `GITVCS_DEV_PORT=7777` 으로 띄우면 127.0.0.1:7777 에서 JS(async 함수 본문)를 받아 웹뷰에서 실행하고 결과를 돌려줍니다.

```bash
echo 'return document.title' | nc 127.0.0.1 7777
```
