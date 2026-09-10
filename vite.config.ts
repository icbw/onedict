import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri 前端：固定端口（tauri.conf.json devUrl 对应），避免清屏干扰 Rust 日志。
// @onedict/ui → packages/ui/src（自研原语，源码直引子包）。
// 应用侧一律深路径按需引入组件：barrel 不进模块图，重栈不会被带出。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@onedict/ui": fileURLToPath(
        new URL("./packages/ui/src", import.meta.url),
      ),
    },
  },
  server: {
    // 端口与 tauri.conf.json 的 devUrl / devCsp 三处同步；strictPort 保持
    port: 1427,
    strictPort: true,
  },
  build: {
    target: "esnext",
  },
});
