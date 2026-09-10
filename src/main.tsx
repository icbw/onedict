import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import "./styles/app.css";

// 屏蔽 WebView2 默认右键菜单（网页感交互，桌面应用形态）：捕获阶段全局拦截，
// 组件级 stopPropagation 无法绕过。例外：文本编辑位（input/textarea/contenteditable）
// 保留系统编辑菜单（右键粘贴）；OCR 截图窗豁免——其右键是定制语义（右键退出
// 会话 / 原文块右键复制菜单）。开发期 devtools 走 F12 / Ctrl+Shift+I（debug 构建内置）。
if (getCurrentWebviewWindow().label !== "ocr-capture") {
  window.addEventListener(
    "contextmenu",
    (e) => {
      const t = e.target;
      const editable =
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (!editable) e.preventDefault();
    },
    true,
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
