/**
 * zhlint vendored 构建在模块顶层执行 `document.createElement`（micromark 的
 * HTML entity 解码器探针）。浏览器 / WebView2 天然可用；Node 环境（node
 * test/langcheck.mjs 基线）无 DOM——本 shim 在 document 缺席时垫一个最小
 * element：纯文本检查（hyperParse: []）不触发 entity 解码路径，垫片只需让
 * 模块加载不炸。
 *
 * 必须先于 vendor import 执行（ESM import 按声明序）：zhlintRules.ts 中
 * 本模块的 import 语句排在 vendor import 之前。
 */
if (typeof document === "undefined") {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ innerHTML: "", textContent: "" }),
  };
}
