//! Show metadata and sample entries from a dictionary.
//!
//! Usage:
//!     cargo run --example show_dict -- /path/to/dict

use std::process;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <dict-path>", args[0]);
        process::exit(1);
    }

    let dict = opendict::open(&args[1]).unwrap_or_else(|e| {
        eprintln!("Failed to open dictionary: {e}");
        process::exit(1);
    });

    let info = dict.info();
    println!("Name:    {}", info.name);
    println!("Words:   {}", dict.word_count());
    if !info.author.is_empty() {
        println!("Author:  {}", info.author);
    }
    if !info.description.is_empty() {
        let desc: String = info.description.chars().take(200).collect();
        println!("Desc:    {}", desc.trim());
    }
    println!();

    let words = dict.word_list();
    let indices = sample_indices(words.len(), 10);

    for i in indices {
        let word = &words[i];
        print!("  [{i}] {word:?}");
        match dict.lookup(word) {
            Ok(Some(entries)) => {
                for e in &entries {
                    let text = String::from_utf8_lossy(&e.data);
                    let preview: String = text.chars().take(120).collect();
                    let ellipsis = if text.chars().count() > 120 { "..." } else { "" };
                    print!("  [{}] {}{}", e.type_id, preview.trim(), ellipsis);
                }
                println!();
            }
            Ok(None) => println!("  NOT FOUND"),
            Err(e) => println!("  ERROR: {e}"),
        }
    }
}

/// Pick up to `n` evenly-spaced indices spanning the full range.
fn sample_indices(len: usize, n: usize) -> Vec<usize> {
    if len == 0 {
        return vec![];
    }
    if len <= n {
        return (0..len).collect();
    }
    (0..n).map(|i| i * (len - 1) / (n - 1)).collect()
}
