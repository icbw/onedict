use std::io::BufRead;
use std::{fs, io, path};

use crate::error::Error;

#[derive(Debug, Clone)]
pub struct Ifo {
    pub author: String,
    pub version: String,
    pub name: String,
    pub date: String,
    pub description: String,
    pub email: String,
    pub web_site: String,
    pub same_type_sequence: String,
    pub idx_file_size: u64,
    pub word_count: usize,
    pub syn_word_count: usize,
    pub idx_offset_bits: u32,
}

impl Ifo {
    pub fn open(file: &path::Path) -> crate::Result<Ifo> {
        let mut it = Ifo {
            author: String::new(),
            version: String::new(),
            name: String::new(),
            date: String::new(),
            description: String::new(),
            email: String::new(),
            web_site: String::new(),
            same_type_sequence: String::new(),
            idx_file_size: 0,
            word_count: 0,
            syn_word_count: 0,
            idx_offset_bits: 32,
        };

        let mut has_name = false;
        let mut has_word_count = false;
        let mut has_idx_file_size = false;
        let mut magic_checked = false;

        for line in io::BufReader::new(fs::File::open(file)?).lines() {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if !magic_checked {
                if trimmed != "StarDict's dict ifo file" {
                    return Err(Error::InvalidFormat(format!(
                        "invalid magic line: {}", trimmed
                    )));
                }
                magic_checked = true;
                continue;
            }

            if let Some(id) = trimmed.find('=') {
                let key = trimmed[..id].trim();
                let val = trimmed[id + 1..].trim().to_string();
                match key {
                    "author" => it.author = val,
                    "bookname" => {
                        it.name = val;
                        has_name = true;
                    }
                    "version" => {
                        match val.as_str() {
                            "2.4.2" | "3.0.0" => it.version = val,
                            v => return Err(Error::Unsupported(format!(
                                "unsupported ifo version: {}", v
                            ))),
                        }
                    }
                    "description" => it.description = val,
                    "date" => it.date = val,
                    "idxfilesize" => {
                        it.idx_file_size = val.parse().map_err(|e| {
                            Error::InvalidFormat(format!("invalid idxfilesize: {}", e))
                        })?;
                        has_idx_file_size = true;
                    }
                    "wordcount" => {
                        it.word_count = val.parse().map_err(|e| {
                            Error::InvalidFormat(format!("invalid wordcount: {}", e))
                        })?;
                        has_word_count = true;
                    }
                    "website" => it.web_site = val,
                    "email" => it.email = val,
                    "sametypesequence" => it.same_type_sequence = val,
                    "synwordcount" => {
                        it.syn_word_count = val.parse().map_err(|e| {
                            Error::InvalidFormat(format!("invalid synwordcount: {}", e))
                        })?;
                    }
                    "idxoffsetbits" => {
                        it.idx_offset_bits = val.parse().map_err(|e| {
                            Error::InvalidFormat(format!("invalid idxoffsetbits: {}", e))
                        })?;
                    }
                    _ => {}
                };
            }
        }

        if !has_name {
            return Err(Error::InvalidFormat(
                "missing required field: bookname".into(),
            ));
        }
        if !has_word_count {
            return Err(Error::InvalidFormat(
                "missing required field: wordcount".into(),
            ));
        }
        if !has_idx_file_size {
            return Err(Error::InvalidFormat(
                "missing required field: idxfilesize".into(),
            ));
        }

        Ok(it)
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

    #[test]
    fn rejects_wrong_magic_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.ifo");
        std::fs::write(
            &path,
            "Wrong magic line\nversion=3.0.0\nbookname=Test\nwordcount=1\nidxfilesize=10\n",
        )
        .unwrap();
        let result = Ifo::open(&path);
        assert!(result.is_err(), "Should reject wrong magic line");
    }

    #[test]
    fn accepts_correct_magic_line() {
        let result = Ifo::open(&fixture("testdict.ifo"));
        assert!(result.is_ok(), "Should accept correct magic line");
    }

