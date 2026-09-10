//! Integration tests — full dictionary load and search lifecycle.
//!
//! Uses the complete testdict.* fixture set.

use std::path::PathBuf;

use opendict::stardict::StarDictDictionary as Dictionary;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

// ── Full lifecycle ───────────────────────────────────────────────────

#[test]
fn load_dictionary_from_fixtures() {
    let dict = Dictionary::open(&fixtures_dir(), "testdict");
    assert!(dict.is_ok(), "Should load dictionary from fixture files");
}

#[test]
fn list_all_words_from_index() {
    let dict = Dictionary::open(&fixtures_dir(), "testdict").unwrap();
    let words = dict.word_list();
    assert_eq!(words, vec!["another", "foo", "lorem", "some word"]);
}

#[test]
fn lookup_foo_returns_bar() {
    let dict = Dictionary::open(&fixtures_dir(), "testdict").unwrap();
    let results = dict.lookup("foo").unwrap().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].type_id, 'm');
    assert_eq!(std::str::from_utf8(&results[0].data).unwrap(), "bar");
}

#[test]
fn lookup_another_returns_translat() {
    let dict = Dictionary::open(&fixtures_dir(), "testdict").unwrap();
    let results = dict.lookup("another").unwrap().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].type_id, 'm');
    assert_eq!(
        std::str::from_utf8(&results[0].data).unwrap(),
        "translat"
    );
}

#[test]
fn lookup_some_word_returns_a_translation() {
    let dict = Dictionary::open(&fixtures_dir(), "testdict").unwrap();
    let results = dict.lookup("some word").unwrap().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].type_id, 'm');
    assert_eq!(
        std::str::from_utf8(&results[0].data).unwrap(),
        "a translation"
    );
}

#[test]
fn lookup_nonexistent_returns_empty() {
    let dict = Dictionary::open(&fixtures_dir(), "testdict").unwrap();
    let result = dict.lookup("nonexistent").unwrap();
    assert!(result.is_none(), "Nonexistent word should return None");
}

// ── Synonym resolution ───────────────────────────────────────────────

#[test]
fn synonym_abc_resolves_to_some_word() {
    // "abc" is a synonym pointing to index 3, which is "some word"
    let dict = Dictionary::open(&fixtures_dir(), "testdict").unwrap();
    let results = dict.lookup_synonym("abc").unwrap().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].type_id, 'm');
    assert_eq!(
        std::str::from_utf8(&results[0].data).unwrap(),
        "a translation"
    );
}

// ── Metadata access ─────────────────────────────────────────────────

#[test]
fn info_returns_correct_metadata() {
    use opendict::Dictionary as _;
    let dict =
        opendict::stardict::StarDictDictionary::open(&fixtures_dir(), "testdict").unwrap();
    let info = dict.info();
    assert_eq!(info.name, "A foo-bar dictionary");
    assert_eq!(info.word_count, 4);
}

// ── Multitype dictionary ─────────────────────────────────────────────

#[test]
fn load_multitype_dictionary() {
    let dict = Dictionary::open(&fixtures_dir(), "multitype");
    assert!(
        dict.is_ok(),
        "Should load multitype dictionary (no sametypesequence)"
    );
}

#[test]
fn multitype_lookup_hello() {
    let dict = Dictionary::open(&fixtures_dir(), "multitype").unwrap();
    let results = dict.lookup("hello").unwrap().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].type_id, 'h');
    assert_eq!(results[0].data, b"<b>hello</b>");
    assert_eq!(results[1].type_id, 't');
    assert_eq!(results[1].data, b"helo");
}

#[test]
fn multitype_lookup_world() {
    let dict = Dictionary::open(&fixtures_dir(), "multitype").unwrap();
    let results = dict.lookup("world").unwrap().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].type_id, 'm');
    assert_eq!(results[0].data, b"the world");
}

// ── Error variant tests ─────────────────────────────────────────────

#[test]
fn open_nonexistent_dir_is_io_error() {
    let result = opendict::open("/nonexistent/path/to/dict");
    assert!(matches!(result, Err(opendict::Error::Io(_))));
}

#[test]
fn open_empty_dir_is_invalid_format() {
    let dir = tempfile::tempdir().unwrap();
    let result = opendict::open(dir.path());
    assert!(matches!(result, Err(opendict::Error::InvalidFormat(_))));
}
