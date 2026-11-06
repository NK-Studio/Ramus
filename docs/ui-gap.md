# Unity 패키지(com.nkstudio.gitvcs 1.1.0) 대비 빠진 화면 요소

원본 경로 기준: `Packages/com.nkstudio.gitvcs/Editor/` (UI/ 생략). 중요도: **상** = 화면을 보자마자 다르다고 느낄 것, 중 = 쓰다 보면 찾게 될 것, 하 = 세부.
조사: 2026-11-03, 원본 코드와 `ui/*.js` 를 직접 맞대 봄.

## 1. 창 틀 · 배치

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | 배치 3종(GitKraken · Fork · Unity VCS) 중 GitKraken 만 있음 | GitLayout.cs:8-24, Layouts/ForkChangesView.uxml, PendingChangesView.uxml |
| 상 | 사이드바 위 탭(Graph·Branch Explorer·Workspace·Changesets)과 변경 수 배지 | Layouts/GitWindow.uxml:61, GitWindow.cs:663-694 |
| 상 | 하단 상태 표시줄(PR 수 · UI 배율 % · GitHub 계정 · 버전) | Window/GitFooter.cs |
| 상 | diff·병합 편집기를 열면 사이드바가 아이콘 레일로 접힘(배지 포함) | Elements/SidebarRail.cs, GitWindow.cs:273-298 |
| 상 | UI 배율(Ctrl/⌘+휠, ⌘ = − 0, 60~200%) | Elements/UiScaleController.cs |
| 상 | 처음 읽는 동안 skeleton(회색 물결 막대) | Elements/GitSkeleton.cs |
| 중 | 테마를 따르는 즉시 말풍선 툴팁(HoverCallout) — 지금은 브라우저 기본 title | Elements/HoverCallout.cs |
| 중 | 창 ⋮ 메뉴(언어·배치·탐색기 모양·테마·배율·Finder 열기·터미널·GitHub) | GitWindow.cs:591-640 |
| 중 | 테마 "시스템 따르기" | GitTheme.cs:46 |
| 중 | 레포지토리가 아님 / git 없음 안내 띠와 `git init`(.gitignore 포함) | GitWindow.cs:922-975 |
| 하 | 글꼴: IBM Plex Sans KR(UI) · Jetendard(코드) | Fonts/ |
| 하 | 배치 바꿀 때 "다시 그리는 중" 덮개, 연결 화면 전환 연출 | GitWindow.cs:418-588 |

## 2. 도구 막대

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | 실행 취소 · 다시 실행 버튼("실행 취소: 작업명") | GitToolbar.cs:90-91, Core/GitUndo.cs |
| 상 | 브랜치 이름 ▾ → 브랜치 고르기 팝업(검색 · 현재/로컬/원격 · 키보드) | Window/GitBranchPicker.cs |
| 상 | 레포지토리 이름 ▾ → 레포지토리·서브모듈 고르기 팝업 | Window/GitRepositoryPicker.cs |
| 상 | 아이콘이 원본 벡터 그림(ActionGlyph · Undo/Redo PNG)이 아니라 유니코드 글자 | Elements/ActionGlyph.cs |
| 중 | Pop 버튼 stash 수 배지, 자동 페치 인증 실패 시 Fetch 에 빨간 "!" | GitToolbar.cs:172-189 |
| 중 | 병합·rebase 중 Pull·Push 끄고 까닭 툴팁, detached 일 때 Push 끄기 | GitToolbar.cs:175-184 |
| 중 | 오른쪽 진행 상태 글자(지금은 가운데 알약) | GitToolbar.cs:156-157 |
| 중 | 좁은 창(840 미만)에서 글자 숨기고 아이콘만 | GitToolbar.cs:14-19 |
| 하 | 버튼 순서(레포지토리 · 브랜치 · 실행취소 · Fetch/Pull/Push · 브랜치 · Stash/Pop · 상태 · 터미널/새로고침, 설정·테마는 ⋮ 메뉴) | GitWindow.uxml:13-48 |
| 하 | 배지 99 초과면 "99+" | GitToolbar.cs:340-345 |

