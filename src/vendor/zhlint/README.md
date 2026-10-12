# vendor/zhlint — 中文排版检查（来源与许可）

[zhlint](https://github.com/zhlint-project/zhlint) **0.8.2**（MIT，Copyright (c) 2019 Jinjiang），
取 npm 发布包（`registry.npmjs.org/zhlint/-/zhlint-0.8.2.tgz`）的 ESM 构建
`dist/zhlint.es.js`，**未做任何修改**。许可全文见同目录 [LICENSE](./LICENSE)。

- 入口：`zhlint.es.js`（ESM，导出 `run` 等；类型声明 `zhlint.es.d.ts` 为本项目
  维护的最小消费面声明，非上游产物）；
- 消费方：`src/lib/langcheck/zhlintRules.ts`（语言检查规则层 provider）——
  以 `run(text, { hyperParse: [] })` 做**纯文本**排版检查（禁用 markdown /
  hexo / ignore 注释预处理——划词文本不是 Markdown 源文，`#`、`*` 不应被
  当作标记跳过或产生额外规则），`validations` 逐条转统一 Finding
  （category: layout）；上游中文消息直接展示；
- 再构建 / 升级：替换 `zhlint.es.js` 为新版同名文件即可（无修改无补丁）；
  上游 [CHANGELOG](https://github.com/zhlint-project/zhlint/releases) 关注规则
  行为变化对本仓 `test/langcheck.mjs` 基线的影响。
