use crate::error::Error;
use crate::mdict::header::MdictHeader;

/// (compressed_offset, compressed_size, decompressed_size) per block.
pub type RecordBlockInfo = (u64, u64, u64);

/// Parse record section index. Returns (block_infos, record_blocks_start_offset).
/// Each block_info is (compressed_offset_in_file, compressed_size, decompressed_size).
pub fn parse_record_index(
    data: &[u8],
    start: usize,
    _header: &MdictHeader,
) -> crate::Result<(Vec<RecordBlockInfo>, u64)> {
    let mut pos = start;

    if pos + 32 > data.len() {
        return Err(Error::InvalidFormat(
            "record section header truncated".into(),
        ));
    }

    let num_blocks = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;
    let _num_entries = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;
    let _index_len = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;
    let _blocks_len = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
    pos += 8;

    // Read block size pairs
    let mut blocks = Vec::with_capacity(num_blocks as usize);
    let mut cumulative_offset = 0u64;

    for _ in 0..num_blocks {
        if pos + 16 > data.len() {
            return Err(Error::InvalidFormat("record index truncated".into()));
        }
        let comp_size = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
        pos += 8;
        let decomp_size = u64::from_be_bytes(data[pos..pos + 8].try_into().unwrap());
        pos += 8;
        blocks.push((cumulative_offset, comp_size, decomp_size));
        cumulative_offset += comp_size;
    }

    let record_blocks_start = pos as u64;

    Ok((blocks, record_blocks_start))
}
