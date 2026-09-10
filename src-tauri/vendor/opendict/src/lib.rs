pub mod error;
pub mod types;
pub mod stardict;
pub mod mdict;

use std::path;

pub use error::{Error, Result};
pub use types::{DictEntry, DictInfo};

pub trait Dictionary {
    fn lookup(&self, word: &str) -> Result<Option<Vec<DictEntry>>>;
    fn lookup_synonym(&self, word: &str) -> Result<Option<Vec<DictEntry>>>;
    fn word_list(&self) -> Vec<&str>;
    fn word_count(&self) -> usize;
    fn info(&self) -> &DictInfo;
    fn search_prefix(&self, prefix: &str, limit: usize) -> Vec<String>;
}

pub fn open(dir: impl AsRef<path::Path>) -> Result<Box<dyn Dictionary + Send + Sync>> {
    let dir = dir.as_ref();

    // Try StarDict first (.ifo), then MDict (.mdx)
    let stardict_err = match stardict::StarDictDictionary::open_dir(dir) {
        Ok(dict) => return Ok(Box::new(dict)),
        Err(e) => e,
    };

    let mdict_err = match mdict::MdictDictionary::open(dir) {
        Ok(dict) => return Ok(Box::new(dict)),
        Err(e) => e,
    };

    // Both formats failed.
    // If both hit I/O errors (e.g. directory doesn't exist), propagate the I/O error.
    // Otherwise report both errors so the user can see what went wrong.
    if matches!((&stardict_err, &mdict_err), (Error::Io(_), Error::Io(_))) {
        return Err(stardict_err);
    }

    Err(Error::InvalidFormat(format!(
        "not a recognized dictionary: StarDict: {}; MDict: {}",
        stardict_err, mdict_err
    )))
}
