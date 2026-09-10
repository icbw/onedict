//! Tests against real dictionaries in tests/dicts/.
//!
//! These tests are #[ignore]d by default and run explicitly with:
//!   cargo test -- --ignored
//!
//! Directory structure:
//!   tests/dicts/stardict/  — StarDict dictionaries (.ifo/.idx/.dict)
//!   tests/dicts/mdict/     — MDict dictionaries (.mdx)

use std::path::PathBuf;

use opendict::stardict::StarDictDictionary as Dictionary;

fn dicts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("dicts")
}

/// Scan tests/dicts/stardict/ for subdirectories containing .ifo files.
fn find_stardict_dirs() -> Vec<(String, PathBuf)> {
    let dir = dicts_dir().join("stardict");
    if !dir.is_dir() {
        return Vec::new();
    }

    let mut dicts = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            if let Ok(files) = std::fs::read_dir(&path) {
                for file in files {
                    let file = file.unwrap();
                    let fname = file.file_name();
                    let fname = fname.to_string_lossy();
                    if fname.ends_with(".ifo") {
                        let dict_name = fname.trim_end_matches(".ifo").to_string();
                        dicts.push((dict_name, path.clone()));
                        break;
                    }
                }
            }
        }
    }
    dicts
}

/// Scan tests/dicts/mdict/ for subdirectories containing .mdx files.
fn find_mdict_dirs() -> Vec<(String, PathBuf)> {
    let dir = dicts_dir().join("mdict");
    if !dir.is_dir() {
        return Vec::new();
    }

    let mut dicts = Vec::new();
    find_mdx_recursive(&dir, &mut dicts);
    dicts
}

fn find_mdx_recursive(dir: &std::path::Path, dicts: &mut Vec<(String, PathBuf)>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                // Check if this directory contains .mdx files
                let mut found = false;
                if let Ok(files) = std::fs::read_dir(&path) {
                    for file in files {
                        let file = file.unwrap();
                        let fname = file.file_name();
                        let fname = fname.to_string_lossy();
                        if fname.to_ascii_lowercase().ends_with(".mdx") {
                            let dict_name = fname.trim_end_matches(".mdx")
                                .trim_end_matches(".MDX")
                                .to_string();
                            dicts.push((dict_name, path.clone()));
                            found = true;
                            break;
                        }
                    }
                }
                if !found {
                    find_mdx_recursive(&path, dicts);
                }
            }
        }
    }
}

// ── StarDict tests ──────────────────────────────────────────────────

#[test]
#[ignore]
fn load_all_stardict_dicts() {
    let dicts = find_stardict_dirs();
    if dicts.is_empty() {
        eprintln!("No StarDict dictionaries found in tests/dicts/stardict/. Skipping.");
        return;
    }

    for (name, dir) in &dicts {
        eprintln!("Loading StarDict: {} from {}", name, dir.display());
        let dict = Dictionary::open(dir, name);
        assert!(
            dict.is_ok(),
            "Failed to load StarDict '{}': {:?}",
            name,
            dict.err()
        );
    }
}

#[test]
#[ignore]
fn stardict_wordcount_matches_idx_entries() {
    use opendict::Dictionary as _;
    let dicts = find_stardict_dirs();
    for (name, dir) in &dicts {
        let dict = Dictionary::open(dir, name).unwrap();
        let words = dict.word_list();
        assert_eq!(
            words.len(),
            dict.info().word_count,
            "StarDict '{}': wordcount={} but idx has {} entries",
            name,
            dict.info().word_count,
            words.len()
        );
    }
}

#[test]
#[ignore]
fn stardict_lookup_first_last_middle_word() {
    let dicts = find_stardict_dirs();
    for (name, dir) in &dicts {
        let dict = Dictionary::open(dir, name).unwrap();
        let words = dict.word_list();
        if words.is_empty() {
            continue;
        }

        let result = dict.lookup(words[0]).unwrap();
        assert!(
            result.is_some() && !result.as_ref().unwrap().is_empty(),
            "StarDict '{}': first word '{}' returned empty",
            name,
            words[0]
        );

        let last = &words[words.len() - 1];
        let result = dict.lookup(last).unwrap();
        assert!(
            result.is_some() && !result.as_ref().unwrap().is_empty(),
            "StarDict '{}': last word '{}' returned empty",
            name,
            last
        );

        let mid = &words[words.len() / 2];
        let result = dict.lookup(mid).unwrap();
        assert!(
            result.is_some() && !result.as_ref().unwrap().is_empty(),
            "StarDict '{}': middle word '{}' returned empty",
            name,
            mid
        );
    }
}

