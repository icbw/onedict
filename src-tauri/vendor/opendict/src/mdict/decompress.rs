use crate::error::Error;
use flate2::read::ZlibDecoder;
use std::io::Read;

use super::header::MdictVersion;

/// Decompress an MDict data block with checksum verification.
/// Format: 4 bytes info + 4 bytes checksum + data
///
/// The info field (little-endian u32) encodes:
///   bits 0-3:  compression method (0=none, 1=LZO, 2=zlib)
///   bits 4-7:  per-block encryption method (0=none, 1=fast_decrypt, 2=salsa20)
///   bits 8-15: encryption size (number of bytes to decrypt)
///
/// Checksum verification order depends on version:
///   v2: adler32 of decompressed data
///   v3: adler32 of decrypted (pre-decompression) data
pub fn decompress_block(
    block: &[u8],
    version: MdictVersion,
    global_key: Option<&[u8; 16]>,
    decomp_size: usize,
) -> crate::Result<Vec<u8>> {
    if block.len() < 8 {
        return Err(Error::InvalidFormat("block too small".into()));
    }

    let info = u32::from_le_bytes([block[0], block[1], block[2], block[3]]);
    let compression_method = info & 0xf;
    let encryption_method = (info >> 4) & 0xf;
    let encryption_size = ((info >> 8) & 0xff) as usize;

    let stored_checksum = u32::from_be_bytes([block[4], block[5], block[6], block[7]]);
    let mut data = block[8..].to_vec();

    // Handle per-block encryption
    if encryption_method == 1 {
        let key = match global_key {
            Some(k) => *k,
            None => super::ripemd128::ripemd128(&block[4..8]),
        };
        let n = if encryption_size > 0 {
            encryption_size.min(data.len())
        } else {
            data.len()
        };
        let decrypted = super::decrypt::fast_decrypt(&data[..n], &key);
        data[..n].copy_from_slice(&decrypted);
    } else if encryption_method != 0 {
        return Err(Error::Unsupported(format!(
            "unsupported per-block encryption method: {}",
            encryption_method
        )));
    }

    // v3+: verify checksum on decrypted data (before decompression)
    if version == MdictVersion::V3 {
        let computed = adler2::adler32_slice(&data);
        if computed != stored_checksum {
            return Err(Error::InvalidFormat(format!(
                "adler32 mismatch (v3 decrypted): stored={:#010x} computed={:#010x}",
                stored_checksum, computed
            )));
        }
    }

    let decompressed = match compression_method {
        0 => data,
        1 => {
            let mut buf = vec![0u8; decomp_size];
            lzo1x::decompress(&data, &mut buf).map_err(|e| {
                Error::InvalidFormat(format!("LZO decompression failed: {:?}", e))
            })?;
            buf
        }
        2 => {
            let mut decoder = ZlibDecoder::new(&data[..]);
            let mut buf = Vec::new();
            decoder.read_to_end(&mut buf)?;
            buf
        }
        _ => return Err(Error::Unsupported(format!(
            "unknown compression type: {}", compression_method
        ))),
    };

    // v2: verify checksum on decompressed data
    if version == MdictVersion::V2 {
        let computed = adler2::adler32_slice(&decompressed);
        if computed != stored_checksum {
            return Err(Error::InvalidFormat(format!(
                "adler32 mismatch (v2 decompressed): stored={:#010x} computed={:#010x}",
                stored_checksum, computed
            )));
        }
    }

    Ok(decompressed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic MDict block: 4-byte info (LE) + 4-byte checksum (BE) + data.
    fn make_block(compression: u8, data: &[u8], checksum: u32) -> Vec<u8> {
        let mut block = vec![compression, 0x00, 0x00, 0x00];
        block.extend_from_slice(&checksum.to_be_bytes());
        block.extend_from_slice(data);
        block
    }

    #[test]
    fn block_too_small_is_invalid_format() {
        let result = decompress_block(&[0; 4], MdictVersion::V2, None, 0);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn lzo_round_trip() {
        let original = b"hello world, this is a test of LZO compression in MDict blocks!";
        let compressed = lzo1x::compress(original, lzo1x::CompressLevel::default());
        let checksum = adler2::adler32_slice(original);
        let block = make_block(0x01, &compressed, checksum);

        let result = decompress_block(&block, MdictVersion::V2, None, original.len()).unwrap();
        assert_eq!(result, original);
    }

    #[test]
    fn lzo_bad_data_is_invalid_format() {
        let block = make_block(0x01, &[0xFF, 0xFE, 0xFD], 0);
        let result = decompress_block(&block, MdictVersion::V2, None, 100);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn unknown_encryption_is_unsupported() {
        // info field: compression=0, encryption=2 (salsa20)
        let mut block = vec![0x20, 0x00, 0x00, 0x00]; // info LE: enc=2
        block.extend_from_slice(&[0x00; 4]); // checksum
        let result = decompress_block(&block, MdictVersion::V2, None, 0);
        assert!(matches!(result, Err(crate::error::Error::Unsupported(_))));
    }

    #[test]
    fn bad_checksum_is_invalid_format() {
        // Uncompressed block (compression=0, encryption=0) with wrong checksum
        let block = make_block(0x00, b"hello", 0xFFFFFFFF);
        let result = decompress_block(&block, MdictVersion::V2, None, 5);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }
}
