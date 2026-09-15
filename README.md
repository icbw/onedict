# onedict

划词查词 / 词典 / 生词卡桌面应用。**Tauri 2 + Rust + React 19**，Windows x64。

> 本仓库为公开发布快照：只含应用源码与构建配置（开发记录、测试语料与本地数据不在其中），
> 每次发布以单次提交更新。

## 功能

- **划词查词**：UI Automation 取词 + 剪贴板兜底；浮标与动作面板可配置（Ctrl 触发 / 进程过滤 / 剪贴板监听）
- **词典**：本地 MDX/MDD（opendict 引擎，索引磁盘缓存 + 后台预热）；在线词典（有道 / 剑桥）并列展示；`.spx` 发音解码
- **生词本**：单元制收纳 + SM-2 复习调度（学习卡弹窗：翻牌 / 键盘操作 / 自动发音）+ 学习统计
- **AI**：OpenAI 兼容 / Responses / Anthropic 三协议流式接入；划词动作（词典释义 / 翻译 / 解释 / 总结 / 搜索）、独立翻译页、截图 OCR 翻译（系统 OCR 与 AI 视觉双通道）
- **数据**：偏好与生词数据备份 / 恢复 / Anki CSV 导出；便携模式（exe 同目录放置 `onedict.portable`）
- **系统集成**：系统托盘常驻、全局快捷键、开机启动（登录后静默驻留托盘）
- **更新**：应用内检查更新（设置 → 关于）——下载进度、安装前二次确认、更新包签名校验；可开启启动时自动检查

## 下载安装

见本仓库 Releases（Windows x64，NSIS 安装包）。安装包未做代码签名，SmartScreen 可能提示，
选择「仍要运行」即可。

## 从源码构建

环境要求（Windows）：

- Node.js ≥ 20.19 与 pnpm ≥ 11
- Rust stable-msvc 与 Visual Studio C++ 生成工具（MSVC）
- WebView2 运行时（Windows 10/11 通常已内置）

```bash
pnpm install
pnpm dev            # 开发模式（热重载）
pnpm typecheck      # 类型检查
pnpm tauri build    # 构建 Windows NSIS 安装包
```

本地词典语料（MDX/MDD）属版权内容，不随仓库分发；将词典放入应用数据目录下的 `dicts/` 即可使用。

## 更新日志

见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## 第三方组件

- [opendict-rs](https://crates.io/crates/opendict-rs)（MIT）—— MDX/MDD 解析引擎（本地改造版，见 `src-tauri/vendor/opendict/`）
- libspeex 1.2.1（Xiph.Org BSD + emscripten MIT）—— `.spx` 发音解码，来源与再构建见 `src/vendor/speex/README.md`
- [circle-flags](https://github.com/Hatscripts/circle-flags)（MIT）—— 语言国旗
- [@lobehub/icons](https://github.com/lobehub/lobe-icons)（MIT）—— AI 服务商徽标
- [DOMPurify](https://github.com/cure53/DOMPurify)（MPL-2.0 / Apache-2.0）—— 在线词典内容消毒

## 许可

[MIT](LICENSE)。
