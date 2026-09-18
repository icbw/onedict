pub(crate) mod header;
pub(crate) mod keys;
pub(crate) mod records;
pub(crate) mod decompress;
pub(crate) mod ripemd128;
pub(crate) mod decrypt;
pub(crate) mod encoding;
pub(crate) mod keygen;
pub(crate) mod file;
pub(crate) mod idxcache;

use std::path;

use crate::error::Error;
use crate::types::{DictEntry, DictInfo};
use crate::Dictionary;

/// MDict 紧凑格式（`Compact="Yes"`）的样式还原项（onedict 本地改造）：
/// 词条文本中的 `` `id` `` 占位符按此表还原——prefix 在标记处展开，
/// suffix 由「下一个标记」或词条结尾收束。上游 README 明确标注
/// "StyleSheet / Compact mode | Not supported"，此处只补齐 header 读取与暴露，
/// 展开策略由调用方决定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleSheetEntry {
    pub id: u32,
    pub prefix: String,
    pub suffix: String,
}

#[derive(Debug)]
pub struct MdictDictionary {
    info_data: DictInfo,
    mdx: file::MdictFile,
    mdd: Vec<file::MdictFile>,
    format_type: char,
    case_sensitive: bool,
    encoding: String,
    // Sorted (lowercased_key, original_index) for prefix search
    sorted_keys: Vec<(String, usize)>,
}

impl MdictDictionary {
    pub fn open(dir: &path::Path) -> crate::Result<Self> {
        Self::open_with_cache(dir, None)
    }

    /// onedict 本地改造：词典（首个 .mdx）当前对应的索引缓存文件路径。
    /// 调用方用于「是否已建缓存」的存在性判断（配合延迟/低优先级后台预热）。
    pub fn cached_index_path(dir: &path::Path, cache_dir: &path::Path) -> crate::Result<path::PathBuf> {
        let mdx_path = find_mdx(dir)?;
        Ok(cache_file_for(cache_dir, &mdx_path))
    }

    /// onedict 本地改造：带磁盘索引缓存的打开（`cache_dir` 提供时启用）。
    /// 缓存文件名内嵌源文件指纹（文件名 + len + mtime），不匹配即视为失效重新解析；
    /// 解析成功后回写缓存（temp+rename 原子替换，坏缓存自动覆盖）。
    pub fn open_with_cache(dir: &path::Path, cache_dir: Option<&path::Path>) -> crate::Result<Self> {
        let mdx_path = find_mdx(dir)?;
        let mdx_cache = cache_dir.map(|cd| cache_file_for(cd, &mdx_path));
        let mdx = file::MdictFile::open_with_cache(&mdx_path, None, mdx_cache.as_deref())?;

        let format_type = if mdx.header.format.eq_ignore_ascii_case("html") {
            'h'
        } else {
            'm'
        };
        let case_sensitive = mdx.header.key_case_sensitive;
        let encoding = mdx.header.encoding.clone();

        let info_data = DictInfo {
            name: mdx.header.title.clone(),
            author: String::new(),
            description: mdx.header.description.clone(),
            word_count: mdx.keywords.len(),
        };

        // Build sorted index for prefix search
        let mut sorted_keys: Vec<(String, usize)> = mdx
            .keywords
            .iter()
            .enumerate()
            .map(|(i, k)| (k.to_lowercase(), i))
            .collect();
        sorted_keys.sort_unstable_by(|a, b| a.0.cmp(&b.0));

        // Load .mdd resource files alongside .mdx
        let mdd = load_mdd_files(&mdx_path, cache_dir);

        Ok(MdictDictionary {
            info_data,
            mdx,
            mdd,
            format_type,
            case_sensitive,
            encoding,
            sorted_keys,
        })
    }

    /// onedict 本地改造：MDict 紧凑格式样式还原表（header StyleSheet 字段解析结果）。
    /// 空表 = 词典未使用 `` `N` `` 占位（表为空或未启用紧凑格式），调用方无需替换。
    pub fn style_sheet(&self) -> &[StyleSheetEntry] {
        &self.mdx.header.style_sheet
    }

