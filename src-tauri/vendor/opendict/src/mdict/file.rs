use std::fs::File;
use std::sync::{Arc, Mutex};

use memmap2::Mmap;

use super::{header, keys, records, keygen, decompress, idxcache};
use super::header::MdictHeader;

/// Parsed MDict file (either .mdx or .mdd).
#[derive(Debug)]
pub struct MdictFile {
    pub header: MdictHeader,
    pub keywords: Vec<String>,
    sorted_indices: Vec<usize>,
    case_sensitive: bool,
    pub record_offsets: Vec<u64>,
    pub data: Mmap,
    pub record_blocks: Vec<records::RecordBlockInfo>,
    pub record_blocks_start: u64,
    pub global_key: Option<[u8; 16]>,
    /// Cumulative decompressed byte offsets per block (len = record_blocks.len() + 1).
    decompressed_offsets: Vec<u64>,
    /// Single-entry block cache: (block_index, decompressed_data).
    block_cache: Mutex<Option<(usize, Arc<Vec<u8>>)>>,
}

impl MdictFile {
    pub fn open(path: &std::path::Path, case_sensitive_override: Option<bool>) -> crate::Result<Self> {
        let file = File::open(path)?;
        // SAFETY: dictionary files are read-only; we do not modify them.
        let data = unsafe { Mmap::map(&file)? };
        let header = normalized_header(&data, path)?;

        let global_key = keygen::derive_key(header.version, header.uuid.as_deref());

        let (keywords, record_offsets, key_end) =
            keys::parse_keywords(&data, &header, global_key.as_ref())?;

        let (record_blocks, record_blocks_start) =
            records::parse_record_index(&data, key_end, &header)?;

        let case_sensitive = case_sensitive_override.unwrap_or(header.key_case_sensitive);

        let mut sorted_indices: Vec<usize> = (0..keywords.len()).collect();
        if case_sensitive {
            sorted_indices.sort_unstable_by(|&a, &b| keywords[a].cmp(&keywords[b]));
        } else {
            let lowercased: Vec<String> = keywords.iter().map(|k| k.to_lowercase()).collect();
            sorted_indices.sort_unstable_by(|&a, &b| lowercased[a].cmp(&lowercased[b]));
        }

        // Pre-compute cumulative decompressed offsets for binary search
        let mut decompressed_offsets = Vec::with_capacity(record_blocks.len() + 1);
        decompressed_offsets.push(0u64);
        for &(_, _, decomp_size) in &record_blocks {
            decompressed_offsets.push(decompressed_offsets.last().unwrap() + decomp_size);
        }

        Ok(MdictFile {
            header,
            keywords,
            sorted_indices,
            case_sensitive,
            record_offsets,
            data,
            record_blocks,
            record_blocks_start,
            global_key,
            decompressed_offsets,
            block_cache: Mutex::new(None),
        })
    }

    /// onedict 本地改造：带磁盘索引缓存的打开（见 `idxcache` 模块说明）。
    /// 缓存命中 → 跳过 key/record 索引解析与排序（open 的成本大头），毫秒级装配；
    /// 未命中/损坏 → 正常解析并回写缓存（写失败仅影响下次速度，不阻断打开）。
    pub fn open_with_cache(
        path: &std::path::Path,
        case_sensitive_override: Option<bool>,
        cache_path: Option<&std::path::Path>,
    ) -> crate::Result<Self> {
        if let Some(cp) = cache_path {
            match idxcache::read(cp) {
                Ok(cached) => match Self::from_cached(path, case_sensitive_override, &cached) {
                    Ok(f) => return Ok(f),
                    Err(e) => {
                        log::warn!("idx cache {}: assemble failed, falling back: {}", cp.display(), e)
                    }
                },
                Err(_) => {}
            }
        }
        let this = Self::open(path, case_sensitive_override)?;
        if let Some(cp) = cache_path {
            if let Err(e) = idxcache::write(cp, &this.cached_index()) {
                log::warn!("idx cache {}: write failed: {}", cp.display(), e);
            }
        }
        Ok(this)
    }

    fn cached_index(&self) -> idxcache::CachedIndex {
        idxcache::CachedIndex {
            keywords: self.keywords.clone(),
            record_offsets: self.record_offsets.clone(),
            sorted_indices: self.sorted_indices.iter().map(|&i| i as u32).collect(),
            record_blocks: self.record_blocks.clone(),
            record_blocks_start: self.record_blocks_start,
        }
    }

