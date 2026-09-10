use std::fs::{self, File};
use std::io::{Read, Write};
use std::path;

use flate2::read::GzDecoder;
use memmap2::Mmap;

use crate::error::Error;
use crate::types::DictEntry;

#[derive(Debug)]
enum DictData {
    Mapped(Mmap),
    Owned(Vec<u8>),
}

#[derive(Debug)]
pub struct Dict {
    data: DictData,
}

impl Dict {
    /// Open a .dict or .dict.dz/.dict.gz file.
    ///
    /// If `cache_to_disk` is true and the file is compressed, the decompressed
    /// data is written alongside the original as a `.dict` file for faster
    /// subsequent opens. When false, compressed data is decompressed in memory.
    ///
    /// An existing decompressed `.dict` file is always used if present,
    /// regardless of this flag.
    pub fn open(file: &path::Path, cache_to_disk: bool) -> crate::Result<Dict> {
        let is_compressed = file.extension()
            .is_some_and(|ext| ext == "gz" || ext == "dz");
        if is_compressed {
            // Check if a decompressed .dict already exists alongside
            let decompressed_path = file.with_extension("").with_extension("dict");
            if decompressed_path.exists() {
                return Self::open_mmap(&decompressed_path);
            }

            // Decompress the gzip data
            let raw = fs::read(file)?;
            let mut decoder = GzDecoder::new(&raw[..]);
            let mut decompressed = Vec::new();
            decoder.read_to_end(&mut decompressed)?;

            // Optionally write to disk and mmap
            if cache_to_disk {
                if let Ok(mut f) = File::create(&decompressed_path) {
                    let _ = f.write_all(&decompressed);
                    drop(f);
                    return Self::open_mmap(&decompressed_path);
                }
            }

            Ok(Dict { data: DictData::Owned(decompressed) })
        } else {
            Self::open_mmap(file)
        }
    }

    fn open_mmap(file: &path::Path) -> crate::Result<Dict> {
        let f = File::open(file)?;
        // SAFETY: dictionary files are read-only; we do not modify them.
        let mmap = unsafe { Mmap::map(&f)? };
        Ok(Dict { data: DictData::Mapped(mmap) })
    }

    fn bytes(&self) -> &[u8] {
        match &self.data {
            DictData::Mapped(m) => m,
            DictData::Owned(v) => v,
        }
    }

    pub fn read_entry(
        &self,
        offset: u64,
        size: u32,
        sametypesequence: Option<&str>,
    ) -> crate::Result<Vec<DictEntry>> {
        let data = self.bytes();
        let start = offset as usize;
        let end = start + size as usize;
        if end > data.len() {
            return Err(Error::InvalidFormat(format!(
                "dict entry offset {}+{} exceeds data length {}",
                start, size, data.len()
            )));
        }
        let raw = &data[start..end];
        Self::parse_entries(raw, sametypesequence)
    }

