/**
 * 已忽略清单管理：忽略按「规则 + 命中原文」双字段键控（同规则命中不同文本
 * 仍会提示），跨重启与跨文档不复发。此处可逐条恢复（重新纳入提示）或全部恢复。
 */
import { RotateCcw } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { cn } from "../../lib/utils";
import {
  SettingDescription,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle,
  SettingsContentColumn,
} from "../../components/SettingsPrimitives";
import type { IgnoredEntry } from "../../types/check";

export default function IgnoredSection({
  ignored,
  onRemove,
  onRestoreAll,
}: {
  ignored: IgnoredEntry[];
  onRemove: (ruleId: string, quote: string) => Promise<unknown>;
  onRestoreAll: () => Promise<unknown>;
}) {
  return (
    <SettingsContentColumn>
      <SettingTitle>
        已忽略
        {ignored.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => void onRestoreAll().catch(() => {})}
          >
            <RotateCcw className="size-3.5" />
            全部恢复
          </Button>
        )}
      </SettingTitle>
      <SettingDescription>
        点过「忽略」的检查项在此登记（按规则 + 命中原文记忆，重开不复发）；
        恢复后同样的命中会重新提示。清单有容量上限，最旧的自动淘汰。
      </SettingDescription>

      <SettingGroup>
        {ignored.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground text-sm">没有忽略项。</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {ignored.map((e) => (
              <SettingRow key={`${e.ruleId}\u001f${e.quote}`}>
                <SettingRowTitle className="min-w-0 flex-1 flex-col !items-start gap-0.5">
                  <span className="max-w-full truncate font-mono text-xs text-muted-foreground">
                    {e.ruleId}
                  </span>
                  <span className={cn("max-w-full truncate text-sm", !e.quote && "text-muted-foreground/50")}>
                    {e.quote || "（删除型命中，无原文片段）"}
                  </span>
                </SettingRowTitle>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void onRemove(e.ruleId, e.quote).catch(() => {})}
                >
                  恢复
                </Button>
              </SettingRow>
            ))}
          </div>
        )}
      </SettingGroup>
    </SettingsContentColumn>
  );
}
