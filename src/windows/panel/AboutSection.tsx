/**
 *  关于子页：版本 / 检查更新 / 下载 / 更新说明 / 安装二次确认 / 启动时检查开关。
 *
 * 环境守卫来自 Rust `update_env`：便携模式不提供在线更新（安装器固定装到系统
 * 目录，会把便携副本换成安装版）；开发版允许检查与下载用于联调，安装由前后端
 * 双重拦截。下载进度经 Channel 回传（Started 给总长、Progress 累加），下载完成
 * 即验签——失败不落盘，前端据此只开放「安装」入口。
 */
import { useEffect, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onedict/ui/components/dialog";
import { Switch } from "@onedict/ui/components/switch";
import { Tooltip } from "@onedict/ui/components/tooltip";
import {
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle,
  SettingsContentColumn,
} from "../../components/SettingsPrimitives";
import { Minimark } from "../../services/minimark";
import { cn } from "../../lib/utils";
import type { PrefsPayload } from "../../types/prefs";

/** 公开仓与更新说明入口（与 Rust 侧 endpoint 同源） */
const REPO_URL = "https://github.com/icbw/onedict";
const RELEASE_URL = `${REPO_URL}/releases/latest`;

/** 更新信息（对应 Rust `update::UpdateInfo`） */
interface UpdateInfo {
  version: string;
  current: string;
  notes: string | null;
  date: string | null;
}

/** 运行环境（对应 Rust `update::UpdateEnv`） */
interface UpdateEnv {
  portable: boolean;
  dev: boolean;
}

/** 下载进度事件（对应 Rust `update::UpdateEvent`） */
type UpdateEvent =
  | { event: "Started"; data: { contentLength: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

type Phase = "idle" | "checking" | "latest" | "available" | "downloading" | "downloaded" | "error";

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

export default function AboutSection() {
  const [version, setVersion] = useState("");
  const [env, setEnv] = useState<UpdateEnv | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  /** 已检出的新版本（下载与安装的入参） */
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [err, setErr] = useState("");
  const [recv, setRecv] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [startupCheck, setStartupCheck] = useState(false);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
    void invoke<UpdateEnv>("update_env").then(setEnv).catch(() => {});
    // 启动检查或上次手动检查的结果：进页面即有内容，不必再联网
    void invoke<UpdateInfo | null>("update_pending")
      .then((p) => {
        if (!p) return;
        setInfo(p);
        setPhase("available");
      })
      .catch(() => {});
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => setStartupCheck(p.checkUpdateOnStartup))
      .catch(() => {});
    // 启动检查（延迟后台）命中：页面已挂载时同步展示
    const un = listen<UpdateInfo>("update-available", (e) => {
      setInfo(e.payload);
      setPhase((p) => (p === "idle" || p === "latest" ? "available" : p));
    });
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, []);

  const portable = env?.portable ?? false;
  const dev = env?.dev ?? false;
  const busy = phase === "checking" || phase === "downloading";
  const canCheck = !portable && !busy;
  const canDownload = !portable && phase === "available";
  const pct = total && total > 0 ? Math.min(100, Math.round((recv / total) * 100)) : null;

  const check = () => {
    setPhase("checking");
    setErr("");
    invoke<UpdateInfo | null>("update_check")
      .then((r) => {
        if (r) {
          setInfo(r);
          setPhase("available");
        } else {
          setInfo(null);
          setPhase("latest");
        }
      })
      .catch((e) => {
        setErr(String(e));
        setPhase("error");
      });
  };

  const download = () => {
    setPhase("downloading");
    setErr("");
    setRecv(0);
    setTotal(null);
    const on = new Channel<UpdateEvent>((e) => {
      if (e.event === "Started") setTotal(e.data.contentLength ?? null);
      else if (e.event === "Progress") setRecv((n) => n + e.data.chunkLength);
    });
    // 命令落定 = 字节已缓存且签名校验通过，此时才开放安装
    invoke("update_download", { on })
      .then(() => {
        setPhase("downloaded");
        setConfirmOpen(true);
      })
      .catch((e) => {
        setErr(String(e));
        setPhase("available");
      });
  };

  const install = () => {
    setErr("");
    // 成功路径不返回：安装程序启动后进程即退出，界面无需复位
    void invoke("update_install").catch((e) => {
      setErr(String(e));
      setConfirmOpen(false);
    });
  };

  const toggleStartup = (next: boolean) => {
    setStartupCheck(next);
    void invoke("prefs_set_check_update_on_startup", { enabled: next }).catch(() =>
      setStartupCheck(!next),
    );
  };

  return (
    <SettingsContentColumn>
      <SettingGroup>
        <SettingTitle>版本</SettingTitle>
        <SettingRow className="mt-3">
          <SettingRowTitle>
            <Tooltip content="在浏览器中打开项目主页" placement="top">
              <button
                type="button"
                onClick={() => void invoke("open_external", { url: REPO_URL }).catch(() => {})}
                className="cursor-pointer bg-transparent p-0 text-foreground hover:text-primary hover:underline"
              >
                onedict{version ? ` v${version}` : ""}
              </button>
            </Tooltip>
          </SettingRowTitle>
          <div className="flex items-center gap-2">
            <Tooltip
              content={portable ? "便携模式不支持在线更新" : "联网检查是否有新版本"}
              placement="top"
            >
              <Button
                type="button"
                variant="outline"
                disabled={!canCheck}
                loading={phase === "checking"}
                onClick={check}
              >
                检查更新
              </Button>
            </Tooltip>
            <Tooltip
              content={portable ? "便携模式不支持在线更新" : "下载新版本安装包"}
              placement="top"
            >
              <Button type="button" variant="outline" disabled={!canDownload} onClick={download}>
                下载
              </Button>
            </Tooltip>
          </div>
        </SettingRow>

        {phase === "latest" && (
          <p className="mt-3 text-muted-foreground text-xs">已是最新版本</p>
        )}

        {phase === "available" && info && (
          <p className="mt-3 text-sm">发现新版本 v{info.version}</p>
        )}

        {(phase === "available" || phase === "downloaded") && info?.notes && (
          <div className="mt-3 rounded-md border border-border bg-muted/30">
            <button
              type="button"
              onClick={() => setNotesOpen((v) => !v)}
              className="flex w-full cursor-pointer items-center gap-1 bg-transparent px-3 py-2 text-left text-muted-foreground text-xs hover:text-foreground"
            >
              <ChevronRight
                className={cn("size-3.5 transition-transform", notesOpen && "rotate-90")}
              />
              更新说明
            </button>
            {notesOpen && (
              <div className="px-3 pb-3">
                <div className="max-h-56 overflow-y-auto text-xs">
                  <Minimark text={info.notes} className="flex flex-col gap-1.5" />
                </div>
                <button
                  type="button"
                  onClick={() => void invoke("open_external", { url: RELEASE_URL }).catch(() => {})}
                  className="mt-2 cursor-pointer bg-transparent p-0 text-primary text-xs hover:underline"
                >
                  查看完整说明
                </button>
              </div>
            )}
          </div>
        )}

        {(phase === "downloading" || phase === "downloaded") && (
          <div className="mt-3 flex flex-col gap-1.5">
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${phase === "downloaded" ? 100 : (pct ?? 0)}%` }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <span>
                {phase === "downloaded"
                  ? `安装包已就绪 ${mb(recv)} MB`
                  : total
                    ? `正在下载 ${pct}% · ${mb(recv)} / ${mb(total)} MB`
                    : `正在下载 ${mb(recv)} MB`}
              </span>
              {phase === "downloaded" && (
                <button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  className="cursor-pointer bg-transparent p-0 text-primary hover:underline"
                >
                  立即安装
                </button>
              )}
            </div>
          </div>
        )}

        {err && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-destructive">{err}</span>
            <button
              type="button"
              onClick={() => void invoke("open_external", { url: RELEASE_URL }).catch(() => {})}
              className="cursor-pointer bg-transparent p-0 text-primary hover:underline"
            >
              前往发布页
            </button>
          </div>
        )}
      </SettingGroup>

      <SettingGroup>
        <SettingTitle>更新</SettingTitle>
        <SettingRow className="mt-3">
          <SettingRowTitle>启动时检查更新</SettingRowTitle>
          <Tooltip content="启动后自动检查是否有新版本" placement="top">
            <Switch checked={startupCheck} disabled={portable} onCheckedChange={toggleStartup} />
          </Tooltip>
        </SettingRow>
      </SettingGroup>

      {/* 安装二次确认：下载完成即弹出，确认后才启动安装程序 */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>安装 v{info?.version}</DialogTitle>
          </DialogHeader>
          <div className="text-muted-foreground text-sm">
            <p>安装程序会覆盖当前版本，装完自动重启 onedict。</p>
            {dev && <p className="mt-2 text-destructive">开发版不执行安装</p>}
            {err && <p className="mt-2 text-destructive">{err}</p>}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={dev} onClick={install}>
              立即安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsContentColumn>
  );
}
