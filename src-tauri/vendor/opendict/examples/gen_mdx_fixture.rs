/// Generate a minimal .mdx fixture for testing.
///
/// Creates tests/fixtures/test.mdx with 3 entries:
///   foo   → "bar"
///   hello → "<b>hello</b> greeting"
///   test  → "test data here"
///
/// Format: MDict v2.0, UTF-8, zlib compression, no encryption.
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

fn main() {
    let entries: Vec<(&str, &str)> = vec![
        ("foo", "bar"),
        ("hello", "<b>hello</b> greeting"),
        ("test", "test data here"),
    ];

    // ── Record data (decompressed) ──────────────────────────────
    // Each value is null-terminated; offsets point into this blob.
    let mut record_data = Vec::new();
    let mut record_offsets = Vec::new();
    for (_, value) in &entries {
        record_offsets.push(record_data.len() as u64);
        record_data.extend_from_slice(value.as_bytes());
        record_data.push(0); // null terminator
    }

    // ── Key block (decompressed) ────────────────────────────────
    // Each entry: 8-byte record offset (BE) + null-terminated keyword
    let mut key_block_raw = Vec::new();
    for (i, (keyword, _)) in entries.iter().enumerate() {
        key_block_raw.extend_from_slice(&record_offsets[i].to_be_bytes());
        key_block_raw.extend_from_slice(keyword.as_bytes());
        key_block_raw.push(0);
    }
    let key_block_wrapped = wrap_block_zlib(&key_block_raw);

    // ── Key index (decompressed) ────────────────────────────────
    // For 1 block: num_entries + first_word + last_word + sizes
    let first_word = entries.first().unwrap().0;
    let last_word = entries.last().unwrap().0;

    let mut key_index_raw = Vec::new();
    // num_entries in this block
    key_index_raw.extend_from_slice(&(entries.len() as u64).to_be_bytes());
    // first word: 2-byte char count (BE) + word bytes + null
    key_index_raw.extend_from_slice(&(first_word.len() as u16).to_be_bytes());
    key_index_raw.extend_from_slice(first_word.as_bytes());
    key_index_raw.push(0);
    // last word: 2-byte char count (BE) + word bytes + null
    key_index_raw.extend_from_slice(&(last_word.len() as u16).to_be_bytes());
    key_index_raw.extend_from_slice(last_word.as_bytes());
    key_index_raw.push(0);
    // compressed and decompressed sizes of the key block
    key_index_raw.extend_from_slice(&(key_block_wrapped.len() as u64).to_be_bytes());
    key_index_raw.extend_from_slice(&(key_block_raw.len() as u64).to_be_bytes());

    let key_index_wrapped = wrap_block_zlib(&key_index_raw);

    // ── Keyword section header (44 bytes) ───────────────────────
    let mut kw_header = Vec::new();
    kw_header.extend_from_slice(&1u64.to_be_bytes()); // num_blocks
    kw_header.extend_from_slice(&(entries.len() as u64).to_be_bytes()); // num_entries
    kw_header.extend_from_slice(&(key_index_raw.len() as u64).to_be_bytes()); // key_index_decomp_len
    kw_header.extend_from_slice(&(key_index_wrapped.len() as u64).to_be_bytes()); // key_index_comp_len
    kw_header.extend_from_slice(&(key_block_wrapped.len() as u64).to_be_bytes()); // key_blocks_len
    let kw_checksum = adler2::adler32_slice(&kw_header);
    kw_header.extend_from_slice(&kw_checksum.to_be_bytes());

    // ── Record block (compressed) ───────────────────────────────
    let record_block_wrapped = wrap_block_zlib(&record_data);

    // ── Record section header (32 bytes) + index ────────────────
    let mut rec_header = Vec::new();
    rec_header.extend_from_slice(&1u64.to_be_bytes()); // num_blocks
    rec_header.extend_from_slice(&(entries.len() as u64).to_be_bytes()); // num_entries
    rec_header.extend_from_slice(&16u64.to_be_bytes()); // index_len (1 × 16)
    rec_header.extend_from_slice(&(record_block_wrapped.len() as u64).to_be_bytes()); // blocks_len

    // Block size pair
    let mut rec_index = Vec::new();
    rec_index.extend_from_slice(&(record_block_wrapped.len() as u64).to_be_bytes()); // comp_size
    rec_index.extend_from_slice(&(record_data.len() as u64).to_be_bytes()); // decomp_size

    // ── File header ─────────────────────────────────────────────
    let xml = r#"<Dict GeneratedByEngineVersion="2.0" Encoding="UTF-8" Format="Html" Title="Test Dict">"#;
    let xml_utf16: Vec<u8> = xml
        .encode_utf16()
        .flat_map(|c| c.to_le_bytes())
        .collect();

    // ── Assemble ────────────────────────────────────────────────
    let mut file_data = Vec::new();
    // Header: length + UTF-16LE XML + checksum
    file_data.extend_from_slice(&(xml_utf16.len() as u32).to_be_bytes());
    file_data.extend_from_slice(&xml_utf16);
    let hdr_checksum = adler2::adler32_slice(&xml_utf16);
    file_data.extend_from_slice(&hdr_checksum.to_be_bytes());
    // Keyword section
    file_data.extend_from_slice(&kw_header);
    file_data.extend_from_slice(&key_index_wrapped);
    file_data.extend_from_slice(&key_block_wrapped);
    // Record section
    file_data.extend_from_slice(&rec_header);
    file_data.extend_from_slice(&rec_index);
    file_data.extend_from_slice(&record_block_wrapped);

    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("test.mdx");
    std::fs::write(&path, &file_data).unwrap();
    println!("wrote {} bytes to {}", file_data.len(), path.display());
}

/// Compress data with zlib, then wrap in MDict block format.
/// Block format: info(4 LE) + checksum(4 BE) + compressed_data
/// info = 0x02 (zlib compression, no encryption)
/// checksum = adler32 of decompressed data (v2 format)
fn wrap_block_zlib(decompressed: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(decompressed).unwrap();
    let compressed = encoder.finish().unwrap();

    let mut block = Vec::new();
    block.extend_from_slice(&2u32.to_le_bytes()); // compression=zlib
    let checksum = adler2::adler32_slice(decompressed);
    block.extend_from_slice(&checksum.to_be_bytes());
    block.extend_from_slice(&compressed);
    block
}