    /// 从缓存快照装配：重新 mmap + 解析文件头（两者都廉价），索引状态直接装载。
    fn from_cached(
        path: &std::path::Path,
        case_sensitive_override: Option<bool>,
        cached: &idxcache::CachedIndex,
    ) -> crate::Result<Self> {
        if cached.record_offsets.len() != cached.keywords.len()
            || cached.sorted_indices.len() != cached.keywords.len()
            || cached.record_blocks.is_empty()
        {
            return Err(crate::error::Error::InvalidFormat(
                "cached index counts mismatch".into(),
            ));
        }
        let file = File::open(path)?;
        // SAFETY: dictionary files are read-only; we do not modify them.
        let data = unsafe { Mmap::map(&file)? };
        let header = normalized_header(&data, path)?;
        let global_key = keygen::derive_key(header.version, header.uuid.as_deref());
        let case_sensitive = case_sensitive_override.unwrap_or(header.key_case_sensitive);

        // Cumulative decompressed offsets 由 record_blocks 重算（O(n) 加法，不值得落盘）
        let mut decompressed_offsets = Vec::with_capacity(cached.record_blocks.len() + 1);
        decompressed_offsets.push(0u64);
        for &(_, _, decomp_size) in &cached.record_blocks {
            let last = decompressed_offsets.last().copied().unwrap_or_default();
            decompressed_offsets.push(last + decomp_size);
        }

        Ok(MdictFile {
            header,
            keywords: cached.keywords.clone(),
            sorted_indices: cached.sorted_indices.iter().map(|&i| i as usize).collect(),
            case_sensitive,
            record_offsets: cached.record_offsets.clone(),
            data,
            record_blocks: cached.record_blocks.clone(),
            record_blocks_start: cached.record_blocks_start,
            global_key,
            decompressed_offsets,
            block_cache: Mutex::new(None),
        })
    }

    /// Decompress a block, returning cached data if available.
    fn get_block(&self, block_idx: usize) -> crate::Result<Arc<Vec<u8>>> {
        let mut cache = self.block_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((idx, data)) = cache.as_ref() {
            if *idx == block_idx {
                return Ok(Arc::clone(data));
            }
        }
        let (comp_offset, comp_size, decomp_size) = self.record_blocks[block_idx];
        let file_offset = self.record_blocks_start + comp_offset;
        let end = (file_offset + comp_size) as usize;
        if end > self.data.len() {
            return Err(crate::error::Error::InvalidFormat(format!(
                "record block {} extends past end of file (offset {}+{}, file size {})",
                block_idx, file_offset, comp_size, self.data.len()
            )));
        }
        let block_data = &self.data[file_offset as usize..end];
        let decompressed = decompress::decompress_block(
            block_data, self.header.version, self.global_key.as_ref(), decomp_size as usize,
        )?;
        let arc = Arc::new(decompressed);
        *cache = Some((block_idx, Arc::clone(&arc)));
        Ok(arc)
    }

    /// Look up a keyword and return the raw record bytes.
    pub fn lookup_raw(&self, key: &str) -> crate::Result<Option<Vec<u8>>> {
        let pos = self.sorted_indices.binary_search_by(|&idx| {
            if self.case_sensitive {
                self.keywords[idx].as_str().cmp(key)
            } else {
                self.keywords[idx].to_lowercase().as_str().cmp(key)
            }
        });
        let i = match pos {
            Ok(p) => self.sorted_indices[p],
            Err(_) => return Ok(None),
        };
        let offset = self.record_offsets[i];
        let record_end = if i + 1 < self.record_offsets.len() {
            self.record_offsets[i + 1]
        } else {
            *self.decompressed_offsets.last().unwrap()
        };
        let record_len = (record_end - offset) as usize;

        // Binary search for the block containing this offset
        let block_idx = self.decompressed_offsets
            .partition_point(|&off| off <= offset)
            .saturating_sub(1);

        let block_start = self.decompressed_offsets[block_idx];
        let block_end = self.decompressed_offsets[block_idx + 1];

        // Fast path: record fits entirely within one block (almost always)
        if offset + record_len as u64 <= block_end {
            let block = self.get_block(block_idx)?;
            let local_start = (offset - block_start) as usize;
            let local_end = local_start + record_len;
            if local_end > block.len() {
                return Err(crate::error::Error::InvalidFormat(format!(
                    "record slice {}..{} exceeds decompressed block size {}",
                    local_start, local_end, block.len()
                )));
            }
            let mut result = block[local_start..local_end].to_vec();
            if result.last() == Some(&0) { result.pop(); }
            return Ok(Some(result));
        }

        // Slow path: record spans multiple blocks
        let mut result = Vec::with_capacity(record_len);
        let mut bi = block_idx;
        while result.len() < record_len && bi < self.record_blocks.len() {
            let bs = self.decompressed_offsets[bi];
            let be = self.decompressed_offsets[bi + 1];
            let block = self.get_block(bi)?;
            let local_start = offset.saturating_sub(bs) as usize;
            let local_end = ((offset + record_len as u64) - bs).min(be - bs) as usize;
            if local_end > block.len() {
                return Err(crate::error::Error::InvalidFormat(format!(
                    "record slice {}..{} exceeds decompressed block {} size {}",
                    local_start, local_end, bi, block.len()
                )));
            }
            result.extend_from_slice(&block[local_start..local_end]);
            bi += 1;
        }
        if result.last() == Some(&0) { result.pop(); }
        Ok(Some(result))
    }
}

