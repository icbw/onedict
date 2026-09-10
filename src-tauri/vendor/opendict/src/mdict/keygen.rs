use super::header::MdictVersion;

/// Derive the encryption key for a given MDict file.
/// - v2: no global key (per-block key derived from block checksum)
/// - v3: key derived from UUID via xxhash64
pub fn derive_key(version: MdictVersion, uuid: Option<&[u8]>) -> Option<[u8; 16]> {
    if version == MdictVersion::V3 {
        let uuid = uuid?;
        let mid = uuid.len().div_ceil(2);
        let h1 = xxhash_rust::xxh64::xxh64(&uuid[..mid], 0);
        let h2 = xxhash_rust::xxh64::xxh64(&uuid[mid..], 0);
        let mut key = [0u8; 16];
        key[..8].copy_from_slice(&h1.to_le_bytes());
        key[8..].copy_from_slice(&h2.to_le_bytes());
        Some(key)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_returns_none() {
        assert!(derive_key(MdictVersion::V2, Some(b"anything")).is_none());
        assert!(derive_key(MdictVersion::V2, None).is_none());
    }

    #[test]
    fn v3_no_uuid_returns_none() {
        assert!(derive_key(MdictVersion::V3, None).is_none());
    }

    #[test]
    fn v3_with_uuid_returns_16_byte_key() {
        let key = derive_key(MdictVersion::V3, Some(b"test-uuid")).unwrap();
        assert_eq!(key.len(), 16);
    }

    #[test]
    fn v3_deterministic() {
        let k1 = derive_key(MdictVersion::V3, Some(b"test-uuid")).unwrap();
        let k2 = derive_key(MdictVersion::V3, Some(b"test-uuid")).unwrap();
        assert_eq!(k1, k2);
    }

    #[test]
    fn v3_different_uuids_differ() {
        let k1 = derive_key(MdictVersion::V3, Some(b"uuid-aaa")).unwrap();
        let k2 = derive_key(MdictVersion::V3, Some(b"uuid-bbb")).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn v3_key_matches_xxhash64_split() {
        // UUID "abcdef" (6 bytes) → mid = (6+1)/2 = 3
        // left = b"abc", right = b"def"
        let uuid = b"abcdef";
        let key = derive_key(MdictVersion::V3, Some(uuid)).unwrap();

        let h1 = xxhash_rust::xxh64::xxh64(b"abc", 0);
        let h2 = xxhash_rust::xxh64::xxh64(b"def", 0);
        assert_eq!(&key[..8], &h1.to_le_bytes());
        assert_eq!(&key[8..], &h2.to_le_bytes());
    }

    #[test]
    fn v3_single_byte_uuid() {
        // UUID "x" (1 byte) → mid = 1, left = b"x", right = b""
        let key = derive_key(MdictVersion::V3, Some(b"x")).unwrap();
        let h1 = xxhash_rust::xxh64::xxh64(b"x", 0);
        let h2 = xxhash_rust::xxh64::xxh64(b"", 0);
        assert_eq!(&key[..8], &h1.to_le_bytes());
        assert_eq!(&key[8..], &h2.to_le_bytes());
    }
}
