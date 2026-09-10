use crate::error::Error;
use crate::mdict::header::MdictHeader;
use crate::mdict::decompress;

/// Parse keyword section. Returns (keywords, record_offsets, end_position).
pub fn parse_keywords(
    data: &[u8],
    header: &MdictHeader,
    global_key: Option<&[u8; 16]>,
) -> crate::Result<(Vec<String>, Vec<u64>, usize)> {
    let mut pos = header.keyword_sect_start;

    if header.encrypted & 1 != 0 {
        return Err(Error::Unsupported(
            "encrypted keyword header not yet supported".into(),
        ));
    }

    // Keyword section header (v2): 5 x 8 bytes + 4 byte checksum = 44 bytes
    if pos + 44 > data.len() {
        return Err(Error::InvalidFormat(
            "keyword section header truncated".into(),
        ));
    }

    let header_start = pos;
    let num_blocks = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;
    let _num_entries = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;
    let key_index_decomp_len = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;
    let key_index_comp_len = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;
    let key_blocks_len = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;
    let stored_checksum = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap());
    pos += 4;

    // Verify keyword section header checksum (adler32 of the preceding 40 bytes)
    let computed = adler2::adler32_slice(&data[header_start..header_start + 40]);
    if computed != stored_checksum {
        return Err(Error::InvalidFormat(format!(
            "keyword section header checksum mismatch: stored={:#010x} computed={:#010x}",
            stored_checksum, computed
        )));
    }

    let key_index_end = pos + key_index_comp_len as usize;

    // Keyword index (compressed) — decrypt if Encrypted bit 2 is set
    let key_index_block = if header.encrypted & 2 != 0 {
        let block = &data[pos..key_index_end];
        if block.len() < 8 {
            return Err(Error::InvalidFormat(
                "keyword index block too small to decrypt".into(),
            ));
        }
        let key = match global_key {
            Some(k) => *k,
            None => {
                // v2 key derivation: ripemd128(checksum + magic)
                let mut key_input = [0u8; 8];
                key_input[..4].copy_from_slice(&block[4..8]);
                key_input[4..].copy_from_slice(&[0x95, 0x36, 0x00, 0x00]);
                super::ripemd128::ripemd128(&key_input)
            }
        };

        // Decrypt bytes 8+ (after comp_type and checksum), keep first 8 bytes unchanged
        let mut decrypted = Vec::with_capacity(block.len());
        decrypted.extend_from_slice(&block[..8]);
        decrypted.extend_from_slice(&super::decrypt::fast_decrypt(&block[8..], &key));
        decrypted
    } else {
        data[pos..key_index_end].to_vec()
    };

    // Parse the key index to get block sizes
    let key_index_data = decompress::decompress_block(
        &key_index_block, header.version, global_key, key_index_decomp_len as usize,
    )?;
    let block_infos = parse_key_index(&key_index_data, num_blocks as usize, header)?;

    pos = key_index_end;

    // Parse keyword blocks
    let mut keywords = Vec::new();
    let mut record_offsets = Vec::new();

    for (comp_size, decomp_size) in &block_infos {
        let block_end = pos + *comp_size as usize;
        if block_end > data.len() {
            return Err(Error::InvalidFormat(format!(
                "keyword block extends past end of file (offset {}+{}, file size {})",
                pos, comp_size, data.len()
            )));
        }
        let block_data = decompress::decompress_block(
            &data[pos..block_end], header.version, global_key, *decomp_size as usize,
        )?;
        parse_key_block(&block_data, header, &mut keywords, &mut record_offsets)?;
        pos = block_end;
    }

    debug_assert_eq!(pos, key_index_end + key_blocks_len as usize);

    Ok((keywords, record_offsets, pos))
}

/// Parse the decompressed key index to extract (comp_size, decomp_size) per block.
fn parse_key_index(
    data: &[u8],
    num_blocks: usize,
    header: &MdictHeader,
) -> crate::Result<Vec<(u64, u64)>> {
    let mut pos = 0;
    let mut blocks = Vec::with_capacity(num_blocks);
    let encoding_unit = super::encoding::null_width(&header.encoding);

    for blk_i in 0..num_blocks {
        if pos + 8 > data.len() {
            return Err(Error::InvalidFormat(format!("key index truncated at block {}/{}, pos={}, data.len={}", blk_i, num_blocks, pos, data.len())));
        }
        // num_entries for this block
        let _num_entries = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
        pos += 8;

        if pos + 2 > data.len() {
            return Err(Error::InvalidFormat(format!("key index: first_len truncated at block {}, pos={}, data.len={}", blk_i, pos, data.len())));
        }
        // first_word: 2-byte length + word bytes + null terminator
        let first_len = u16::from_be_bytes(data[pos..pos + 2].try_into().unwrap()) as usize;
        pos += 2;
        let first_bytes = first_len * encoding_unit + encoding_unit; // include null
        if pos + first_bytes > data.len() {
            return Err(Error::InvalidFormat(format!("key index: first_word overflow at block {}, first_len={}, encoding_unit={}, pos={}, need={}, data.len={}, encoding={}",
                blk_i, first_len, encoding_unit, pos, pos + first_bytes, data.len(), header.encoding)));
        }
        pos += first_bytes;

        if pos + 2 > data.len() {
            return Err(Error::InvalidFormat(format!("key index: last_len truncated at block {}, pos={}, data.len={}", blk_i, pos, data.len())));
        }
        // last_word: 2-byte length + word bytes + null terminator
        let last_len = u16::from_be_bytes(data[pos..pos + 2].try_into().unwrap()) as usize;
        pos += 2;
        let last_bytes = last_len * encoding_unit + encoding_unit;
        if pos + last_bytes > data.len() {
            return Err(Error::InvalidFormat(format!("key index: last_word overflow at block {}, last_len={}, encoding_unit={}, pos={}, need={}, data.len={}, encoding={}",
                blk_i, last_len, encoding_unit, pos, pos + last_bytes, data.len(), header.encoding)));
        }
        pos += last_bytes;

        // comp_size, decomp_size
        if pos + 16 > data.len() {
            return Err(Error::InvalidFormat(format!("key index: block sizes truncated at block {}, pos={}, data.len={}", blk_i, pos, data.len())));
        }
        let comp_size = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
        pos += 8;
        let decomp_size = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
        pos += 8;

        blocks.push((comp_size, decomp_size));
    }

    Ok(blocks)
}

/// Parse a decompressed key block into keywords and record offsets.
fn parse_key_block(
    data: &[u8],
    header: &MdictHeader,
    keywords: &mut Vec<String>,
    record_offsets: &mut Vec<u64>,
) -> crate::Result<()> {
    let mut pos = 0;
    let nw = super::encoding::null_width(&header.encoding);

    while pos < data.len() {
        if pos + 8 > data.len() {
            return Err(Error::InvalidFormat(
                "key block truncated: not enough data for record offset".into(),
            ));
        }

        // Record offset (8 bytes, big-endian)
        let offset = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
        pos += 8;
        record_offsets.push(offset);

        // Null-terminated keyword
        let start = pos;
        if nw == 2 {
            while pos + 1 < data.len() && !(data[pos] == 0 && data[pos + 1] == 0) {
                pos += 2;
            }
        } else {
            while pos < data.len() && data[pos] != 0 {
                pos += 1;
            }
        }
        keywords.push(super::encoding::decode_str(&data[start..pos], &header.encoding));
        pos += nw; // skip null terminator
    }

    Ok(())
}
