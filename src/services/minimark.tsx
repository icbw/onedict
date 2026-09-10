/**
 * 极简 Markdown 渲染（AI 输出用：AI 词典释义 + 划词 AI 动作流式正文）。
 * cherry Markdown 组件属禁带出的重栈（按需引入约定），AI 输出实际只覆盖
 * 轻量子集，自写 ~120 行足够且零依赖：标题 / 有序无序列表 / 引用 / 围栏代码块 /
 * 分隔线 / 粗体 / 斜体 / 行内代码 / 链接（文本+href）。全部 React 转义输出，无
 * HTML 注入面。
 */
import type { ReactNode } from "react";
import { memo } from "react";

/** 行内语法：**粗体**、*斜体*、`行内码`、[文本](url)。链接可点（外链新开）。 */
const INLINE_RE =
  /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(`([^`\n]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const k = `${keyPrefix}-${i}`;
    if (m[1]) {
      nodes.push(<strong key={k}>{m[2]}</strong>);
    } else if (m[3]) {
      nodes.push(<em key={k}>{m[4]}</em>);
    } else if (m[5]) {
      nodes.push(
        <code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {m[6]}
        </code>,
      );
    } else if (m[7]) {
      nodes.push(
        <a
          key={k}
          href={m[9]}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {m[8]}
        </a>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING_SIZES = ["text-lg", "text-base", "text-sm", "text-sm", "text-sm", "text-sm"];

/** 块级解析：按行扫描，聚合同类连续行为块 */
function renderBlocks(src: string): ReactNode[] {
  const lines = src.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const push = (node: ReactNode) => {
    out.push(node);
    key++;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾 ```
      push(
        <pre
          key={key}
          className="my-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed"
        >
          {lang && <div className="mb-1 text-muted-foreground text-[10px]">{lang}</div>}
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      push(<hr key={key} className="my-3 border-border" />);
      i++;
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = (`h${Math.min(level, 6)}`) as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      push(
        <Tag
          key={key}
          className={`${HEADING_SIZES[level - 1]} mt-3 mb-1.5 font-medium first:mt-0`}
        >
          {renderInline(heading[2], `h${key}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    // 引用（连续 > 行聚合）
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      push(
        <blockquote
          key={key}
          className="my-2 border-muted-foreground/40 border-l-2 pl-3 text-muted-foreground"
        >
          {buf.map((t, j) => (
            <p key={j}>{renderInline(t, `q${key}-${j}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    // 无序 / 有序列表（连续行聚合；支持嵌套一级缩进平铺处理）
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    const olMatch = line.match(/^\s*(\d+)[.、)]\s+(.*)$/);
    if (ulMatch || olMatch) {
      const ordered = !ulMatch;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const u = l.match(/^\s*[-*+]\s+(.*)$/);
        const o = l.match(/^\s*(\d+)[.、)]\s+(.*)$/);
        if (ordered && o) items.push(o[2]);
        else if (!ordered && u) items.push(u[1]);
        else if (l.trim() === "" && items.length && lines[i + 1]?.match(/^\s*(?:[-*+]|\d+[.、)])\s/)) {
          i++; // 列表中间空行继续
          continue;
        } else break;
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      push(
        <ListTag
          key={key}
          className={`my-1.5 space-y-0.5 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}
        >
          {items.map((t, j) => (
            <li key={j}>{renderInline(t, `l${key}-${j}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // 空行
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 段落（连续普通行聚合，行内换行 <br/>）
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].startsWith(">") &&
      !lines[i].match(/^\s*(?:[-*+]|\d+[.、)])\s/) &&
      !lines[i].match(/^#{1,6}\s/) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    push(
      <p key={key} className="my-1.5 leading-relaxed whitespace-pre-wrap first:mt-0">
        {buf.map((t, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {renderInline(t, `p${key}-${j}`)}
          </span>
        ))}
      </p>,
    );
  }
  return out;
}

/** 流式安全的极简 Markdown 渲染组件（解析纯函数式，无副作用） */
export const Minimark = memo(function Minimark({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return <div className={className}>{renderBlocks(text)}</div>;
});
