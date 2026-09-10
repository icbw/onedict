//! Look up a word in any StarDict or MDict dictionary.
//!
//! Usage:
//!     cargo run --example lookup -- /path/to/dict "word"

use std::process;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: {} <dict-path> <word>", args[0]);
        process::exit(1);
    }

    let dict = opendict::open(&args[1]).unwrap_or_else(|e| {
        eprintln!("Failed to open dictionary: {e}");
        process::exit(1);
    });

    let info = dict.info();
    println!("{} ({} words)\n", info.name, dict.word_count());

    match dict.lookup(&args[2]) {
        Ok(Some(entries)) => {
            for e in &entries {
                let text = String::from_utf8_lossy(&e.data);
                let preview: String = text.chars().take(200).collect();
                let ellipsis = if text.chars().count() > 200 { "..." } else { "" };
                println!("  [{}] {}{}", e.type_id, preview.trim(), ellipsis);
            }
        }
        Ok(None) => println!("  (not found)"),
        Err(e) => eprintln!("  Error: {e}"),
    }
}