#[test]
#[ignore]
fn stardict_verify_all_lookups() {
    let dicts = find_stardict_dirs();
    for (name, dir) in &dicts {
        let dict = Dictionary::open(dir, name).unwrap();
        let words = dict.word_list();
        let mut failures = 0;
        for word in &words {
            if dict.lookup(word).unwrap().is_none() {
                failures += 1;
            }
        }
        assert_eq!(
            failures, 0,
            "StarDict '{}': {}/{} words not found via lookup",
            name, failures, words.len()
        );
    }
}

// ── MDict tests ─────────────────────────────────────────────────────

#[test]
#[ignore]
fn load_all_mdict_dicts() {
    let dicts = find_mdict_dirs();
    if dicts.is_empty() {
        eprintln!("No MDict dictionaries found in tests/dicts/mdict/. Skipping.");
        return;
    }

    let mut loaded = 0;
    for (name, dir) in &dicts {
        eprintln!("Loading MDict: {} from {}", name, dir.display());
        let dict = opendict::open(dir);
        match &dict {
            Ok(d) => {
                eprintln!("  -> {} words", d.word_count());
                loaded += 1;
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("unsupported") || msg.contains("LZO") {
                    eprintln!("  -> SKIPPED (unsupported feature): {}", msg);
                } else {
                    panic!("Failed to load MDict '{}': {}", name, e);
                }
            }
        }
    }
    if loaded == 0 {
        eprintln!("No MDict dicts could be loaded (all use unsupported features). Skipping.");
    }
}

#[test]
#[ignore]
fn mdict_lookup_first_last_middle_word() {
    let dicts = find_mdict_dirs();
    for (name, dir) in &dicts {
        let dict = match opendict::open(dir) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("Skipping MDict '{}': {}", name, e);
                continue;
            }
        };
        let words = dict.word_list();
        if words.is_empty() {
            continue;
        }

        eprintln!("MDict '{}': {} words, testing lookups...", name, words.len());

        let result = dict.lookup(words[0]).unwrap();
        assert!(
            result.is_some() && !result.as_ref().unwrap().is_empty(),
            "MDict '{}': first word '{}' returned empty",
            name,
            words[0]
        );

        let last = &words[words.len() - 1];
        let result = dict.lookup(last).unwrap();
        assert!(
            result.is_some() && !result.as_ref().unwrap().is_empty(),
            "MDict '{}': last word '{}' returned empty",
            name,
            last
        );

        let mid = &words[words.len() / 2];
        let result = dict.lookup(mid).unwrap();
        assert!(
            result.is_some() && !result.as_ref().unwrap().is_empty(),
            "MDict '{}': middle word '{}' returned empty",
            name,
            mid
        );
    }
}

#[test]
#[ignore]
fn mdict_verify_all_lookups() {
    let dicts = find_mdict_dirs();
    for (name, dir) in &dicts {
        let dict = match opendict::open(dir) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("Skipping MDict '{}': {}", name, e);
                continue;
            }
        };
        let words = dict.word_list();
        let mut failures = 0;
        for word in &words {
            if dict.lookup(word).unwrap().is_none() {
                failures += 1;
            }
        }
        assert_eq!(
            failures, 0,
            "MDict '{}': {}/{} words not found via lookup",
            name, failures, words.len()
        );
    }
}

// ── Language-specific validation ────────────────────────────────────

fn mdict_dir() -> PathBuf {
    dicts_dir().join("mdict")
}

fn stardict_dir() -> PathBuf {
    dicts_dir().join("stardict")
}

