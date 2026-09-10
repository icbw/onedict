<!-- docs-governance: frozen -->
# onedict 本地改造说明（opendict-rs vendor 化）

> 本目录为 vendored 第三方源码（上游文件原样保留不治理，断链属上游打包差异）；

## 来源与许可

- 上游：[opendict-rs](https://github.com/callum-gander/opendict-rs) 0.1.0
  （crates.io 包名 `opendict-rs`，lib 名 `opendict`），作者 Callum Gander，**MIT**
  （原 LICENSE 保留于本目录）。
- 2026-09-01 起以 crates.io 发布包源码拷入本目录（MIT 允许任意复制修改），
  `src-tauri/Cargo.toml` 以 path 依赖引用，不再随上游浮动（上游 0.1.0 单人低活跃，
  原 lock 策略即为锁版）。

## 本地修改清单（相对 0.1.0 上游）

| 文件 | 修改 |
|---|---|
| `src/mdict/idxcache.rs` | **新增**：索引磁盘缓存序列化（自写小端二进制 `ODIDX01`，temp+rename 原子写，结构校验失败回退解析） |
| `src/mdict/file.rs` | `MdictFile::open_with_cache`（缓存命中毫秒级装配 / miss 解析后回写）、`from_cached`、`cached_index`；header 空 Encoding 兜底抽为 `normalized_header` 共用 |
| `src/mdict/mod.rs` | `MdictDictionary::open_with_cache(dir, cache_dir)`（`open` 保持原签名转发）；`load_mdd_files` 透传缓存；`cache_file_for` 指纹文件名（`源文件名.len.mtime_secs.idxcache`） |

## 设计要点

- 缓存覆盖 open 的成本大头：key block 逐块解压 + 逐条解析（数十万词条级）与
  `sorted_indices` 排序。命中路径仅剩 mmap + 文件头解析（XML 头，廉价）+
  缓存装载，数百 ms～秒级冷打开降为毫秒级。
- 失效策略：源文件 len/mtime 指纹嵌缓存文件名，改名/更新即 miss；
  缓存损坏（magic/长度/编码校验）→ 回退正常解析并覆盖重建，无死锁死路。
- 不落盘的状态：`Mmap`（重开）、`decompressed_offsets`（record_blocks O(n) 重算）、
  `MdictDictionary::sorted_keys`（keywords 派生，重建成本低）。
