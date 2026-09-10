use std::{path, str};

use crate::error::Error;

use super::strcmp::stardict_strcmp;

/// A single index entry (constructed on demand, not stored).
#[derive(Debug, Clone)]
pub struct IdxEntry {
    #[cfg_attr(not(test), allow(dead_code))]
    pub word: String,
    pub offset: u64,
    pub size: u32,
}

/// Compact index: raw file bytes + entry offset table.
#[derive(Debug)]
pub struct Idx {
    data: Vec<u8>,
    offsets: Vec<u32>,
    offset_bits: u32,
}

impl Idx {
    pub fn open(file: &path::Path, offset_bits: u32) -> crate::Result<Idx> {
        let data = super::io::read_file(file)?;
        let ref_size: usize = if offset_bits == 64 { 12 } else { 8 };

        let mut offsets = Vec::new();
        let mut pos = 0;
        while pos < data.len() {
            offsets.push(pos as u32);
            let null_pos = data[pos..]
                .iter()
                .position(|&b| b == 0)
                .ok_or_else(|| Error::InvalidFormat(format!(
                    "idx: missing null terminator at offset {}", pos
                )))?;
            str::from_utf8(&data[pos..pos + null_pos]).map_err(|e| {
                Error::InvalidFormat(format!("idx: invalid UTF-8 at offset {}: {}", pos, e))
            })?;
            let ref_start = pos + null_pos + 1;
            if ref_start + ref_size > data.len() {
                return Err(Error::InvalidFormat(format!(
                    "idx: unexpected EOF at offset {}", ref_start
                )));
            }
            pos = ref_start + ref_size;
        }

        Ok(Idx { data, offsets, offset_bits })
    }

    pub fn entry_count(&self) -> usize {
        self.offsets.len()
    }

    /// Word for entry i -- zero-copy from raw buffer.
    pub(crate) fn word_at(&self, i: usize) -> &str {
        super::index_util::word_at(&self.data, &self.offsets, i)
    }

    /// Construct a full IdxEntry for entry i (allocates a String).
    pub(crate) fn entry(&self, i: usize) -> IdxEntry {
        let start = self.offsets[i] as usize;
        let null_pos = self.data[start..]
            .iter()
            .position(|&b| b == 0)
            .unwrap();
        let word = str::from_utf8(&self.data[start..start + null_pos])
            .unwrap()
            .to_string();
        let ref_start = start + null_pos + 1;

        let (offset, size) = if self.offset_bits == 64 {
            let offset = u64::from_be_bytes([
                self.data[ref_start],     self.data[ref_start + 1],
                self.data[ref_start + 2], self.data[ref_start + 3],
                self.data[ref_start + 4], self.data[ref_start + 5],
                self.data[ref_start + 6], self.data[ref_start + 7],
            ]);
            let size = u32::from_be_bytes([
                self.data[ref_start + 8],  self.data[ref_start + 9],
                self.data[ref_start + 10], self.data[ref_start + 11],
            ]);
            (offset, size)
        } else {
            let offset = u32::from_be_bytes([
                self.data[ref_start],     self.data[ref_start + 1],
                self.data[ref_start + 2], self.data[ref_start + 3],
            ]) as u64;
            let size = u32::from_be_bytes([
                self.data[ref_start + 4], self.data[ref_start + 5],
                self.data[ref_start + 6], self.data[ref_start + 7],
            ]);
            (offset, size)
        };

        IdxEntry { word, offset, size }
    }

    pub fn search(&self, word: &str) -> Option<IdxEntry> {
        self.binary_search(word, stardict_strcmp)
            .or_else(|| {
                self.binary_search(word, |w, target| w.as_bytes().cmp(target.as_bytes()))
            })
    }

    fn binary_search<F>(&self, word: &str, cmp: F) -> Option<IdxEntry>
    where
        F: Fn(&str, &str) -> std::cmp::Ordering,
    {
        super::index_util::find_match(&self.data, &self.offsets, word, cmp)
            .map(|i| self.entry(i))
    }

