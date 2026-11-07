// 레포지토리 탭을 오갈 때 쓰는 두 가지. 화면 요소를 건드리지 않아 node 로 시험한다(tests/ui/repocache.test.mjs).
//
// 1. 레포지토리별 마지막 snapshot·화면 상태 보관(LRU). 전에 본 탭으로 돌아가면 백엔드를 기다리지 않고 이것으로 먼저 그리고,
//    뒤에서 다시 읽어 바뀐 것만 고친다.
// 2. 전환 문(gate). 백엔드는 열린 레포지토리 슬롯이 하나라, openRepo 응답이 오기 전에 보낸 요청(diff·stage…)은 이전 레포지토리에
//    실행된다. 레포지토리에 묶인 요청은 응답 뒤로 미루고, 보낼 때 보던 레포지토리 경로(__repo)를 붙여 백엔드가 어긋남을 거르게 한다.

/**
 * 레포지토리 경로 → 보관한 상태. 가장 오래 안 쓴 것부터 버린다(get 도 "썼다" 로 친다).
 * entry 는 app.js 가 정한다: { repo, snap, fingerprint, maxCount, draft, selected, scrollTop }.
 */
export function createRepoCache({ limit = 6 } = {}) {
  const map = new Map();
  return {
    /** 보관한 것을 꺼내고 가장 최근 것으로 올린다. 없으면 null. */
    get(path) {
      const entry = map.get(path);
      if (!entry) return null;
      map.delete(path);
      map.set(path, entry);
      return entry;
    },
    has(path) {
      return map.has(path);
    },
    set(path, entry) {
      map.delete(path);
      map.set(path, entry);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    /** 이미 보관 중인 것만 일부 고친다(늦게 온 snapshot 으로 더 새것으로). 없으면 false. */
    update(path, patch) {
      const entry = map.get(path);
      if (!entry) return false;
      Object.assign(entry, patch);
      return true;
    },
    delete(path) {
      map.delete(path);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
    get paths() {
      return [...map.keys()];
    },
  };
}

/** 열린 레포지토리와 상관없는 요청. 레포지토리를 여닫는 것, 설정, 로그인, Clone·만들기 창, 창 조작. */
const GLOBAL_COMMANDS = new Set([
  'app', 'init', 'openRepo', 'closeRepo', 'closeTab', 'getSettings', 'setSettings', 'setUi', 'removeRecent',
  'newRepoTemplates', 'newRepoPath', 'createLocalRepo', 'githubCreateInfo', 'githubCreateRepo', 'githubCloneNew',
  'clone', 'cancelJob', 'quit', 'cloneName', 'githubCloneList', 'githubCloneAccounts', 'githubCloneCache', 'githubCloneCacheSave',
  'avatar', 'exportKeychain', 'remoteLogin', 'forgetSshLogin', 'gitVersion', 'gitInfo', 'checkGit',
  'githubDeviceStart', 'githubDevicePoll', 'githubStatus', 'githubLogout', 'githubAccounts', 'sshKeys', 'sshKeyRead', 'sshKeyGenerate', 'sshKeyUpload', 'openUrl', 'openDefault', 'openFolder', 'trashRepo',
  'pick', 'pickRepo', 'setZoom', 'menuState', 'toggleFullscreen', 'windowDrag', 'windowZoom', '__devResult',
]);

/** 열린 레포지토리에서 실행되는 요청인가(전환 중에는 미루고, 보낼 때 __repo 를 붙인다). */
export function isRepoBound(cmd) {
  return !GLOBAL_COMMANDS.has(cmd);
}

/**
 * 전환 문. begin(path, request) 로 "path 로 바꾸는 요청을 보냈다" 고 알리면, 그 요청이 끝날 때까지 run() 에 들어온 보내기를 미룬다.
 * 요청이 실패하면 백엔드는 이전 레포지토리 그대로이므로 경로도 되돌린다. 응답에 path 가 있으면(레포지토리 루트) 그것으로 맞춘다.
 */
export function createSwitchGate() {
  let path = null;
  let waiting = null;
  return {
    /** 화면이 보고 있는(요청에 붙일) 레포지토리 경로. 열린 것이 없으면 null. */
    get path() {
      return path;
    },
    /** 백엔드가 이미 그 레포지토리를 열어 두었을 때(앱 시작·Clone 뒤) 경로만 맞춘다. */
    set(nextPath) {
      path = nextPath;
    },
    begin(nextPath, request) {
      const previous = path;
      path = nextPath;
      const settled = Promise.resolve(request).then(
        (info) => {
          if (path === nextPath && typeof info?.path === 'string') path = info.path;
          return true;
        },
        () => {
          if (path === nextPath) path = previous;
          return false;
        },
      );
      waiting = settled;
      settled.then(() => {
        if (waiting === settled) waiting = null;
      });
      return settled;
    },
    /** 보낼 수 있을 때 send(path) 를 부른다. 전환 중이면 끝난 뒤에(연달아 바꾸면 마지막 전환까지 기다린다). */
    run(send) {
      const attempt = () => {
        if (waiting) waiting.then(attempt);
        else send(path);
      };
      attempt();
    },
    get switching() {
      return waiting !== null;
    },
  };
}
