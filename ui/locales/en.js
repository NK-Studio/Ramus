// 영어 표: 화면 모듈마다 나눈 표(locales/en/<모듈>.js). 기본 내보내기는 모두 합친 표(같은 원문이 여러 표에 있으면 뒤의 것이 이긴다),
// BY_MODULE 은 모듈별 표 — scoped('<모듈>') 의 t 는 자기 표를 먼저 본다(같은 한국어라도 화면마다 영어가 다를 수 있어서).
import m_app from './en/app.js';
import m_refs from './en/refs.js';
import m_github from './en/github.js';
import m_clonepicker from './en/clonepicker.js';
import m_screens from './en/screens.js';
import m_views from './en/views.js';
import m_about from './en/about.js';
import m_newrepo from './en/newrepo.js';
import m_tools from './en/tools.js';
import m_changes from './en/changes.js';
import m_diff from './en/diff.js';
import m_merge from './en/merge.js';
import m_toolbar from './en/toolbar.js';
import m_jobs from './en/jobs.js';
import m_dialogs from './en/dialogs.js';
import m_graph from './en/graph.js';
import m_progress from './en/progress.js';
import m_sidebar from './en/sidebar.js';
import m_files from './en/files.js';
import m_opcard from './en/opcard.js';
import m_util from './en/util.js';
import m_branchgraph from './en/branchgraph.js';
import m_switchhud from './en/switchhud.js';
import m_boot from './en/boot.js';
import m_index from './en/index.js';
import m_syntax from './en/syntax.js';
import m_hidden from './en/hidden.js';
import m_repocache from './en/repocache.js';
import m_tooltip from './en/tooltip.js';
import m_icons from './en/icons.js';
import m_bridge from './en/bridge.js';
import m_sheet from './en/sheet.js';
import m_titlebar from './en/titlebar.js';

export const BY_MODULE = Object.freeze({
  app: m_app,
  refs: m_refs,
  github: m_github,
  clonepicker: m_clonepicker,
  screens: m_screens,
  views: m_views,
  about: m_about,
  newrepo: m_newrepo,
  tools: m_tools,
  changes: m_changes,
  diff: m_diff,
  merge: m_merge,
  toolbar: m_toolbar,
  jobs: m_jobs,
  dialogs: m_dialogs,
  graph: m_graph,
  progress: m_progress,
  sidebar: m_sidebar,
  files: m_files,
  opcard: m_opcard,
  util: m_util,
  branchgraph: m_branchgraph,
  switchhud: m_switchhud,
  boot: m_boot,
  index: m_index,
  syntax: m_syntax,
  hidden: m_hidden,
  repocache: m_repocache,
  tooltip: m_tooltip,
  icons: m_icons,
  bridge: m_bridge,
  sheet: m_sheet,
  titlebar: m_titlebar,
});

export default Object.freeze(Object.assign({}, ...Object.values(BY_MODULE)));
