use crate::error::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MdictVersion {
    V2,
    V3,
}

#[derive(Debug)]
pub struct MdictHeader {
    pub version: MdictVersion,
    pub encoding: String,
    pub format: String,
    pub title: String,
    pub description: String,
    pub encrypted: u8,
    pub key_case_sensitive: bool,
    // Byte offset where keyword section starts
    pub keyword_sect_start: usize,
    // UUID for v3 key derivation (raw bytes of the UUID string)
    pub uuid: Option<Vec<u8>>,
}

pub fn parse_header(data: &[u8]) -> crate::Result<MdictHeader> {
    if data.len() < 8 {
        return Err(Error::InvalidFormat("file too small".into()));
    }

    // Header length (4 bytes, big-endian)
    let header_len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;

    if data.len() < 4 + header_len + 4 {
        return Err(Error::InvalidFormat("file truncated in header".into()));
    }

    // Header string is UTF-16LE
    let header_bytes = &data[4..4 + header_len];
    let header_str = decode_utf16le(header_bytes)?;

    // Skip checksum (4 bytes after header string)
    let keyword_sect_start = 4 + header_len + 4;

    // Parse XML attributes from the header string
    let mut version_raw = 2.0f32;
    let mut encoding = "UTF-8".to_string();
    let mut format = "Html".to_string();
    let mut title = String::new();
    let mut description = String::new();
    let mut encrypted = 0u8;
    let mut key_case_sensitive = false;
    let mut uuid: Option<Vec<u8>> = None;

    for (key, val) in parse_xml_attrs(&header_str) {
        match key.as_str() {
            "GeneratedByEngineVersion" => {
                version_raw = val.parse().map_err(|e| {
                    Error::InvalidFormat(format!(
                        "invalid engine version '{}': {}", val, e
                    ))
                })?;
            }
            "Encoding" => encoding = val,
            "Format" => format = val,
            "Title" => title = val,
            "Description" => description = val,
            "Encrypted" => {
                encrypted = val.parse().map_err(|e| {
                    Error::InvalidFormat(format!(
                        "invalid encrypted field '{}': {}", val, e
                    ))
                })?;
            }
            "KeyCaseSensitive" => {
                key_case_sensitive = val.eq_ignore_ascii_case("yes");
            }
            "UUID" => uuid = Some(val.into_bytes()),
            _ => {}
        }
    }

    let version = if version_raw >= 3.0 {
        MdictVersion::V3
    } else {
        MdictVersion::V2
    };

    Ok(MdictHeader {
        version,
        encoding,
        format,
        title,
        description,
        encrypted,
        key_case_sensitive,
        keyword_sect_start,
        uuid,
    })
}

pub(crate) fn decode_utf16le(data: &[u8]) -> crate::Result<String> {
    if data.len() % 2 != 0 {
        return Err(Error::InvalidFormat("odd byte count for UTF-16LE".into()));
    }
    let u16s: Vec<u16> = data
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&u16s)
        .map_err(|e| Error::InvalidFormat(format!("invalid UTF-16LE: {}", e)))
}

pub(crate) fn parse_xml_attrs(xml: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let mut remaining = xml;
    while let Some(eq_pos) = remaining.find('=') {
        let before_eq = &remaining[..eq_pos];
        let key = before_eq
            .rsplit(|c: char| c.is_whitespace() || c == '<' || c == '/')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();

        remaining = &remaining[eq_pos + 1..];
        let remaining_trimmed = remaining.trim_start();

        if let Some(quote) = remaining_trimmed.chars().next() {
            if quote == '"' || quote == '\'' {
                let after_open = &remaining_trimmed[1..];
                if let Some(close) = after_open.find(quote) {
                    let val = after_open[..close].to_string();
                    if !key.is_empty() {
                        attrs.push((key, val));
                    }
                    remaining = &after_open[close + 1..];
                } else {
                    break;
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }
    attrs
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── decode_utf16le ──────────────────────────────────────────

    #[test]
    fn decodes_ascii() {
        // "Hi" → H=0x0048 i=0x0069
        let bytes = [0x48, 0x00, 0x69, 0x00];
        assert_eq!(decode_utf16le(&bytes).unwrap(), "Hi");
    }

    #[test]
    fn decodes_cjk() {
        // U+4F60 (你) → 0x60 0x4F in LE
        let bytes = [0x60, 0x4F];
        assert_eq!(decode_utf16le(&bytes).unwrap(), "你");
    }

    #[test]
    fn empty_input() {
        assert_eq!(decode_utf16le(&[]).unwrap(), "");
    }

    #[test]
    fn odd_byte_count_is_error() {
        assert!(decode_utf16le(&[0x00]).is_err());
    }

    // ── parse_xml_attrs ─────────────────────────────────────────

    #[test]
    fn single_attr_double_quotes() {
        let attrs = parse_xml_attrs(r#"<Dict Title="Test">"#);
        assert_eq!(attrs, vec![("Title".to_string(), "Test".to_string())]);
    }

    #[test]
    fn single_attr_single_quotes() {
        let attrs = parse_xml_attrs("<Dict Title='Test'>");
        assert_eq!(attrs, vec![("Title".to_string(), "Test".to_string())]);
    }

    #[test]
    fn multiple_attrs() {
        let attrs = parse_xml_attrs(
            r#"<Dict GeneratedByEngineVersion="2.0" Encoding="UTF-8" Format="Html">"#,
        );
        assert_eq!(attrs.len(), 3);
        assert_eq!(attrs[0], ("GeneratedByEngineVersion".to_string(), "2.0".to_string()));
        assert_eq!(attrs[1], ("Encoding".to_string(), "UTF-8".to_string()));
        assert_eq!(attrs[2], ("Format".to_string(), "Html".to_string()));
    }

    #[test]
    fn empty_value() {
        let attrs = parse_xml_attrs(r#"<Dict Title="">"#);
        assert_eq!(attrs, vec![("Title".to_string(), String::new())]);
    }

    #[test]
    fn no_attrs() {
        let attrs = parse_xml_attrs("<Dict>");
        assert!(attrs.is_empty());
    }

    #[test]
    fn empty_string() {
        let attrs = parse_xml_attrs("");
        assert!(attrs.is_empty());
    }

    #[test]
    fn value_with_spaces() {
        let attrs = parse_xml_attrs(r#"<Dict Title="My Cool Dict">"#);
        assert_eq!(attrs, vec![("Title".to_string(), "My Cool Dict".to_string())]);
    }

    #[test]
    fn too_small_is_invalid_format() {
        let result = parse_header(&[0; 4]);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn truncated_header_is_invalid_format() {
        // Claim header is 200 bytes but only provide 20
        let mut data = vec![0; 20];
        data[3] = 200; // header_len = 200, but data is only 20 bytes
        let result = parse_header(&data);
        assert!(matches!(result, Err(crate::error::Error::InvalidFormat(_))));
    }

    #[test]
    fn newlines_between_attrs() {
        let attrs = parse_xml_attrs(
            "<Dict\nTitle=\"Test\"\nEncoding=\"UTF-8\">",
        );
        assert_eq!(attrs.len(), 2);
        assert_eq!(attrs[0].0, "Title");
        assert_eq!(attrs[1].0, "Encoding");
    }
}