    fn parse_entries(data: &[u8], sametypesequence: Option<&str>) -> crate::Result<Vec<DictEntry>> {
        let mut raw = data;
        let mut entries = Vec::new();

        match sametypesequence {
            Some(sts) => {
                let types: Vec<char> = sts.chars().collect();
                for (i, &type_id) in types.iter().enumerate() {
                    let is_last = i == types.len() - 1;
                    if is_last {
                        entries.push(DictEntry {
                            type_id,
                            data: raw.to_vec(),
                        });
                        break;
                    }
                    if type_id.is_ascii_uppercase() {
                        if raw.len() < 4 {
                            return Err(Error::InvalidFormat(
                                "dict entry truncated: not enough data for length prefix".into(),
                            ));
                        }
                        let len =
                            u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
                        if 4 + len > raw.len() {
                            return Err(Error::InvalidFormat(format!(
                                "dict entry truncated: need {} bytes but only {} remain",
                                4 + len, raw.len()
                            )));
                        }
                        entries.push(DictEntry {
                            type_id,
                            data: raw[4..4 + len].to_vec(),
                        });
                        raw = &raw[4 + len..];
                    } else {
                        let null_pos = raw.iter().position(|&b| b == 0).ok_or_else(|| {
                            Error::InvalidFormat(
                                "missing null terminator in dict entry".into(),
                            )
                        })?;
                        entries.push(DictEntry {
                            type_id,
                            data: raw[..null_pos].to_vec(),
                        });
                        raw = &raw[null_pos + 1..];
                    }
                }
            }
            None => {
                while !raw.is_empty() {
                    let type_id = raw[0] as char;
                    raw = &raw[1..];

                    if type_id.is_ascii_uppercase() {
                        if raw.len() < 4 {
                            return Err(Error::InvalidFormat(
                                "dict entry truncated: not enough data for length prefix".into(),
                            ));
                        }
                        let len =
                            u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
                        if 4 + len > raw.len() {
                            return Err(Error::InvalidFormat(format!(
                                "dict entry truncated: need {} bytes but only {} remain",
                                4 + len, raw.len()
                            )));
                        }
                        entries.push(DictEntry {
                            type_id,
                            data: raw[4..4 + len].to_vec(),
                        });
                        raw = &raw[4 + len..];
                    } else {
                        let null_pos = raw.iter().position(|&b| b == 0).ok_or_else(|| {
                            Error::InvalidFormat(
                                "missing null terminator in dict entry".into(),
                            )
                        })?;
                        entries.push(DictEntry {
                            type_id,
                            data: raw[..null_pos].to_vec(),
                        });
                        raw = &raw[null_pos + 1..];
                    }
                }
            }
        }

        Ok(entries)
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

    // ── sametypesequence=m (testdict.dict, 29 bytes) ─────────────────────

    #[test]
    fn reads_another_at_offset_0() {
        let dict = Dict::open(&fixture("testdict.dict"), false).unwrap();
        let entries = dict.read_entry(0, 8, Some("m")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].type_id, 'm');
        assert_eq!(entries[0].data, b"translat");
    }

