/**
 *  新版本提示位：订阅 `update-available`（Rust 后台启动检查广播，受「启动时检查更新」
 *  偏好控制），并在挂载时读一次 `update_pending`（同一进程内已检出的结果）。
 *  主窗导航与设置页子导航共用；「已查看」的清除时机由各自决定。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let alive = true;
    void invoke<unknown>("update_pending")
      .then((p) => {
        if (alive && p) setAvailable(true);
      })
      .catch(() => {});
    const un = listen("update-available", () => setAvailable(true));
    return () => {
      alive = false;
      void un.then((f) => f(), () => {});
    };
  }, []);

  return available;
}