/// 解析文件头并应用空 Encoding 兜底（MDD 通常为 UTF-16LE）。
/// open 与 from_cached 共用（onedict 本地改造：从 open 内抽出）。
fn normalized_header(data: &[u8], path: &std::path::Path) -> crate::Result<MdictHeader> {
    let mut header = header::parse_header(data)?;
    if header.encoding.is_empty() {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext.eq_ignore_ascii_case("mdd") {
            header.encoding = "UTF-16LE".to_string();
        } else {
            header.encoding = "UTF-8".to_string();
        }
    }
    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::mdict::header::MdictVersion;

    fn fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("test.mdx")
    }

    // ── Opening and header ──────────────────────────────────────────

    #[test]
    fn opens_successfully() {
        MdictFile::open(&fixture_path(), None).unwrap();
    }

    #[test]
    fn header_version() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.header.version, MdictVersion::V2);
    }

    #[test]
    fn header_encoding() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.header.encoding, "UTF-8");
    }

    #[test]
    fn header_format() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.header.format, "Html");
    }

    #[test]
    fn header_title() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.header.title, "Test Dict");
    }

    #[test]
    fn header_no_encryption() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.header.encrypted, 0);
    }

    // ── Keywords ────────────────────────────────────────────────────

    #[test]
    fn keyword_count() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.keywords.len(), 3);
    }

    #[test]
    fn keywords_in_order() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.keywords, vec!["foo", "hello", "test"]);
    }

    #[test]
    fn keyword_lookup_finds_all() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert!(mdx.lookup_raw("foo").unwrap().is_some());
        assert!(mdx.lookup_raw("hello").unwrap().is_some());
        assert!(mdx.lookup_raw("test").unwrap().is_some());
    }

    // ── Record blocks ───────────────────────────────────────────────

    #[test]
    fn one_record_block() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.record_blocks.len(), 1);
    }

    #[test]
    fn record_offsets_count() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert_eq!(mdx.record_offsets.len(), 3);
    }

    // ── Lookups ─────────────────────────────────────────────────────

    #[test]
    fn lookup_foo() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        let data = mdx.lookup_raw("foo").unwrap().unwrap();
        assert_eq!(String::from_utf8(data).unwrap(), "bar");
    }

    #[test]
    fn lookup_hello() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        let data = mdx.lookup_raw("hello").unwrap().unwrap();
        assert_eq!(String::from_utf8(data).unwrap(), "<b>hello</b> greeting");
    }

    #[test]
    fn lookup_test() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        let data = mdx.lookup_raw("test").unwrap().unwrap();
        assert_eq!(String::from_utf8(data).unwrap(), "test data here");
    }

    #[test]
    fn lookup_miss() {
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        assert!(mdx.lookup_raw("nonexistent").unwrap().is_none());
    }

    #[test]
    fn lookup_case_insensitive() {
        // Default: case insensitive (key_case_sensitive=false)
        let mdx = MdictFile::open(&fixture_path(), None).unwrap();
        // Keywords are lowercased in the map
        assert!(mdx.lookup_raw("FOO").unwrap().is_none()); // map keys are lowercase
        assert!(mdx.lookup_raw("foo").unwrap().is_some());
    }
}