    #[test]
    fn parses_v300() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.version, "3.0.0");
    }

    #[test]
    fn parses_v242() {
        let ifo = Ifo::open(&fixture("v242.ifo")).unwrap();
        assert_eq!(ifo.version, "2.4.2");
    }

    #[test]
    fn rejects_unknown_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad_ver.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\nversion=1.0.0\nbookname=Test\nwordcount=1\nidxfilesize=10\n",
        )
        .unwrap();
        let result = Ifo::open(&path);
        assert!(result.is_err(), "Should reject unknown version");
    }

    #[test]
    fn parses_bookname() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.name, "A foo-bar dictionary");
    }

    #[test]
    fn parses_wordcount() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.word_count, 4);
    }

    #[test]
    fn parses_idxfilesize() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.idx_file_size, 60);
    }

    #[test]
    fn parses_sametypesequence() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.same_type_sequence, "m");
    }

    #[test]
    fn parses_description_empty() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.description, "");
    }

    #[test]
    fn parses_v242_bookname() {
        let ifo = Ifo::open(&fixture("v242.ifo")).unwrap();
        assert_eq!(ifo.name, "Test Dict v242");
    }

    #[test]
    fn parses_v242_wordcount() {
        let ifo = Ifo::open(&fixture("v242.ifo")).unwrap();
        assert_eq!(ifo.word_count, 2);
    }

    #[test]
    fn parses_v242_idxfilesize() {
        let ifo = Ifo::open(&fixture("v242.ifo")).unwrap();
        assert_eq!(ifo.idx_file_size, 24);
    }

    #[test]
    fn optional_author_defaults_empty() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.author, "");
    }

    #[test]
    fn optional_email_defaults_empty() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.email, "");
    }

    #[test]
    fn optional_website_defaults_empty() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.web_site, "");
    }

    #[test]
    fn idxoffsetbits_defaults_to_32() {
        let ifo = Ifo::open(&fixture("testdict.ifo")).unwrap();
        assert_eq!(ifo.idx_offset_bits, 32);
    }

    #[test]
    fn parses_idxoffsetbits_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bits64.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\nversion=3.0.0\nbookname=Test\nwordcount=1\nidxfilesize=10\nidxoffsetbits=64\n",
        )
        .unwrap();
        let ifo = Ifo::open(&path).unwrap();
        assert_eq!(ifo.idx_offset_bits, 64);
    }

    #[test]
    fn synwordcount_defaults_to_zero() {
        let ifo = Ifo::open(&fixture("v242.ifo")).unwrap();
        assert_eq!(ifo.syn_word_count, 0);
    }

    #[test]
    fn trims_whitespace_around_equals() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("spaces.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\nversion=3.0.0\nbookname = Spaced Name \nwordcount = 4 \nidxfilesize = 60 \n",
        )
        .unwrap();
        let ifo = Ifo::open(&path).unwrap();
        assert_eq!(ifo.name, "Spaced Name");
        assert_eq!(ifo.word_count, 4);
        assert_eq!(ifo.idx_file_size, 60);
    }

    #[test]
    fn blank_lines_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blanks.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\n\nversion=3.0.0\n\nbookname=Blanky\n\nwordcount=1\nidxfilesize=10\n\n",
        )
        .unwrap();
        let ifo = Ifo::open(&path).unwrap();
        assert_eq!(ifo.name, "Blanky");
    }

    #[test]
    fn missing_bookname_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_name.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\nversion=3.0.0\nwordcount=1\nidxfilesize=10\n",
        )
        .unwrap();
        let result = Ifo::open(&path);
        assert!(result.is_err(), "Should error on missing bookname");
    }

    #[test]
    fn missing_wordcount_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_wc.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\nversion=3.0.0\nbookname=Test\nidxfilesize=10\n",
        )
        .unwrap();
        let result = Ifo::open(&path);
        assert!(result.is_err(), "Should error on missing wordcount");
    }

    #[test]
    fn missing_idxfilesize_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_idx.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\nversion=3.0.0\nbookname=Test\nwordcount=1\n",
        )
        .unwrap();
        let result = Ifo::open(&path);
        assert!(result.is_err(), "Should error on missing idxfilesize");
    }

    #[test]
    fn wordcount_handles_large_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\nversion=3.0.0\nbookname=Big\nwordcount=3000000000\nidxfilesize=99999999\n",
        )
        .unwrap();
        let ifo = Ifo::open(&path).unwrap();
        assert_eq!(ifo.word_count, 3_000_000_000);
    }

    #[test]
    fn nonexistent_file_is_io_error() {
        let result = Ifo::open(path::Path::new("/nonexistent/path.ifo"));
        assert!(matches!(result, Err(crate::error::Error::Io(_))));
    }

    #[test]
    fn wrong_magic_is_invalid_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.ifo");
        std::fs::write(&path, "Wrong magic\nversion=3.0.0\nbookname=X\nwordcount=1\nidxfilesize=10\n").unwrap();
        let result = Ifo::open(&path);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn unsupported_version_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad_ver.ifo");
        std::fs::write(&path, "StarDict's dict ifo file\nversion=1.0.0\nbookname=X\nwordcount=1\nidxfilesize=10\n").unwrap();
        let result = Ifo::open(&path);
        assert!(matches!(result, Err(crate::error::Error::Unsupported(_))));
    }

    #[test]
    fn missing_bookname_is_invalid_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_name.ifo");
        std::fs::write(&path, "StarDict's dict ifo file\nversion=3.0.0\nwordcount=1\nidxfilesize=10\n").unwrap();
        let result = Ifo::open(&path);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn invalid_wordcount_is_invalid_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad_wc.ifo");
        std::fs::write(&path, "StarDict's dict ifo file\nversion=3.0.0\nbookname=X\nwordcount=abc\nidxfilesize=10\n").unwrap();
        let result = Ifo::open(&path);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn parses_all_optional_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("full.ifo");
        std::fs::write(
            &path,
            "StarDict's dict ifo file\n\
             version=3.0.0\n\
             bookname=Full Dict\n\
             wordcount=100\n\
             idxfilesize=5000\n\
             author=Jane Doe\n\
             email=jane@example.com\n\
             website=https://example.com\n\
             description=A test dictionary\n\
             date=2024.01.01\n\
             sametypesequence=m\n\
             synwordcount=10\n\
             idxoffsetbits=64\n",
        )
        .unwrap();
        let ifo = Ifo::open(&path).unwrap();
        assert_eq!(ifo.author, "Jane Doe");
        assert_eq!(ifo.email, "jane@example.com");
        assert_eq!(ifo.web_site, "https://example.com");
        assert_eq!(ifo.description, "A test dictionary");
        assert_eq!(ifo.date, "2024.01.01");
        assert_eq!(ifo.same_type_sequence, "m");
        assert_eq!(ifo.syn_word_count, 10);
        assert_eq!(ifo.idx_offset_bits, 64);
    }
}
