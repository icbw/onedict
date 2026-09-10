use encoding_rs::Encoding;

/// Decodes bytes from the source encoding to a UTF-8 String.
/// Uses lossy conversion: invalid sequences become U+FFFD replacement
/// characters. This is intentional -- showing a definition with a few
/// bad characters is better than failing the entire lookup.
pub fn decode_str(bytes: &[u8], encoding_name: &str) -> String {
    match encoding_name.to_uppercase().as_str() {
        "UTF-8" | "UTF8" => String::from_utf8_lossy(bytes).into_owned(),
        "UTF-16" | "UTF-16LE" | "UTF16" => {
            let u16s: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16s)
        }
        label => {
            if let Some(enc) = Encoding::for_label(label.as_bytes()) {
                let (decoded, _) = enc.decode_without_bom_handling(bytes);
                decoded.into_owned()
            } else {
                // Unknown encoding — fallback to lossy UTF-8
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
    }
}

/// Returns the null-terminator width for the encoding: 2 for UTF-16, 1 for everything else.
pub fn null_width(encoding_name: &str) -> usize {
    let upper = encoding_name.to_uppercase();
    if upper == "UTF-16" || upper == "UTF-16LE" || upper == "UTF16" {
        2
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── decode_str ──────────────────────────────────────────────

    #[test]
    fn utf8_passthrough() {
        assert_eq!(decode_str(b"hello", "UTF-8"), "hello");
    }

    #[test]
    fn utf8_label_variants() {
        assert_eq!(decode_str(b"abc", "utf-8"), "abc");
        assert_eq!(decode_str(b"abc", "UTF8"), "abc");
        assert_eq!(decode_str(b"abc", "utf8"), "abc");
    }

    #[test]
    fn utf16le_decode() {
        // "hi" in UTF-16LE: h=0x0068, i=0x0069
        let bytes = [0x68, 0x00, 0x69, 0x00];
        assert_eq!(decode_str(&bytes, "UTF-16LE"), "hi");
    }

    #[test]
    fn utf16le_label_variants() {
        let bytes = [0x41, 0x00]; // "A"
        assert_eq!(decode_str(&bytes, "UTF-16"), "A");
        assert_eq!(decode_str(&bytes, "utf-16le"), "A");
        assert_eq!(decode_str(&bytes, "UTF16"), "A");
    }

    #[test]
    fn utf16le_cjk() {
        // U+4F60 (你) in UTF-16LE: 0x60 0x4F
        let bytes = [0x60, 0x4F];
        assert_eq!(decode_str(&bytes, "UTF-16LE"), "你");
    }

    #[test]
    fn gbk_decode() {
        // "你" in GBK: 0xC4 0xE3
        let bytes = [0xC4, 0xE3];
        assert_eq!(decode_str(&bytes, "GBK"), "你");
    }

    #[test]
    fn gb18030_decode() {
        // "你" in GB18030: same as GBK for BMP characters
        let bytes = [0xC4, 0xE3];
        assert_eq!(decode_str(&bytes, "GB18030"), "你");
    }

    #[test]
    fn big5_decode() {
        // "A" is just 0x41 in Big5 (ASCII range)
        assert_eq!(decode_str(b"ABC", "Big5"), "ABC");
    }

    #[test]
    fn unknown_encoding_falls_back_to_utf8() {
        assert_eq!(decode_str(b"test", "TOTALLY-FAKE"), "test");
    }

    #[test]
    fn empty_input() {
        assert_eq!(decode_str(b"", "UTF-8"), "");
        assert_eq!(decode_str(b"", "UTF-16LE"), "");
        assert_eq!(decode_str(b"", "GBK"), "");
    }

    // ── null_width ──────────────────────────────────────────────

    #[test]
    fn null_width_utf16_variants() {
        assert_eq!(null_width("UTF-16"), 2);
        assert_eq!(null_width("UTF-16LE"), 2);
        assert_eq!(null_width("utf-16"), 2);
        assert_eq!(null_width("utf-16le"), 2);
        assert_eq!(null_width("UTF16"), 2);
    }

    #[test]
    fn null_width_single_byte_encodings() {
        assert_eq!(null_width("UTF-8"), 1);
        assert_eq!(null_width("GBK"), 1);
        assert_eq!(null_width("GB18030"), 1);
        assert_eq!(null_width("Big5"), 1);
        assert_eq!(null_width(""), 1);
    }
}
