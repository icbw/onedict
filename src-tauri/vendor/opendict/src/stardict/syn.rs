use std::{cmp::Ordering, fs, path, str};

use crate::error::Error;

use super::strcmp::stardict_strcmp;

/// A single synonym entry (constructed on demand, not stored).
#[derive(Debug, Clone)]
pub struct SynEntry {
    #[cfg_attr(not(test), allow(dead_code))]
    pub word: String,
    pub original_word_index: u32,
}

/// Compact synonym index: raw file bytes + entry offset table.
#[derive(Debug)]
pub struct Syn {
    data: Vec<u8>,
    offsets: Vec<u32>,
}

impl Syn {
    pub fn open(file: &path::Path) -> crate::Result<Syn> {
        let data = fs::read(file)?;
        let mut offsets = Vec::new();
        let mut pos = 0;

        while pos < data.len() {
            offsets.push(pos as u32);
            let null_pos = data[pos..]
                .iter()
                .position(|&b| b == 0)
                .ok_or_else(|| Error::InvalidFormat(format!(
                    "syn: missing null terminator at offset {}", pos
                )))?;
            str::from_utf8(&data[pos..pos + null_pos]).map_err(|e| {
                Error::InvalidFormat(format!("syn: invalid UTF-8 at offset {}: {}", pos, e))
            })?;
            let idx_start = pos + null_pos + 1;
            if idx_start + 4 > data.len() {
                return Err(Error::InvalidFormat(
                    "syn: unexpected EOF reading word index".into(),
                ));
            }
            pos = idx_start + 4;
        }

        Ok(Syn { data, offsets })
    }

    #[cfg(test)]
    pub fn entry_count(&self) -> usize {
        self.offsets.len()
    }

    #[cfg(test)]
    fn word_at(&self, i: usize) -> &str {
        super::index_util::word_at(&self.data, &self.offsets, i)
    }

    pub(crate) fn entry(&self, i: usize) -> SynEntry {
        let start = self.offsets[i] as usize;
        let null_pos = self.data[start..]
            .iter()
            .position(|&b| b == 0)
            .unwrap();
        let word = str::from_utf8(&self.data[start..start + null_pos])
            .unwrap()
            .to_string();
        let idx_start = start + null_pos + 1;
        let original_word_index = u32::from_be_bytes([
            self.data[idx_start],     self.data[idx_start + 1],
            self.data[idx_start + 2], self.data[idx_start + 3],
        ]);
        SynEntry { word, original_word_index }
    }

    pub fn lookup(&self, word: &str) -> Option<SynEntry> {
        self.binary_search(word, stardict_strcmp)
            .or_else(|| {
                self.binary_search(word, |w, target| w.as_bytes().cmp(target.as_bytes()))
            })
    }

    fn binary_search<F>(&self, word: &str, cmp: F) -> Option<SynEntry>
    where
        F: Fn(&str, &str) -> Ordering,
    {
        super::index_util::find_match(&self.data, &self.offsets, word, cmp)
            .map(|i| self.entry(i))
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

    fn build_syn(entries: &[(&str, u32)]) -> Vec<u8> {
        let mut buf = Vec::new();
        for (word, index) in entries {
            buf.extend_from_slice(word.as_bytes());
            buf.push(0);
            buf.extend_from_slice(&index.to_be_bytes());
        }
        buf
    }

    #[test]
    fn parses_two_entries() {
        let syn = Syn::open(&fixture("testdict.syn")).unwrap();
        assert_eq!(syn.entry_count(), 2);
    }

    #[test]
    fn first_entry_abc_points_to_index_3() {
        let syn = Syn::open(&fixture("testdict.syn")).unwrap();
        let e = syn.entry(0);
        assert_eq!(e.word, "abc");
        assert_eq!(e.original_word_index, 3);
    }

    #[test]
    fn second_entry_synonym_two_points_to_index_2() {
        let syn = Syn::open(&fixture("testdict.syn")).unwrap();
        let e = syn.entry(1);
        assert_eq!(e.word, "synonym two");
        assert_eq!(e.original_word_index, 2);
    }

    #[test]
    fn synwordcount_matches_entry_count() {
        let syn = Syn::open(&fixture("testdict.syn")).unwrap();
        assert_eq!(syn.entry_count(), 2);
    }

    #[test]
    fn synonym_word_is_null_terminated_utf8() {
        let data = std::fs::read(fixture("testdict.syn")).unwrap();
        assert_eq!(&data[0..3], b"abc");
        assert_eq!(data[3], 0);
        assert_eq!(&data[8..19], b"synonym two");
        assert_eq!(data[19], 0);
    }

    #[test]
    fn original_word_index_is_u32_big_endian() {
        let data = std::fs::read(fixture("testdict.syn")).unwrap();
        assert_eq!(&data[4..8], &[0, 0, 0, 3]);
        assert_eq!(&data[20..24], &[0, 0, 0, 2]);
    }

    #[test]
    fn entries_are_sorted() {
        let syn = Syn::open(&fixture("testdict.syn")).unwrap();
        for i in 0..syn.entry_count() - 1 {
            assert!(
                stardict_strcmp(syn.word_at(i), syn.word_at(i + 1)) != std::cmp::Ordering::Greater,
                "SYN entries should be sorted: {:?} should come before {:?}",
                syn.word_at(i),
                syn.word_at(i + 1)
            );
        }
    }

    #[test]
    fn parses_synthetic_syn_file() {
        let data = build_syn(&[("alpha", 0), ("bravo", 1), ("charlie", 2)]);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synth.syn");
        std::fs::write(&path, &data).unwrap();

        let syn = Syn::open(&path).unwrap();
        assert_eq!(syn.entry_count(), 3);

        let e = syn.entry(0);
        assert_eq!(e.word, "alpha");
        assert_eq!(e.original_word_index, 0);

        let e = syn.entry(1);
        assert_eq!(e.word, "bravo");
        assert_eq!(e.original_word_index, 1);

        let e = syn.entry(2);
        assert_eq!(e.word, "charlie");
        assert_eq!(e.original_word_index, 2);
    }

    #[test]
    fn lookup_synonym_by_word() {
        let syn = Syn::open(&fixture("testdict.syn")).unwrap();

        let result = syn.lookup("abc");
        assert!(result.is_some(), "Should find synonym 'abc'");
        assert_eq!(result.unwrap().original_word_index, 3);

        let result = syn.lookup("synonym two");
        assert!(result.is_some());
        assert_eq!(result.unwrap().original_word_index, 2);

        let result = syn.lookup("nonexistent");
        assert!(result.is_none());
    }
}