## 3. 사이드바

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | 맨 위 Filter 검색칸(걸린 항목과 조상만 남김) | RefSidebar.cs:120-136 |
| 상 | 구역·줄 아이콘(로컬=노트북, 원격=구름/GitHub, 폴더, 태그, stash…) — 지금은 색 점 | RefSidebar.cs:922-972 |
| 상 | `/` 로 묶는 폴더 트리(feature ▸ a) | RefTreeBuilder.cs:101, 356-370 |
| 상 | 워크트리 · 서브모듈 · Pull Requests 구역 | RefSidebar.cs:12, RefTreeBuilder.cs:120-126 |
| 중 | 구역 머리 hover 시 초록 "+"(원격 추가 등 드로어), 구역 머리 우클릭 메뉴 | RefSidebar.cs:678-694, 1093-1131 |
| 중 | 줄 끝 ⋮ 버튼, 전체 이름 말풍선, 키보드 이동(↑↓←→ Enter) | RefSidebar.cs:160-195, 695-715 |
| 중 | 원격 줄 메뉴(Fetch · Prune · 이름/URL 바꾸기 · 지우기) | RefSidebar.cs:1063-1074 |
| 중 | 브랜치 메뉴 항목: Pull · Push · upstream 설정 · fast-forward · 병합 옵션(no-ff/squash) · 비교 · PR 만들기 | Views/BranchMenu.cs:77-203 |
| 중 | 더블클릭 규칙: 태그=전환, stash=변경 보기(지금은 Pop 해 버림) | RefSidebar.cs:1003-1036 |
| 중 | 빈 구역 안내 문구 | RefTreeBuilder.cs:250-251 |
| 하 | 태그 메뉴(병합 · 원격마다 Push/지우기 · SHA 복사), stash 메뉴(변경 보기 · 브랜치 만들기) | RefSidebar.cs PopulateTagMenu |
| 하 | 구역 구분선, 기본 펼침 규칙(로컬·원격만) | RefSidebar.cs:897 |

## 4. 드로어 · 대화상자 · GitHub

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | 사이드바 옆에서 밀려 나오는 드로어 틀 | Elements/SideDrawer.cs |
| 상 | 원격 추가 드로어(URL 탭 · GitHub 탭: 기존/새로 만들기) | Elements/AddRemoteDrawer.cs |
| 상 | 오류 대화상자("설명 / git 원문" 전환 · 원인/해결 · 모두 복사 · 충돌이면 "충돌 보기") — 지금은 토스트뿐 | Window/GitErrorDialog.cs |
| 상 | 확인 카드 모양(아이콘 원 배지 · ✕ · 위험한 확인은 Enter 기본값이 취소 · 막 눌러도 안 닫힘) | Window/GitConfirmDialog.cs:107-196 |
| 상 | 세 갈래 선택 카드(Pull 갈라짐 → 병합 / Rebase 묻기) | GitConfirmDialog.cs:148-150, Views/SyncFlows.cs |
| 상 | Pull Request 전체(사이드바 구역 · 상세 드로어 · 만들기 · 필터) | PullRequest*Drawer.cs |
| 중 | 실패 뒤 다음 할 일 흐름(원격 없음 → 원격 추가, Push 거절 → Pull, 새 브랜치 → PR 만들기, Pop 겹침) | Views/SyncFlows.cs |
| 중 | 여러 원격 중 Push 대상 고르기 카드 | Window/GitPickDialog.cs |
| 중 | 입력 카드의 실시간 검사, 브랜치 만들기 카드 모양(아이콘 · "/ 로 폴더" 안내) | GitPromptDialog.cs, GitBranchDialog.cs |
| 중 | 워크트리 · 서브모듈 추가/편집 드로어, 검색되는 고르기 칸(SearchSelect) | Add*Drawer.cs, SearchSelect.cs |
| 중 | GitHub 계정 고르기 · Device Flow 로그인 화면 | GitAccountDialog.cs, GitHubConnectPanel.cs |
| 중 | 우클릭 메뉴의 하위 메뉴 · 체크 표시 · 키보드 | Elements/GitContextMenu.cs |
| 중 | 설정: 언어 · 배치 | GitSettingsGUI.cs:397 |
| 하 | 설정: 오류 표시 기본값 · 포커스 새로고침/파일 감시 토글 · rebase 충돌 멈춤 · 아바타 토글 | GitSettingsGUI.cs |

