/**
 * 拼写白名单管理：词典拼写检查的误报出口——专有名词、品牌、行业用语加入后
 * 不再提示。整词小写匹配（拼写取词本身就是小写化后判定），加入时归一。
 */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Input } from "@onedict/ui/components/input";
import {
  SettingDescription,
  SettingGroup,
  SettingTitle,
  SettingsContentColumn,
} from "../../components/SettingsPrimitives";

export default function WhitelistSection({
  whitelist,
  onAdd,
  onRemove,
}: {
  whitelist: string[];
  onAdd: (word: string) => Promise<unknown>;
  onRemove: (word: string) => Promise<unknown>;
}) {
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = async () => {
    const w = word.trim().toLowerCase();
    if (!w) return;
    setBusy(true);
    setError("");
    try {
      await onAdd(w);
      setWord("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsContentColumn>
      <SettingTitle>拼写白名单</SettingTitle>
      <SettingDescription>
        英文拼写检查以词典收录为准，专有名词与品牌常被误报——加入白名单后整词放行
        （大小写不敏感）。结果条目上的「白名单」按钮也会写入这里。
      </SettingDescription>

      <SettingGroup>
        <div className="flex items-center gap-2">
          <Input
            value={word}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            placeholder="输入英文词后回车，如：onedict"
            className="flex-1"
          />
          <Button type="button" size="sm" className="h-8 gap-1 text-xs" disabled={busy || !word.trim()} onClick={() => void add()}>
            <Plus className="size-3.5" />
            添加
          </Button>
        </div>
        {error && <p className="mt-2 text-red-600 text-xs">{error}</p>}
        {whitelist.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground text-sm">白名单为空。</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {whitelist.map((w) => (
              <span
                key={w}
                className="flex items-center gap-1 rounded-full border border-border-subtle py-1 pr-1.5 pl-2.5 text-sm"
              >
                {w}
                <button
                  type="button"
                  aria-label={`移除 ${w}`}
                  onClick={() => void onRemove(w).catch(() => {})}
                  className="cursor-pointer rounded-full p-0.5 text-muted-foreground/70 transition-colors hover:bg-red-500/10 hover:text-red-600"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </SettingGroup>
    </SettingsContentColumn>
  );
}