/// Helper: open MDict, look up a word, return decoded result text.
fn mdict_lookup(subdir: &str, word: &str) -> Option<String> {
    let dir = mdict_dir().join(subdir);
    let dict = opendict::open(dir).ok()?;
    let entries = dict.lookup(word).ok()??;
    let text = entries
        .iter()
        .map(|e| String::from_utf8_lossy(&e.data).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    Some(text)
}

/// Helper: open MDict, do prefix search.
fn mdict_prefix(subdir: &str, prefix: &str, limit: usize) -> Vec<String> {
    let dir = mdict_dir().join(subdir);
    let dict = match opendict::open(dir) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    dict.search_prefix(prefix, limit)
}

/// Helper: open StarDict, look up a word, return decoded result text.
fn stardict_lookup(subdir: &str, word: &str) -> Option<String> {
    let dir = stardict_dir().join(subdir);
    let dict = opendict::open(dir).ok()?;
    let entries = dict.lookup(word).ok()??;
    let text = entries
        .iter()
        .map(|e| String::from_utf8_lossy(&e.data).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    Some(text)
}

/// Helper: open StarDict, do prefix search.
fn stardict_prefix(subdir: &str, prefix: &str, limit: usize) -> Vec<String> {
    let dir = stardict_dir().join(subdir);
    let dict = match opendict::open(dir) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    dict.search_prefix(prefix, limit)
}

// ── Chinese-English (MDict: 新世纪汉英大词典) ──────────────────────

#[test]
#[ignore]
fn mdict_chinese_english_lookup() {
    let text = mdict_lookup("新世纪汉英大", "柿蒂")
        .expect("should find 柿蒂 in Chinese-English dict");
    assert!(text.contains("柿蒂"), "result should contain the headword 柿蒂");
    assert!(text.contains("class="), "result should be HTML");
}

#[test]
#[ignore]
fn mdict_chinese_english_link_redirect() {
    // Some entries are @@@LINK= redirects
    let text = mdict_lookup("新世纪汉英大", "柿子椒")
        .expect("should find 柿子椒");
    assert!(text.contains("@@@LINK="), "柿子椒 should be a LINK redirect");
}

#[test]
#[ignore]
fn mdict_chinese_english_prefix_search() {
    let results = mdict_prefix("新世纪汉英大", "柿", 10);
    assert!(!results.is_empty(), "prefix '柿' should return results");
    assert!(
        results.iter().all(|w| w.starts_with('柿')),
        "all results should start with 柿: {:?}",
        results
    );
}

// ── Oxford English Dictionary (MDict) ──────────────────────────────

#[test]
#[ignore]
fn mdict_oxford_english_lookup() {
    let text = mdict_lookup("oxford_dict", "apple")
        .expect("should find 'apple' in OED");
    assert!(text.contains("OED"), "result should reference OED stylesheet");
}

#[test]
#[ignore]
fn mdict_oxford_english_prefix_search() {
    let results = mdict_prefix("oxford_dict", "me", 5);
    assert!(results.len() >= 3, "prefix 'me' should return multiple results");
    assert!(
        results.iter().all(|w| w.to_lowercase().starts_with("me")),
        "all results should start with 'me': {:?}",
        results
    );
}

// ── Italian (MDict: Dizionario delle collocazioni) ─────────────────

#[test]
#[ignore]
fn mdict_italian_lookup() {
    let text = mdict_lookup("italiano", "lago")
        .expect("should find 'lago' in Italian dict");
    assert!(text.contains("dizionario.css"), "result should be HTML with CSS");
}

#[test]
#[ignore]
fn mdict_italian_prefix_search() {
    let results = mdict_prefix("italiano", "la", 5);
    assert!(!results.is_empty(), "prefix 'la' should return results");
    assert!(
        results.iter().all(|w| w.to_lowercase().starts_with("la")),
        "all results should start with 'la': {:?}",
        results
    );
}

// ── Japanese (MDict: 日本人名地名) ─────────────────────────────────

#[test]
#[ignore]
fn mdict_japanese_lookup() {
    // MDX is in a nested dict/ subdirectory
    let text = mdict_lookup("日本人名地名/dict", "ゆうかわ")
        .expect("should find ゆうかわ in Japanese names dict");
    assert!(text.contains("ゆうかわ"), "result should contain the hiragana headword");
    assert!(text.contains("夕川"), "result should contain the kanji 夕川");
}

#[test]
#[ignore]
fn mdict_japanese_prefix_search() {
    let results = mdict_prefix("日本人名地名/dict", "ゆう", 5);
    assert!(results.len() >= 3, "prefix 'ゆう' should return multiple results");
    assert!(
        results.iter().all(|w| w.starts_with("ゆう")),
        "all results should start with ゆう: {:?}",
        results
    );
}

// ── Modern Chinese Dictionary (StarDict: 现代汉语词典) ─────────────

#[test]
#[ignore]
fn stardict_chinese_lookup() {
    let text = stardict_lookup("stardict-xiandaihanyucidian_fix-2.4.2", "查验")
        .expect("should find 查验 in Modern Chinese dict");
    assert!(text.contains("cháyàn"), "result should contain pinyin cháyàn");
    assert!(text.contains("检查"), "result should contain definition with 检查");
}

#[test]
#[ignore]
fn stardict_chinese_prefix_search() {
    let results = stardict_prefix("stardict-xiandaihanyucidian_fix-2.4.2", "查", 10);
    assert!(!results.is_empty(), "prefix '查' should return results");
    assert!(
        results.iter().all(|w| w.starts_with('查')),
        "all results should start with 查: {:?}",
        results
    );
}

// ── Korean-English (StarDict) ──────────────────────────────────────

#[test]
#[ignore]
fn stardict_korean_english_lookup() {
    let text = stardict_lookup("stardict-KoreanEnglishDic-2.4.2", "숙소")
        .expect("should find 숙소 in Korean-English dict");
    assert!(text.contains("宿所"), "result should contain hanja 宿所");
    assert!(
        text.contains("lodgings") || text.contains("address"),
        "result should contain English meaning"
    );
}

#[test]
#[ignore]
fn stardict_korean_english_prefix_search() {
    let results = stardict_prefix("stardict-KoreanEnglishDic-2.4.2", "숙", 5);
    assert!(!results.is_empty(), "prefix '숙' should return results");
    assert!(
        results.iter().all(|w| w.starts_with('숙')),
        "all results should start with 숙: {:?}",
        results
    );
}

// ── Spanish-English (StarDict: Wiktionary) ─────────────────────────

#[test]
#[ignore]
fn stardict_spanish_english_lookup() {
    let text = stardict_lookup("stardict-spanish-english-wiktionary", "fracaso")
        .expect("should find 'fracaso' in Spanish-English dict");
    assert!(
        text.contains("failure") || text.contains("flop") || text.contains("disaster"),
        "result should contain an English translation of 'fracaso': {}",
        &text[..text.len().min(200)]
    );
}

#[test]
#[ignore]
fn stardict_spanish_english_prefix_search() {
    let results = stardict_prefix("stardict-spanish-english-wiktionary", "fr", 5);
    assert!(results.len() >= 3, "prefix 'fr' should return multiple results");
    assert!(
        results.iter().all(|w| w.to_lowercase().starts_with("fr")),
        "all results should start with 'fr': {:?}",
        results
    );
}

// ── Langdao Chinese-English (StarDict: 朗道汉英字典) ───────────────

#[test]
#[ignore]
fn stardict_langdao_chinese_english_lookup() {
    let text = stardict_lookup("stardict-langdao-ce-gb-2.4.2", "龟鳖")
        .expect("should find 龟鳖 in Langdao dict");
    assert!(text.contains("terrapin"), "result should contain English 'terrapin'");
}

#[test]
#[ignore]
fn stardict_langdao_chinese_english_prefix_search() {
    let results = stardict_prefix("stardict-langdao-ce-gb-2.4.2", "桥形", 5);
    assert!(results.len() >= 3, "prefix '桥形' should return multiple results");
    assert!(
        results.iter().all(|w| w.starts_with("桥形")),
        "all results should start with 桥形: {:?}",
        results
    );
}