## 5. 커밋 그래프

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | 지금 브랜치를 맨 왼쪽 열에, 브랜치 이름 기준으로 열을 나눔 | Core/GitGraph.cs:89-95, 313-316 |
| 상 | 가지 색을 브랜치 이름으로(원격도 같은 색) — 지금은 열 번호로 | Core/GitGraph.cs:198-199 |
| 상 | 선 모양: 가로로 나가 둥근 모서리(r=10)에서 세로로 꺾음 — 지금은 비스듬한 베지어 | CommitGraphList.cs:190, 2177 |
| 상 | 가지 색 띠(원부터 칸 끝까지 10%, 끝 3px 막대, 고른 줄 45%) | CommitGraphList.cs:222-247 |
| 상 | 칸이 좁아질 때 "벽"(원이 밀려 쌓이고 흐려짐) | VerticalGraphLayout.cs:101-129 |
| 상 | 실제 아바타 이미지(GitHub → Gravatar, AI 공동 작성자 로고) | Core/GitAvatarSources.cs |
| 중 | 먼 가지 선 흐리기, 한 줄로 접기, 범위 밖 히스토리는 짧은 회색 선 | CommitGraphList.cs:2137-2198 |
| 중 | 병합 커밋은 속 빈 원, 병합 선은 부모 가지 색 | CommitGraphList.cs:2165, 2582 |
| 중 | 멈춘 병합: WIP 에서 MERGE_HEAD 까지 점선, WIP 줄이 노란 경고 줄 | CommitGraphList.cs:1599-1615, 2424-2468 |
| 하 | 크기 값(줄 34 · 아바타 r12 · 여백 20 · 최대 폭 480 — 지금 32/10/18/420), 아바타 끄기 | VerticalGraphLayout.cs:17-38 |

## 6. 그래프 줄 · 칸 · 이름표

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | 칸 폭 끌어 바꾸기(두 번 누르면 기본, 저장) | ColumnResizer.cs |
| 상 | 칸 순서 끌어 바꾸기(유령 · 세로선, 저장) | ColumnReorderer.cs |
| 상 | WIP 줄 = 커밋 제목 입력란("// 작업 중" 자리표시) + [연필]n [+]n [−]n | CommitGraphList.cs:1686-1794 |
| 상 | 줄 안에서 바로 새 브랜치 이름 입력(쓰는 동안 검사, 가지 색 선) — 지금은 대화상자 | CommitGraphList.cs:1211-1289 |
| 상 | 이름표 모양: [✓][이름][종류 아이콘], 채움 진하기(현재 0.7 · 로컬 0.35 · 원격 0.2), 테두리 없음 | CommitGraphList.cs:181-187, 1831-1898 |
| 상 | 같은 커밋의 로컬+원격을 이름표 하나로 합침(노트북+구름) | CommitRefs.cs:50-53 |
| 상 | 이름표 칸 hover 시 그 줄 참조를 세로로 펼침 | CommitGraphList.cs:1990-2058 |
| 상 | 이름표에서 커밋 원까지 잇는 선 | CommitGraphList.cs:2205-2291 |
| 중 | GitKraken 모양에는 작성자·날짜·SHA 칸이 없음(툴팁·상세에서 봄) — 지금은 늘 보임 | CommitGraphList.cs:216-220 |
| 중 | 고른 줄은 메시지 칸만 칠하고 그래프 띠를 진하게 | CommitGraphList.cs:1519-1545 |
| 중 | 고른 줄 다시 누르면 선택 풀고 오른쪽 패널 접기 | CommitGraphList.cs:359-363 |
| 중 | 원격 이름표에서 "origin/" 빼기, 이름순 정렬, hover 밝기 | CommitRefs.cs:34-43 |
| 중 | 좁아지면 메시지 → 이름표 → 그래프 순으로 줄이기, 머리 글자 → 아이콘 | CommitGraphList.cs:789-855, 1042-1052 |
| 중 | 툴팁 "짧은SHA 제목 / 작성자 · 날짜" | CommitGraphList.cs:1666 |
| 중 | 더 읽기·무한 스크롤(원본 5000개, Changesets 200개씩) — 지금 2000개에서 끝 | GraphWorkspaceView.cs:18-21 |

