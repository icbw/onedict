/**
 * 术语表管理：禁用词 → 首选词的替换规则（Vale substitution 四元组：匹配词 /
 * 首选词 / 说明 / 级别 + 软停用开关）。整表保存（check_terms_save）——服务端
 * 校验、去重、分配 id 后返回规范化载荷；外壳收到即重查（术语表即改即生效）。
 * 删除/停用是软操作（停用保留条目，删了重建 id 会变、忽略键随之失效）。
 */
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onedict/ui/components/dialog";
import { Button } from "@onedict/ui/components/button";
import { Input } from "@onedict/ui/components/input";
import { Switch } from "@onedict/ui/components/switch";
import { cn } from "../../lib/utils";
import {
  SettingDescription,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle,
  SettingsContentColumn,
} from "../../components/SettingsPrimitives";
import type { TermEntry, TermLevel } from "../../types/check";

const LEVEL_OPTIONS: Array<{ value: TermLevel; label: string }> = [
  { value: "info", label: "提示" },
  { value: "warning", label: "建议" },
  { value: "error", label: "错误" },
];

const LEVEL_BADGE: Record<TermLevel, string> = {
  info: "bg-slate-500/10 text-slate-600",
  warning: "bg-amber-500/10 text-amber-700",
  error: "bg-red-500/10 text-red-700",
};

interface FormState {
  wrong: string;
  right: string;
  note: string;
  level: TermLevel;
}

const EMPTY_FORM: FormState = { wrong: "", right: "", note: "", level: "warning" };

export default function TermsSection({
  terms,
  onSave,
}: {
  terms: TermEntry[];
  onSave: (list: TermEntry[]) => Promise<unknown>;
}) {
  /** null = 关闭；editing null = 新建 */
  const [dialog, setDialog] = useState<{ editing: TermEntry | null; form: FormState } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const openAdd = () => {
    setError("");
    setDialog({ editing: null, form: { ...EMPTY_FORM } });
  };

  const openEdit = (entry: TermEntry) => {
    setError("");
    setDialog({
      editing: entry,
      form: {
        wrong: entry.wrong,
        right: entry.right,
        note: entry.note ?? "",
        level: entry.level,
      },
    });
  };

  const submit = async () => {
    if (!dialog) return;
    const editing = dialog.editing;
    const wrong = dialog.form.wrong.trim();
    const right = dialog.form.right.trim();
    if (!wrong || !right) {
      setError("禁用词与首选词都不能为空");
      return;
    }
    if (wrong === right) {
      setError("禁用词与首选词相同，无需替换");
      return;
    }
    const note = dialog.form.note.trim();
    const patch = { wrong, right, note: note || null, level: dialog.form.level };
    setBusy(true);
    try {
      await onSave(
        editing
          ? terms.map((t) => (t.id === editing.id ? { ...t, ...patch } : t))
          : [...terms, { id: 0, enabled: true, ...patch }],
      );
      setDialog(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: number) => {
    void onSave(terms.filter((t) => t.id !== id)).catch(() => {});
  };

  const toggle = (entry: TermEntry) => {
    void onSave(terms.map((t) => (t.id === entry.id ? { ...t, enabled: !t.enabled } : t))).catch(
      () => {},
    );
  };

  return (
    <SettingsContentColumn>
      <SettingTitle>
        术语表
        <Button type="button" size="sm" className="h-7 gap-1 text-xs" onClick={openAdd}>
          <Plus className="size-3.5" />
          新建术语
        </Button>
      </SettingTitle>
      <SettingDescription>
        匹配是大小写不敏感的；纯英文术语要求词边界（「nodejs」不会命中「nodejsbook」）。
        保存后立即对当前文本生效。
      </SettingDescription>

      <SettingGroup>
        {terms.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground text-sm">
            还没有术语条目——例如「nodejs → Node.js」「登陆 → 登录」。
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {terms.map((t) => (
              <SettingRow key={t.id} className="items-start">
                <SettingRowTitle className="min-w-0 flex-1 flex-col !items-start gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className={cn("rounded px-1.5 py-0.5 font-medium text-[10px] leading-4", LEVEL_BADGE[t.level])}>
                      {LEVEL_OPTIONS.find((o) => o.value === t.level)?.label ?? t.level}
                    </span>
                    <span className="truncate text-sm">
                      <span className="text-muted-foreground line-through decoration-red-400/70">{t.wrong}</span>
                      <span className="mx-1.5 text-muted-foreground/60">→</span>
                      <span className="font-medium">{t.right}</span>
                    </span>
                  </div>
                  {t.note && <p className="text-muted-foreground text-xs">{t.note}</p>}
                </SettingRowTitle>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch checked={t.enabled} onCheckedChange={() => toggle(t)} />
                  <button
                    type="button"
                    aria-label="编辑"
                    onClick={() => openEdit(t)}
                    className="cursor-pointer rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="删除"
                    onClick={() => remove(t.id)}
                    className="cursor-pointer rounded p-1 text-muted-foreground/70 transition-colors hover:bg-red-500/10 hover:text-red-600"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </SettingRow>
            ))}
          </div>
        )}
      </SettingGroup>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog?.editing ? "编辑术语" : "新建术语"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">禁用词（要被替换的写法）</span>
              <Input
                autoFocus
                value={dialog?.form.wrong ?? ""}
                onChange={(e) =>
                  dialog && setDialog({ ...dialog, form: { ...dialog.form, wrong: e.target.value } })
                }
                placeholder="如：nodejs / 登陆"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">首选词（统一到的写法）</span>
              <Input
                value={dialog?.form.right ?? ""}
                onChange={(e) =>
                  dialog && setDialog({ ...dialog, form: { ...dialog.form, right: e.target.value } })
                }
                placeholder="如：Node.js / 登录"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">说明（可选，展示在提示里）</span>
              <Input
                value={dialog?.form.note ?? ""}
                onChange={(e) =>
                  dialog && setDialog({ ...dialog, form: { ...dialog.form, note: e.target.value } })
                }
                placeholder="如：品牌统一写法"
              />
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-xs">级别</span>
              {LEVEL_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => dialog && setDialog({ ...dialog, form: { ...dialog.form, level: o.value } })}
                  className={cn(
                    "cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors",
                    dialog?.form.level === o.value
                      ? "border-primary bg-primary/10 font-medium text-primary"
                      : "border-border text-muted-foreground hover:bg-accent/60",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {error && <p className="text-red-600 text-xs">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsContentColumn>
  );
}