    /// Prefix search: find words starting with `prefix` (case-insensitive), up to `limit`.
    pub fn search_prefix(&self, prefix: &str, limit: usize) -> Vec<String> {
        let prefix_lower = prefix.to_lowercase();
        let count = self.offsets.len();

        // Binary search for first word (lowercased) >= prefix
        let mut low = 0usize;
        let mut high = count;
        while low < high {
            let mid = low + (high - low) / 2;
            let word = self.word_at(mid).to_lowercase();
            if word.as_str() < prefix_lower.as_str() {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        let mut results = Vec::new();
        for i in low..count {
            let word = self.word_at(i);
            if word.to_lowercase().starts_with(&prefix_lower) {
                results.push(word.to_string());
                if results.len() >= limit {
                    break;
                }
            } else if !results.is_empty() {
                break;
            }
        }
        results
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn build_idx_32(entries: &[(&str, u32, u32)]) -> Vec<u8> {
        let mut buf = Vec::new();
        for (word, offset, size) in entries {
            buf.extend_from_slice(word.as_bytes());
            buf.push(0);
            buf.extend_from_slice(&offset.to_be_bytes());
            buf.extend_from_slice(&size.to_be_bytes());
        }
        buf
    }

    fn build_idx_64(entries: &[(&str, u64, u32)]) -> Vec<u8> {
        let mut buf = Vec::new();
        for (word, offset, size) in entries {
            buf.extend_from_slice(word.as_bytes());
            buf.push(0);
            buf.extend_from_slice(&offset.to_be_bytes());
            buf.extend_from_slice(&size.to_be_bytes());
        }
        buf
    }

    #[test]
    fn parses_all_four_entries() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        assert_eq!(idx.entry_count(), 4);

        let e = idx.entry(0);
        assert_eq!(e.word, "another");
        assert_eq!(e.offset, 0);
        assert_eq!(e.size, 8);

        let e = idx.entry(1);
        assert_eq!(e.word, "foo");
        assert_eq!(e.offset, 8);
        assert_eq!(e.size, 3);

        let e = idx.entry(2);
        assert_eq!(e.word, "lorem");
        assert_eq!(e.offset, 11);
        assert_eq!(e.size, 5);

        let e = idx.entry(3);
        assert_eq!(e.word, "some word");
        assert_eq!(e.offset, 16);
        assert_eq!(e.size, 13);
    }

    #[test]
    fn entry_count_matches_wordcount() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        assert_eq!(idx.entry_count(), 4);
    }

    #[test]
    fn total_bytes_matches_idxfilesize() {
        let data = std::fs::read(fixture("testdict.idx")).unwrap();
        assert_eq!(data.len(), 60);
    }

    #[test]
    fn entries_are_sorted_by_stardict_strcmp() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        for i in 0..idx.entry_count() - 1 {
            assert!(
                idx.word_at(i) < idx.word_at(i + 1)
                    || idx.word_at(i) == idx.word_at(i + 1),
                "Entries should be sorted: {:?} should come before {:?}",
                idx.word_at(i),
                idx.word_at(i + 1)
            );
        }
    }

    #[test]
    fn words_are_valid_utf8() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        for i in 0..idx.entry_count() {
            assert!(!idx.word_at(i).is_empty());
        }
    }

    #[test]
    fn binary_search_finds_existing_word() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        let result = idx.search("foo");
        assert!(result.is_some(), "Should find 'foo'");
        let entry = result.unwrap();
        assert_eq!(entry.word, "foo");
        assert_eq!(entry.offset, 8);
        assert_eq!(entry.size, 3);
    }

    #[test]
    fn binary_search_finds_first_word() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        let result = idx.search("another");
        assert!(result.is_some());
        assert_eq!(result.unwrap().word, "another");
    }

    #[test]
    fn binary_search_finds_last_word() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        let result = idx.search("some word");
        assert!(result.is_some());
        assert_eq!(result.unwrap().word, "some word");
    }

    #[test]
    fn binary_search_returns_none_for_missing_word() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        let result = idx.search("nonexistent");
        assert!(result.is_none(), "Should return None for missing word");
    }

    #[test]
    fn binary_search_returns_none_for_empty_string() {
        let idx = Idx::open(&fixture("testdict.idx"), 32).unwrap();
        let result = idx.search("");
        assert!(result.is_none());
    }

    #[test]
    fn parses_64bit_offsets() {
        let data = build_idx_64(&[
            ("alpha", 0, 10),
            ("beta", 0x1_0000_0000, 20),
        ]);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test64.idx");
        std::fs::write(&path, &data).unwrap();

        let idx = Idx::open(&path, 64).unwrap();
        assert_eq!(idx.entry_count(), 2);

        let e = idx.entry(0);
        assert_eq!(e.word, "alpha");
        assert_eq!(e.offset, 0);
        assert_eq!(e.size, 10);

        let e = idx.entry(1);
        assert_eq!(e.word, "beta");
        assert_eq!(e.offset, 0x1_0000_0000);
        assert_eq!(e.size, 20);
    }

    #[test]
    fn truncated_idx_is_invalid_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trunc.idx");
        // Word "hi" + null + only 4 bytes (needs 8 for 32-bit offset+size)
        std::fs::write(&path, b"hi\x00\x00\x00\x00\x00").unwrap();
        let result = Idx::open(&path, 32);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn invalid_utf8_is_invalid_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("badutf8.idx");
        // Invalid UTF-8 byte 0xFF, then null, then 8 bytes of offset+size
        let mut data = vec![0xFF, 0x00];
        data.extend_from_slice(&[0u8; 8]);
        std::fs::write(&path, &data).unwrap();
        let result = Idx::open(&path, 32);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn missing_null_terminator_is_invalid_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonull.idx");
        // "hello" with no null terminator
        std::fs::write(&path, b"hello").unwrap();
        let result = Idx::open(&path, 32);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn nonexistent_idx_is_io_error() {
        let result = Idx::open(path::Path::new("/nonexistent/test.idx"), 32);
        assert!(matches!(result, Err(crate::error::Error::Io(_))));
    }

    #[test]
    fn parses_synthetic_32bit_idx() {
        let data = build_idx_32(&[("cat", 0, 5), ("dog", 5, 7)]);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synth.idx");
        std::fs::write(&path, &data).unwrap();

        let idx = Idx::open(&path, 32).unwrap();
        assert_eq!(idx.entry_count(), 2);

        let e = idx.entry(0);
        assert_eq!(e.word, "cat");
        assert_eq!(e.offset, 0);
        assert_eq!(e.size, 5);

        let e = idx.entry(1);
        assert_eq!(e.word, "dog");
        assert_eq!(e.offset, 5);
        assert_eq!(e.size, 7);
    }
}