## 7. 검색 · 커밋 상세 · 커밋 메뉴

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | 커밋 검색(제목·작성자·SHA·참조), Enter/다음, 안 맞는 커밋 흐리기 | CommitHistoryView.cs:226, 869-879; BranchGraphElement.cs:148-159 |
| 상 | 상세: 바뀐 파일 수를 종류별 색으로("✎ n + n − n → n") | GraphCommitDetail.cs:256-279 |
| 상 | 상세: 파일 경로/트리 전환 | GraphCommitDetail.uxml, FileViewModeSwitch.cs |
| 중 | 상세: Co-Authored-By 아바타 칩, 부모 링크(누르면 이동), 해시 눌러 복사, "authored 날짜" 줄 | GraphCommitDetail.cs:83-253 |
| 중 | 상세 파일 우클릭 메뉴(외부 diff · 이 시점으로 되돌리기 · Blame · 히스토리 · 이 버전 저장) | CommitFileMenu.cs |
| 중 | 기간 드롭다운(1주/1달/3달/전체), "모든 브랜치" 토글, "커밋 n개 · 가지 n개" 요약 | BranchExplorerView.cs:84-90, ChangesetsView.cs:58 |
| 중 | 커밋 메뉴: 그 커밋의 브랜치마다 하위 메뉴, Interactive Rebase(Reword·Squash·Fixup·Drop), Reset 하위 메뉴(Soft/Mixed/Hard 바로) | CommitMenu.cs:75-106 |
| 중 | 커밋 메뉴: 비교(작업 폴더 · 부모 · 다른 리비전 · 기준 표시) | CommitMenu.cs:116-173 |
| 하 | 패치 저장 · 정보 복사 · 부모로 이동 · 병합 옵션 · 작업 중이면 메뉴 끄기 | CommitMenu.cs:70-197 |

