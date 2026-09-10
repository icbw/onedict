# opendict-rs

A Rust library for reading [StarDict](https://github.com/huzheng001/stardict-3/blob/master/dict/doc/StarDictFileFormat) and [MDict](https://bitbucket.org/xwang/mdict-analysis) dictionary files through a unified API.

## Quick start

```rust
use opendict::{open, Dictionary};

// Auto-detects format from directory contents
let dict = open("path/to/dictionary-dir")?;

println!("{}", dict.info().name);            // dictionary title
println!("{}", dict.word_count());           // number of entries

if let Some(entries) = dict.lookup("hello")? {
    for entry in entries {
        println!("{}", String::from_utf8_lossy(&entry.data));
    }
}

let matches = dict.search_prefix("hel", 10); // prefix search
let words = dict.word_list();                 // all headwords
```

### Format-specific APIs

```rust
use opendict::stardict::StarDictDictionary;
use opendict::mdict::MdictDictionary;

// StarDict — synonyms
let sd = StarDictDictionary::open_dir("path/to/stardict-dir".as_ref())?;
if let Some(entries) = sd.lookup_synonym("hi")? {
    // resolves synonym → target word → entries
}

// MDict — resource files (.mdd)
let md = MdictDictionary::open("path/to/mdict-dir".as_ref())?;
let css = md.lookup_resource("\\style.css");  // CSS, images, fonts
```

## Format support

### StarDict

| Feature | Status |
|---|---|
| `.ifo` metadata (v2.4.2, v3.0.0) | Supported |
| `.idx` binary index (32-bit and 64-bit offsets) | Supported |
| `.dict` data (all type identifiers, `sametypesequence`) | Supported |
| `.syn` synonym files | Supported |
| `.idx.gz` and `.dict.dz` compressed files | Supported |
| `stardict_strcmp` sort order | Supported |
| Tree dictionaries (`.tdx`) | Not supported |
| Resource storage (`res.rifo`/`ridx`/`rdic`) | Not supported |

### MDict

| Feature | Status |
|---|---|
| v2.0 and v3.0 formats | Supported |
| Keyword index encryption (RIPEMD-128 for v2, xxhash64 for v3) | Supported |
| Per-block nibble-swap XOR decryption | Supported |
| zlib and LZO compression | Supported |
| Encodings: UTF-8, UTF-16LE, GBK/GB2312/GB18030, Big5 via `encoding_rs` | Supported |
| Adler32 checksum verification | Supported |
| `.mdd` resource files (CSS, images, fonts) | Supported |
| v1.2 format | Not supported |
| Keyword header encryption (Salsa20) | Not supported |
| StyleSheet / Compact mode | Not supported |

### Both formats

- Memory-mapped I/O for dictionary data
- Binary search with prefix search
- Single-entry block cache to avoid redundant decompression (MDict)
- Optional disk caching of `.dict.dz`/`.idx.gz` decompression (StarDict)

## Bindings

### Node.js

Native addon via [napi-rs](https://napi.rs). Auto-detects dictionary format.

```javascript
import { Dictionary } from '@opendict-rs/node'

const dict = new Dictionary('/path/to/dictionary-dir')

console.log(dict.info.name)
console.log(dict.wordCount())

const entries = dict.lookup('hello')
if (entries) {
  console.log(entries[0].data)
}

const matches = dict.searchPrefix('hel', 10)
```

Build from source:

```bash
cd node && npm install && npm run build
```

### Expo (React Native)

Native module via [uniffi](https://mozilla.github.io/uniffi-rs/) + [Expo Modules](https://docs.expo.dev/modules/overview/). Supports iOS and Android.

```typescript
import { Dictionary } from '@opendict-rs/expo'

const dict = new Dictionary('/path/to/dictionary-dir')

console.log(dict.info.name)
console.log(dict.wordCount())

const entries = dict.lookup('hello')
const matches = dict.searchPrefix('hel', 10)

dict.close() // free native resources when done
```

Requires cross-compiling the Rust library for your target platform. See [examples/expo-test](examples/expo-test) for a complete example app.

## Performance

Release mode, benchmarked against real dictionaries.

### Load time

| Dictionary | Format | Words | Load |
|---|---|---|---|
| Langdao CN-EN | StarDict | 405k | 10 ms |
| Modern Chinese | StarDict | 58k | 1 ms |
| Korean-English | StarDict | 50k | 2 ms |
| Spanish-English | StarDict | 99k | 21 ms |
| CN-EN (xinshiji) | MDict | 137k | 34 ms |
| Oxford OED | MDict | 277k | 64 ms |
| JP Names | MDict | 67k | 22 ms |

### Lookup (sequential, all words)

| Dictionary | Format | ns/word |
|---|---|---|
| Langdao CN-EN | StarDict | 381 |
| Modern Chinese | StarDict | 437 |
| Korean-English | StarDict | 955 |
| Spanish-English | StarDict | 436 |
| CN-EN (xinshiji) | MDict | 1,479 |
| Oxford OED | MDict | 8,649 |
| JP Names | MDict | 919 |

Prefix search runs in 1-4 us across all dictionaries.

MDict mmap vs Vec on the Oxford OED (277k words, ~230 MB `.mdx`): RSS dropped from 234 MB to 24 MB (-90%), load time from 101 ms to 64 ms (-37%).

## Tests

```bash
cargo test                      # unit + integration tests
cargo test -- --ignored         # + real dictionary tests (requires files in tests/dicts/)
cargo bench                     # criterion benchmarks (set OPENDICT_BENCH_DIR)
```

## Dependencies

```toml
flate2 = "1"          # zlib decompression
memmap2 = "0.9"       # memory-mapped I/O
encoding_rs = "0.8"   # character encoding (GBK, Big5, etc.)
adler2 = "2"          # adler32 checksums
lzo1x = "0.2"         # LZO decompression
xxhash-rust = "0.8"   # v3 key derivation
log = "0.4"           # optional warning logs
```

## Contributing

Contributions are very welcome — bug fixes, performance improvements,
docs, tests, additional fixtures, all of it.

The biggest gap is **support for more dictionary formats** (Lingoes,
DSL, Babylon BGL, XDXF, plain text). I'd like opendict-rs to grow into
a genuinely format-agnostic reader, but I'm unlikely to get to those any
time soon — if you need one, opening a PR is the fastest way to make it
happen. The existing StarDict and MDict modules under `src/` are good
templates for how a new format slots in behind the `Dictionary` trait.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo layout, build steps
for each binding (Rust core, Node, Expo), and the rule for keeping the
bindings thin.

## Acknowledgements

The MDict implementation was built with reference to:

- [mdict-analysis](https://bitbucket.org/xwang/mdict-analysis/src/master/) — Xiaoqiang Wang's Python analysis of the MDict format
- [mdict](https://github.com/jeka-kiselyov/mdict) — Jeka Kiselyov's JavaScript MDict reader
- [writemdict](https://github.com/zhansliu/writemdict) — Zhanshi Liu's Python MDict writer (useful for understanding the binary format)

## License

MIT
