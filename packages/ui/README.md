# @onedict/ui

onedict 自研 UI 原语库（shadcn 风格 + Radix，**源码直引**，无 dist；
vite alias `@onedict/ui → packages/ui/src`）。

## 引用纪律

- 应用侧一律**深路径** import（`@onedict/ui/components/button`）；不建 barrel，
  防止重栈进模块图。
- 新原语先确认根 `package.json` 已声明其 radix 依赖。

## 内容

- `components/`：button / input / textarea / switch / dialog / tooltip / popover /
  dropdown-menu / divider / portal（弹层容器上下文）
- `lib/utils.ts`：`cn`（clsx + tailwind-merge）
- `styles/theme.css`：onedict 语义 token（一层直定义）+ Tailwind v4 `@theme inline`
  映射；亮色单主题；入口由 `src/styles/app.css` `@import`。
