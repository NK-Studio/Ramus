# GitVcs (데스크톱)

Unity 패키지 [com.nkstudio.gitvcs](https://github.com/NK-Studio/com.nkstudio.gitvcs) 를 Unity 밖에서 혼자 도는 앱으로 옮긴 Git 클라이언트입니다.
PC 에 설치된 `git` 을 실행하고, 화면은 웹뷰(wry)로 그립니다. 대상은 macOS(Apple Silicon)·Windows 입니다.

## 구성

- `crates/gitvcs-core` — git 실행·파싱(status·log·그래프 열 배치), SSL `-c` 설정, 설정·최근 저장소. 화면과 상관없어 테스트로 확인합니다.
- `crates/gitvcs-app` — tao 창 + wry 웹뷰, 화면과 JSON 메시지로 주고받기, 폴더 고르기.
- `ui/` — 화면(HTML·CSS·JS, 빌드 도구 없음). 실행 파일 안에 묻어 넣습니다.

## 빌드·실행

```bash
cargo test
cargo run -p gitvcs-app
scripts/bundle-macos.sh release   # target/release/GitVcs.app
```

개발 중에는 `GITVCS_UI_DIR=$PWD/ui` 를 주면 화면 파일을 디스크에서 바로 읽습니다. `GITVCS_SETTINGS` 로 설정 파일 위치를 바꿀 수 있습니다.

## 주요 기능

- 저장소 탭(여러 저장소를 열어 두고 전환), 최근 저장소, 열기, Clone
- GitKraken 식 커밋 그래프(가지 선·병합·작성자 아바타·브랜치/태그 이름표), 사이드바(로컬·원격·태그·Stash)
- 변경 목록: 파일·hunk·줄 단위 Stage/Unstage/버리기, Inline·Split diff, 커밋(Amend·커밋 후 푸시)
- 페치(자동 페치)·풀(앞으로 감기만·병합·Rebase)·푸시, 바깥 변경 실시간 감지
- 브랜치 만들기·체크아웃·이름 바꾸기·지우기, 병합·Rebase·Cherry-pick·Revert·Reset, 태그, Stash
- 병합 충돌 편집기(A·B·출력, 덩어리·줄 단위 고르기, 출력 직접 고치기), 진행 중인 작업 이어가기·건너뛰기·중단
- 회사망: SSL 인증서 설정(검증 끄기·CA 파일·Windows schannel·해지 확인 끄기)을 git 호출마다 `-c` 로 붙임, 연결 테스트,
  GitHub 가 아닌 서버가 로그인을 요구하면 로그인 창(SSH 는 `SSH_ASKPASS` 도우미에 환경 변수로만, http(s) 는 `git credential approve`)
- JetBrains 다크·라이트 테마

## 단계

1. ✅ 저장소 열기·최근 목록, 커밋 그래프, 변경 목록(파일 단위 Stage·Unstage), 커밋(Amend·커밋 후 푸시), 푸시, 다크·라이트 테마
2. ✅ diff 보기, 줄·hunk 단위 Stage, 버리기, 풀·페치·자동 페치, 파일 감시
3. ✅ 브랜치·태그·stash 작업, 커밋 우클릭 메뉴
4. ✅ 병합 충돌 해결
5. ✅ clone·저장소 탭 전환, 설정 화면(SSL 인증서·연결 테스트·키체인 내보내기), GitHub 가 아닌 서버 로그인(SSH 비밀번호·http(s) 계정)
6. 배포(macOS .app, Windows .exe)

## 개발 빌드 점검 통로

디버그 빌드를 `GITVCS_DEV_PORT=7777` 으로 띄우면 127.0.0.1:7777 에서 JS(async 함수 본문)를 받아 웹뷰에서 실행하고 결과를 돌려줍니다.

```bash
echo 'return document.title' | nc 127.0.0.1 7777
```
