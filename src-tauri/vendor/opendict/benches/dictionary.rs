use std::hint::black_box;
use std::path::PathBuf;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

/// Discover dictionary directories from OPENDICT_BENCH_DIR.
///
/// Each subdirectory should contain one dictionary (StarDict or MDict).
/// Returns an empty vec if the env var is not set.
fn discover_dicts() -> Vec<(String, PathBuf)> {
    let dir = match std::env::var("OPENDICT_BENCH_DIR") {
        Ok(d) => PathBuf::from(d),
        Err(_) => {
            eprintln!(
                "note: set OPENDICT_BENCH_DIR to a directory of dictionaries to benchmark"
            );
            return vec![];
        }
    };

    let mut dicts = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("cannot read OPENDICT_BENCH_DIR") {
        let path = entry.unwrap().path();
        if path.is_dir() {
            let name = path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            dicts.push((name, path));
        }
    }
    dicts.sort_by(|a, b| a.0.cmp(&b.0));
    dicts
}

/// Sample up to `n` evenly-spaced items from a slice.
fn sample<'a>(words: &[&'a str], n: usize) -> Vec<&'a str> {
    if words.is_empty() {
        return vec![];
    }
    if words.len() <= n {
        return words.to_vec();
    }
    (0..n)
        .map(|i| words[i * (words.len() - 1) / (n - 1)])
        .collect()
}

fn bench_open(c: &mut Criterion) {
    let dicts = discover_dicts();
    if dicts.is_empty() {
        return;
    }

    let mut group = c.benchmark_group("open");
    for (name, path) in &dicts {
        group.bench_function(BenchmarkId::from_parameter(name), |b| {
            b.iter(|| opendict::open(black_box(path)).unwrap())
        });
    }
    group.finish();
}

fn bench_lookup_hit(c: &mut Criterion) {
    let dicts = discover_dicts();
    if dicts.is_empty() {
        return;
    }

    let mut group = c.benchmark_group("lookup_hit");
    for (name, path) in &dicts {
        let dict = opendict::open(path).unwrap();
        let words = dict.word_list();
        if words.is_empty() {
            continue;
        }
        let sample = sample(&words, 1000);

        group.bench_function(BenchmarkId::from_parameter(name), |b| {
            b.iter(|| {
                for w in &sample {
                    let _ = black_box(dict.lookup(w));
                }
            })
        });
    }
    group.finish();
}

fn bench_lookup_miss(c: &mut Criterion) {
    let dicts = discover_dicts();
    if dicts.is_empty() {
        return;
    }

    let miss_words: Vec<String> = (0..1000).map(|i| format!("__miss_{i}__")).collect();

    let mut group = c.benchmark_group("lookup_miss");
    for (name, path) in &dicts {
        let dict = opendict::open(path).unwrap();

        group.bench_function(BenchmarkId::from_parameter(name), |b| {
            b.iter(|| {
                for w in &miss_words {
                    let _ = black_box(dict.lookup(w));
                }
            })
        });
    }
    group.finish();
}

fn bench_prefix_search(c: &mut Criterion) {
    let dicts = discover_dicts();
    if dicts.is_empty() {
        return;
    }

    let mut group = c.benchmark_group("prefix_search");
    for (name, path) in &dicts {
        let dict = opendict::open(path).unwrap();
        let words = dict.word_list();
        if words.is_empty() {
            continue;
        }

        let prefixes: Vec<String> = sample(&words, 100)
            .iter()
            .map(|w| w.chars().take(2).collect())
            .collect();

        group.bench_function(BenchmarkId::from_parameter(name), |b| {
            b.iter(|| {
                for p in &prefixes {
                    black_box(dict.search_prefix(p, 20));
                }
            })
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_open,
    bench_lookup_hit,
    bench_lookup_miss,
    bench_prefix_search
);
criterion_main!(benches);
