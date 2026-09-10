pub(crate) mod ifo;
pub(crate) mod idx;
pub(crate) mod dict;
pub(crate) mod syn;
pub(crate) mod strcmp;
pub(crate) mod io;
pub(crate) mod index_util;

use std::path;

use crate::error::Error;
use crate::types::{DictEntry, DictInfo};
use crate::Dictionary;

#[derive(Debug)]
pub struct StarDictDictionary {
    pub(crate) idx: idx::Idx,
    pub(crate) ifo: ifo::Ifo,
    pub(crate) dict: dict::Dict,
    pub(crate) syn: Option<syn::Syn>,
    info_data: DictInfo,
}

impl StarDictDictionary {
    /// Auto-detect: finds the .ifo file in the directory.
    pub fn open_dir(dir: &path::Path) -> crate::Result<Self> {
        let ifo_path = find_file_with_ext(dir, "ifo")?;
        let name = ifo_path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| Error::InvalidFormat(format!(
                "invalid .ifo filename: {}", ifo_path.display()
            )))?
            .to_string();
        let ifo = ifo::Ifo::open(&ifo_path)?;
        Self::open_from_ifo(dir, &name, ifo)
    }

    /// Load a dictionary from a directory, given the dictionary name prefix.
    pub fn open(dir: &path::Path, name: &str) -> crate::Result<Self> {
        let ifo = ifo::Ifo::open(&dir.join(format!("{}.ifo", name)))?;
        Self::open_from_ifo(dir, name, ifo)
    }

    fn open_from_ifo(dir: &path::Path, name: &str, ifo: ifo::Ifo) -> crate::Result<Self> {
        let idx_path = dir.join(format!("{}.idx", name));
        let idx_path = if idx_path.exists() {
            idx_path
        } else {
            dir.join(format!("{}.idx.gz", name))
        };
        let idx = idx::Idx::open(&idx_path, ifo.idx_offset_bits)?;

        let dict_path = dir.join(format!("{}.dict", name));
        let dict_path = if dict_path.exists() {
            dict_path
        } else {
            dir.join(format!("{}.dict.dz", name))
        };
        let dict = dict::Dict::open(&dict_path, true)?;

        let syn_path = dir.join(format!("{}.syn", name));
        let syn = if syn_path.exists() && ifo.syn_word_count > 0 {
            Some(syn::Syn::open(&syn_path)?)
        } else {
            None
        };

        let info_data = DictInfo {
            name: ifo.name.clone(),
            author: ifo.author.clone(),
            description: ifo.description.clone(),
            word_count: ifo.word_count,
        };

        Ok(StarDictDictionary { idx, ifo, dict, syn, info_data })
    }

    /// Look up a word and return its dictionary entries.
    pub fn lookup(&self, word: &str) -> crate::Result<Option<Vec<DictEntry>>> {
        let entry = match self.idx.search(word) {
            Some(e) => e,
            None => return Ok(None),
        };
        let sametypesequence = if self.ifo.same_type_sequence.is_empty() {
            None
        } else {
            Some(self.ifo.same_type_sequence.as_str())
        };
        self.dict.read_entry(entry.offset, entry.size, sametypesequence).map(Some)
    }

    /// Look up a synonym and return the dictionary entries for its target word.
    pub fn lookup_synonym(&self, synonym: &str) -> crate::Result<Option<Vec<DictEntry>>> {
        let syn = match self.syn.as_ref() {
            Some(s) => s,
            None => return Ok(None),
        };
        let syn_entry = match syn.lookup(synonym) {
            Some(e) => e,
            None => return Ok(None),
        };
        let i = syn_entry.original_word_index as usize;
        if i >= self.idx.entry_count() {
            return Ok(None);
        }
        let target = self.idx.entry(i);
        let sametypesequence = if self.ifo.same_type_sequence.is_empty() {
            None
        } else {
            Some(self.ifo.same_type_sequence.as_str())
        };
        self.dict.read_entry(target.offset, target.size, sametypesequence).map(Some)
    }

    /// Return a list of all words in the index.
    pub fn word_list(&self) -> Vec<&str> {
        (0..self.idx.entry_count())
            .map(|i| self.idx.word_at(i))
            .collect()
    }
}

impl Dictionary for StarDictDictionary {
    fn lookup(&self, word: &str) -> crate::Result<Option<Vec<DictEntry>>> {
        self.lookup(word)
    }

    fn lookup_synonym(&self, word: &str) -> crate::Result<Option<Vec<DictEntry>>> {
        self.lookup_synonym(word)
    }

    fn word_list(&self) -> Vec<&str> {
        self.word_list()
    }

    fn word_count(&self) -> usize {
        self.idx.entry_count()
    }

    fn info(&self) -> &DictInfo {
        &self.info_data
    }

    fn search_prefix(&self, prefix: &str, limit: usize) -> Vec<String> {
        self.idx.search_prefix(prefix, limit)
    }
}

fn find_file_with_ext(dir: &path::Path, ext: &str) -> crate::Result<path::PathBuf> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == ext) {
            return Ok(path);
        }
    }
    Err(Error::InvalidFormat(format!(
        "no .{} file found in {}", ext, dir.display()
    )))
}