    /// Look up a resource (CSS, image, font, etc.) from .mdd files.
    /// Path should match the MDD keyword format, e.g. `\style.css` or `/style.css`.
    pub fn lookup_resource(&self, path: &str) -> Option<Vec<u8>> {
        // Normalise path separators (MDD uses backslash internally)
        let normalised = path.replace('/', "\\");
        let lookup_key = normalised.to_lowercase();
        for mdd in &self.mdd {
            if let Ok(Some(data)) = mdd.lookup_raw(&lookup_key) {
                return Some(data);
            }
        }
        None
    }

    /// Prefix search: find words starting with `prefix`, up to `limit` results.
    pub fn search_prefix(&self, prefix: &str, limit: usize) -> Vec<String> {
        let prefix_lower = prefix.to_lowercase();
        let start = self
            .sorted_keys
            .partition_point(|(k, _)| k.as_str() < prefix_lower.as_str());

        let mut results = Vec::new();
        for (key, idx) in &self.sorted_keys[start..] {
            if key.starts_with(&prefix_lower) {
                results.push(self.mdx.keywords[*idx].clone());
                if results.len() >= limit {
                    break;
                }
            } else {
                break;
            }
        }
        results
    }
}

impl Dictionary for MdictDictionary {
    fn lookup(&self, word: &str) -> crate::Result<Option<Vec<DictEntry>>> {
        let lookup_key = if self.case_sensitive {
            word.to_string()
        } else {
            word.to_lowercase()
        };
        let record_data = match self.mdx.lookup_raw(&lookup_key)? {
            Some(data) => data,
            None => return Ok(None),
        };

        // Decode record bytes from source encoding to UTF-8
        let decoded = encoding::decode_str(&record_data, &self.encoding);

        Ok(Some(vec![DictEntry {
            type_id: self.format_type,
            data: decoded.into_bytes(),
        }]))
    }

    fn lookup_synonym(&self, _word: &str) -> crate::Result<Option<Vec<DictEntry>>> {
        Ok(None)
    }

    fn word_list(&self) -> Vec<&str> {
        self.mdx.keywords.iter().map(String::as_str).collect()
    }

    fn word_count(&self) -> usize {
        self.mdx.keywords.len()
    }

    fn info(&self) -> &DictInfo {
        &self.info_data
    }

    fn search_prefix(&self, prefix: &str, limit: usize) -> Vec<String> {
        self.search_prefix(prefix, limit)
    }
}

fn find_mdx(dir: &path::Path) -> crate::Result<path::PathBuf> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mdx")) {
            return Ok(path);
        }
    }
    Err(Error::InvalidFormat(format!(
        "no .mdx file found in {}", dir.display()
    )))
}

/// Find and load .mdd files alongside the .mdx file.
/// Looks for: same_name.mdd, same_name.1.mdd, same_name.2.mdd, ...
fn load_mdd_files(mdx_path: &std::path::Path, cache_dir: Option<&path::Path>) -> Vec<file::MdictFile> {
    let stem = match mdx_path.file_stem() {
        Some(s) => s.to_string_lossy().to_lowercase(),
        None => return Vec::new(),
    };
    let dir = match mdx_path.parent() {
        Some(d) => d,
        None => return Vec::new(),
    };

    let mut mdds = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    for entry in entries {
        let path = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        let fname = path.file_name().unwrap().to_string_lossy().to_lowercase();
        if fname.ends_with(".mdd") && fname.starts_with(&stem) {
            let cache = cache_dir.map(|cd| cache_file_for(cd, &path));
            match file::MdictFile::open_with_cache(&path, Some(false), cache.as_deref()) {
                Ok(mdd) => mdds.push(mdd),
                Err(e) => log::warn!("failed to load MDD {}: {}", path.display(), e),
            }
        }
    }

    mdds
}

/// 缓存文件名 = 源文件名.len.mtime_secs.idxcache：源文件变化（内容/时间戳）即缓存
/// 失效，读取侧无需 stat 源文件。
fn cache_file_for(cache_dir: &path::Path, src: &path::Path) -> path::PathBuf {
    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (len, mtime) = match std::fs::metadata(src) {
        Ok(m) => (
            m.len(),
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        ),
        Err(_) => (0, 0),
    };
    cache_dir.join(format!("{name}.{len}.{mtime}.idxcache"))
}