## 8. 다른 탐색 화면(통째로 없음)

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | Fork 모양 브랜치 탐색기: 위 커밋 목록 + 아래 [Commit · Changes · File Tree] 탭 | Views/CommitHistoryView.cs |
| 상 | Unity VCS 모양 가로 브랜치 탐색기: 가지 관 · 따라오는 가지 이름표 · 초록 병합 곡선 · 태그 고리 · 날짜 띠 · 확대/이동 · hover 툴팁 | Elements/BranchGraph/*.cs |
| 중 | Workspace 탭: 전체 파일 표(상태·크기·날짜), 무시 파일/변경만 토글, 정보·히스토리 | Views/WorkspaceView.cs |
| 중 | Changesets 탭 | Views/ChangesetsView.cs |

## 9. 스테이징 목록 · 커밋 상자

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | 상태 배지가 그림(연필 · + · −, 이름 변경·충돌은 UVCS 오버레이) — 지금은 M/A/D 글자 | StateBadge.cs:17-29, GitStatusIcons.cs |
| 상 | 파일 종류 아이콘 칸 | Layouts/FileRow.uxml:7 |
| 상 | 경로/트리 전환과 폴더 트리(폴더 먼저, 한 줄 합치기, 파일 수, 접힘 기억, 모두 펼치기/접기) | FileTree.cs, FileTreeBuilder.cs |
| 상 | 여러 파일 선택(Shift/⌘) — 머리 버튼이 "파일 n개 Stage" 로 바뀜 | StagingLists.cs:16, 690-720 |
| 상 | 파일 찾기(돋보기 · ⌘F, 두 목록 함께 거름) | StagingLists.cs:395-500 |
| 상 | 충돌 중 목록 모양: "충돌 파일 (n)" [모두 해결됨으로 표시] / "해결한 파일 (n)" | StagingLists.cs:20-22, 83-110 |
| 상 | "커밋 후 푸시"는 체크박스가 아니라 커밋 버튼 옆 보조 버튼(원격 없으면 꺼짐) | CommitBox.uxml:14 |
| 중 | 폴더 우클릭 메뉴, 파일 메뉴 항목(무시 › · LFS › · 이 파일 Stash · 히스토리 · Blame · 외부 편집기 · 패치) | FileActionMenu.cs:52-140 |
| 중 | 충돌 줄 hover = "해결됨으로 표시", 충돌 메뉴(우리 쪽 / 상대 쪽) | FileRowBinder.cs:47-50 |
| 중 | 키보드: Delete=버리기, Enter=Stage/Unstage | StagingLists.cs:313-323 |
| 중 | 누르자마자 목록을 옮겨 보이기(낙관적 갱신), 바쁠 때 "모두 Stage" 대기열 | StagingLists.cs:47-60, 523-550 |
| 중 | Stage 전 확인(충돌 표시 남은 파일 · 안에 git 레포지토리 있는 폴더) | StagingLists.cs:1161-1185 |
| 중 | 커밋 상자 배치: 아래 한 줄 [Amend][중단][건너뛰기] … [커밋 후 푸시][커밋 (n)] | CommitBox.uxml:5-17 |
| 중 | 커밋 템플릿(commit.template) | CommitBox.cs:76-135 |
| 중 | 병합/rebase 중에도 커밋 상자 유지 + MERGE_MSG 채움 + [병합 마치기]·[중단]·[건너뛰기] 링크 | CommitBox.cs:198-265 |
| 하 | 제목 "Unstaged (n) · 충돌 n", 버튼 "커밋 (n)"/"고쳐 쓰기", 작성자 경고 노란 상자, 원래 경로·경고 메모 칸 | GitStrings.cs:265-302 |

## 10. diff 보기

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | GitKraken 식 diff 막대: [이 파일 편집] · [파일 보기 \| Diff 보기] · [Blame \| 히스토리] · [↑\|↓] · [Hunk \| Inline \| Split] · [공백] [줄바꿈] 아이콘 버튼 | GitDiffPanel.cs:737-892 |
| 상 | **Hunk 보기**와 **파일 전체 Inline/Split** 의 구분 — 지금 Inline/Split 은 사실 Hunk(앞뒤 3줄)만 보임 | GitDiffPanel.cs:369, 807, 1434 |
| 상 | 파일 보기(바뀐 뒤 파일 전체, 더한 줄 초록) | GitDiffPanel.cs:785, 1570 |
| 상 | 이전/다음 변경으로 이동(↑↓) | GitDiffPanel.cs:2146-2210 |
| 상 | 줄마다 거터 [+] "이 줄 Stage" 버튼 | GitDiffPanel.cs:1879-1900 |
| 중 | 공백 문자 보이기 · 줄바꿈 · 공백 무시 | GitDiffPanel.cs:14, 815, 3420-3520 |
| 중 | 비교하는 두 판 표시("HEAD ↔ 작업 사본" 등) | GitDiffPanel.cs:2125-2130 |
| 중 | 거터 끌어 줄 고르기, 고른 줄 옆에 뜨는 [Stage \| 되돌리기…], Fork 식 hover 띠 | GitDiffPanel.cs:1789-1870, 2333, 2496 |
| 중 | 버리기 전 확인("Undo 로도 되살릴 수 없음") — Discard Hunk 에는 있으나 문구 다름 | GitDiffPanel.cs:2063-2107 |
| 중 | 글 고르기 규칙(두 번=낱말 · 세 번=줄 · 복사 시 +/− 빼기), 바이너리 카드(크기 · 옛→새), LFS 원본 받기 | GitDiffPanel.cs:541-700, 2739-3110 |
| 중 | 4000줄 상한 없음(가상화), 외부 편집기로 그 줄 열기 | GitDiffPanel.cs:745-1000 |
| 하 | 줄 번호 폭을 자릿수에 맞춤, 늦을 때만 "불러오는 중" 겹침, 좁을 때 막대 줄이기, 복사/모두 선택 메뉴 | GitDiffPanel.cs |

## 11. 코드 편집기 · 이미지 diff · 히스토리 · Blame · 비교(통째로 없음)

| 중요도 | 빠진 것 | 원본 근거 |
|---|---|---|
| 상 | "이 파일 편집": 편집 모드(편집 중·저장 안 됨, 저장/취소), 줄 번호 · 지금 줄 · 들여쓰기 선 · 문법 색칠(C 계열·CSS·JSON·YAML·XML) · 바뀐 줄 초록 띠 · 인코딩/BOM/줄 끝 유지 · 바깥 변경 충돌 묻기 | GitCodeEditor.cs, Core/GitSyntax.cs |
| 상 | 이미지 diff: 나란히 · 스와이프 · 겹쳐 보기 · 차이 강조(바뀐 픽셀 %), 확대/이동, 체커보드, 추가/삭제 테두리, 속성 칸 | GitImageDiffView.cs |
| 상 | 파일 히스토리(가운데 덮는 패널: 왼쪽 커밋 목록 · 오른쪽 diff, 이름 변경 따라감) | FileHistoryPanel.cs |
| 상 | Blame(커밋 묶음별 첫 줄에만 정보, 묶음마다 배경 번갈아) | Window/GitBlameWindow.cs |
| 중 | 비교 창(커밋 · 두 리비전 · From...To · 커밋↔작업 트리) | Window/GitCompareWindow.cs |

## 12. 병합 충돌 편집기(있지만 다름)

| 중요도 | 다른 점 | 원본 근거 |
|---|---|---|
| 상 | 출력이 읽기 전용 줄 목록이고 고르지 않은 자리에 "── 충돌 n: 위에서 A 나 B 를 고르세요 ──". 직접 고치기는 [직접 고치기] ↔ [고르기로 돌아가기] 전환으로만 | GitMergeEditor.cs:178-190, 655 |
| 중 | A/B 머리: 세 상태(일부 = −) 체크 + "A"/"B" 배지 + 브랜치 이름, 머리 눌러 토글 | GitMergeEditor.cs:419-460 |
| 중 | 덩어리 체크박스를 띠 밖 칸, 덩어리 가운데에(일부 상태 포함), 줄 앞 동그라미 | GitMergeEditor.cs:47-49 |
| 중 | 머리 줄: 경고 삼각형 · "(충돌 n개)" · "충돌 i / n" · [처음으로] · 저장 버튼 툴팁 | GitMergeEditor.cs:124-182 |
| 중 | A\|B 경계 끌기(비율 기억, 두 번 누르면 반반), 열 때 사이드바·목록을 접어 넓게 | GitMergeEditor.cs:259-271 |
| 중 | 이미지 충돌: A·B 나란히 · "W × H · 크기" · "이 이미지를 남깁니다" | GitMergeEditor.cs:224-244 |
| 하 | 지운 쪽 자리 표시 문구, 세 판 복구 안내, 바이너리 충돌의 [해결됨으로 표시] | GitStrings.cs:1115-1119 |

## Unity 전용(옮기지 않음)

Project 창 상태 아이콘·우클릭 메뉴, 에셋+.meta 묶기와 빠진 .meta 확인, 메인 툴바 확장, Safe Mode 방지, 씬·프리팹 저장 확인, 에셋 다시 임포트·Ping, PSD/PSB 미리보기, 에디터 스킨 아이콘, Unity 6.0 우회 코드.
