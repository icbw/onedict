/**
 * 窗口级 ErrorBoundary（安全收口-5）：任一渲染错误此前会导致
 * 整窗白屏（划词浮标窗口更致命——只剩空白浮标，失焦才隐藏）。三个窗口分支各自
 * 包一层，落区 = 错误摘要 + 「重载窗口」（location.reload 对预建复用窗口安全：
 * main 常挂载、浮标重挂后量尺逻辑自恢复、面板重挂后监听 selection://panel-text）。
 */
import React from "react";

interface Props {
  /** 落区标题提示（可选，如「浮标」「查词面板」） */
  label?: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `window render error${this.props.label ? ` (${this.props.label})` : ""}:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          <div className="text-muted-foreground text-sm">
            {this.props.label ? `${this.props.label}渲染出错` : "窗口渲染出错"}
          </div>
          {/* select-text：全局 user-select:none 下错误摘要可复制（反馈诊断） */}
          <div className="max-w-md break-all rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs select-text">
            {this.state.error.message || String(this.state.error)}
          </div>
          <button
            type="button"
            onClick={() => location.reload()}
            className="cursor-pointer rounded-md border border-border bg-muted px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            重载窗口
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
