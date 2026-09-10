/**  划词事件 payload 类型（与 src-tauri serde camelCase 对齐） */

export interface StageTimings {
  /** hook → worker 排队等待 */
  queueWaitMs: number;
  /** 前台进程名 + focused element + text pattern */
  uiaAccessMs: number;
  /** 选区 range + 文本 */
  textMs: number;
  /** 行包围盒 */
  rectsMs: number;
  /** 布局 + 定位 + show（事件入队在打点后） */
  layoutShowMs: number;
  /** t0(钩子鼠标 up) → t5，决策门指标：p95 < 30ms */
  totalMs: number;
}

/** event: selection://text-selected（发往 selection-toolbar 窗口） */
export interface SelectionEvent {
  text: string;
  programName: string | null;
  /** UIA 行包围盒（物理像素）[x, y, w, h] */
  rects: [number, number, number, number][];
  refPoint: [number, number];
  orientation: string;
  timings: StageTimings | null;
}

/** event: selection://panel-text（动作面板取词，广播但仅 action-panel 监听）。
 *  actionId：触发动作（面板泛化多动作；缺省 dict = 查词，其余为 AI 动作 id） */
export interface PanelTextEvent {
  text: string;
  actionId: string;
}

/** event: selection://capture-log（发往 main 调试台） */
export interface CaptureLog {
  ok: boolean;
  reason: string | null;
  /** "uia" | "clipboard" | "clipmon"（剪贴板监听） */
  mode: string;
  programName: string | null;
  textLen: number | null;
  doubleClick: boolean;
  timings: StageTimings | null;
}

/** event: selection://perf / command selection_get_perf */
export interface PerfStats {
  sampleCount: number;
  failureCount: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lastMs: number;
  /** 剪贴板兜底成功样本（不计入 p95 决策门分布） */
  clipboardSampleCount: number;
  clipboardMeanMs: number;
}