    #[test]
    fn reads_foo_at_offset_8() {
        let dict = Dict::open(&fixture("testdict.dict"), false).unwrap();
        let entries = dict.read_entry(8, 3, Some("m")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].type_id, 'm');
        assert_eq!(entries[0].data, b"bar");
    }

    #[test]
    fn reads_lorem_at_offset_11() {
        let dict = Dict::open(&fixture("testdict.dict"), false).unwrap();
        let entries = dict.read_entry(11, 5, Some("m")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].type_id, 'm');
        assert_eq!(entries[0].data, b"ipsum");
    }

    #[test]
    fn reads_some_word_at_offset_16() {
        let dict = Dict::open(&fixture("testdict.dict"), false).unwrap();
        let entries = dict.read_entry(16, 13, Some("m")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].type_id, 'm');
        assert_eq!(entries[0].data, b"a translation");
    }

    #[test]
    fn last_entry_has_no_null_terminator() {
        let dict = Dict::open(&fixture("testdict.dict"), false).unwrap();
        let entries = dict.read_entry(16, 13, Some("m")).unwrap();
        assert_eq!(entries[0].data, b"a translation");
        assert_ne!(entries[0].data.last(), Some(&0u8));
    }

    #[test]
    fn all_entries_type_m() {
        let dict = Dict::open(&fixture("testdict.dict"), false).unwrap();
        let offsets: &[(u64, u32)] = &[(0, 8), (8, 3), (11, 5), (16, 13)];
        let expected_data: &[&[u8]] = &[b"translat", b"bar", b"ipsum", b"a translation"];
        for (i, &(offset, size)) in offsets.iter().enumerate() {
            let entries = dict.read_entry(offset, size, Some("m")).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].type_id, 'm');
            assert_eq!(entries[0].data, expected_data[i]);
        }
    }

    // ── sametypesequence=tm (synthetic) ──────────────────────────────────

    #[test]
    fn sametypesequence_tm_two_fields() {
        let phonetic = b"helo\0";
        let meaning = b"greeting word";
        let mut data = Vec::new();
        data.extend_from_slice(phonetic);
        data.extend_from_slice(meaning);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tm.dict");
        std::fs::write(&path, &data).unwrap();

        let dict = Dict::open(&path, false).unwrap();
        let entries = dict.read_entry(0, data.len() as u32, Some("tm")).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].type_id, 't');
        assert_eq!(entries[0].data, b"helo");
        assert_eq!(entries[1].type_id, 'm');
        assert_eq!(entries[1].data, b"greeting word");
    }

    // ── No sametypesequence (multitype.dict) ─────────────────────────────

    #[test]
    fn no_sametypesequence_entry1_two_fields() {
        let dict = Dict::open(&fixture("multitype.dict"), false).unwrap();
        let entries = dict.read_entry(0, 20, None).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].type_id, 'h');
        assert_eq!(entries[0].data, b"<b>hello</b>");
        assert_eq!(entries[1].type_id, 't');
        assert_eq!(entries[1].data, b"helo");
    }

    #[test]
    fn no_sametypesequence_entry2_one_field() {
        let dict = Dict::open(&fixture("multitype.dict"), false).unwrap();
        let entries = dict.read_entry(20, 11, None).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].type_id, 'm');
        assert_eq!(entries[0].data, b"the world");
    }

    // ── Uppercase type identifiers (binary data with u32 length) ─────────

    #[test]
    fn uppercase_type_has_u32_length_prefix() {
        let wav_data = b"\x00\x01\x02\x03\x04";
        let mut data = Vec::new();
        data.push(b'W');
        data.extend_from_slice(&(wav_data.len() as u32).to_be_bytes());
        data.extend_from_slice(wav_data);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("upper.dict");
        std::fs::write(&path, &data).unwrap();

        let dict = Dict::open(&path, false).unwrap();
        let entries = dict.read_entry(0, data.len() as u32, None).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].type_id, 'W');
        assert_eq!(entries[0].data, wav_data);
    }

    #[test]
    fn mixed_lowercase_and_uppercase_types() {
        let mut data = Vec::new();
        data.push(b'm');
        data.extend_from_slice(b"meaning\0");
        data.push(b'P');
        data.extend_from_slice(&3u32.to_be_bytes());
        data.extend_from_slice(&[0xAA, 0xBB, 0xCC]);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixed.dict");
        std::fs::write(&path, &data).unwrap();

        let dict = Dict::open(&path, false).unwrap();
        let entries = dict.read_entry(0, data.len() as u32, None).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].type_id, 'm');
        assert_eq!(entries[0].data, b"meaning");
        assert_eq!(entries[1].type_id, 'P');
        assert_eq!(entries[1].data, &[0xAA, 0xBB, 0xCC]);
    }

    // ── Unhappy path tests ──────────────────────────────────────────────

    #[test]
    fn read_entry_past_eof_is_invalid_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small.dict");
        std::fs::write(&path, b"hello").unwrap();
        let dict = Dict::open(&path, false).unwrap();
        let result = dict.read_entry(0, 100, Some("m"));
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn parse_entries_missing_null_is_invalid_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonull.dict");
        std::fs::write(&path, b"no null here").unwrap();
        let dict = Dict::open(&path, false).unwrap();
        let result = dict.read_entry(0, 12, Some("tm"));
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn uppercase_type_truncated_length_prefix_is_invalid_format() {
        // sametypesequence="Wm" but only 2 bytes of data — not enough for u32 length
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trunc_len.dict");
        std::fs::write(&path, [0xAA, 0xBB]).unwrap();
        let dict = Dict::open(&path, false).unwrap();
        let result = dict.read_entry(0, 2, Some("Wm"));
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn uppercase_type_oversized_length_is_invalid_format() {
        // sametypesequence="Wm", length prefix claims 999 bytes but only 5 follow
        let mut data = Vec::new();
        data.extend_from_slice(&999u32.to_be_bytes());
        data.extend_from_slice(&[0x01, 0x02, 0x03, 0x04, 0x05]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversize.dict");
        std::fs::write(&path, &data).unwrap();
        let dict = Dict::open(&path, false).unwrap();
        let result = dict.read_entry(0, data.len() as u32, Some("Wm"));
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn no_sts_uppercase_type_truncated_is_invalid_format() {
        // No sametypesequence: type byte 'W' then only 2 bytes (need 4 for length)
        let data = [b'W', 0x00, 0x01];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_sts_trunc.dict");
        std::fs::write(&path, data).unwrap();
        let dict = Dict::open(&path, false).unwrap();
        let result = dict.read_entry(0, data.len() as u32, None);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }
}
