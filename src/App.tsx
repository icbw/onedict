import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ErrorBoundary from "./components/ErrorBoundary";
import MainApp from "./windows/MainApp";
import ToolbarApp from "./windows/ToolbarApp";
import PanelApp from "./windows/PanelApp";
import OcrCaptureApp from "./windows/OcrCaptureApp";

/** 按窗口 label 分支（多入口拆分留）。每分支独立 ErrorBoundary：
 * 单窗渲染错误落「重载窗口」落区，不再整页白屏 */
export default function App() {
  const label = getCurrentWebviewWindow().label;
  if (label === "selection-toolbar") {
    return (
      <ErrorBoundary label="划词浮标">
        <ToolbarApp />
      </ErrorBoundary>
    );
  }
  if (label === "action-panel") {
    return (
      <ErrorBoundary label="查词面板">
        <PanelApp />
      </ErrorBoundary>
    );
  }
  if (label === "ocr-capture") {
    return (
      <ErrorBoundary label="OCR 取词">
        <OcrCaptureApp />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary label="主窗口">
      <MainApp />
    </ErrorBoundary>
  );
}
