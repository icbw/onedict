use crate::error::Error;

use super::StyleSheetEntry;

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
    /// onedict 本地改造：紧凑格式（Compact="Yes"）样式还原表；空 = 无表。
    pub style_sheet: Vec<StyleSheetEntry>,
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
    let mut style_sheet: Vec<StyleSheetEntry> = Vec::new();

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
            "StyleSheet" => style_sheet = parse_style_sheet(&val),
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
        style_sheet,
    })
}

/// onedict 本地改造：解析 StyleSheet 属性值为样式还原表。
///
/// 官方格式（MdxBuilder 文档表述，GoldenDict `mdictparser.cc` 同源实现）：
/// **每 3 行一组——编号 / 前缀 HTML / 后缀 HTML**，编号 1–255。
/// 前缀在 `` `N` `` 标记处展开，后缀由后续标记或词条结尾收束；
/// 后缀留空是合法写法（该标记只插入前缀、不封闭任何东西）。
///
/// 两个易错点：
/// 1. 属性值里的 `&lt;` 等实体必须先反转义，否则展开出的是字面量实体文本；
/// 2. **空行是合法占位**（`KeepEmptyParts` 语义）——丢弃空行会让编号与内容
///    整体错位（js-mdict 即因此解析出错误的风味表），此处的 CRLF 归一化
///    对应 XML 属性值规范化（字面换行归一为 LF）后再按行切分。
fn parse_style_sheet(raw: &str) -> Vec<StyleSheetEntry> {
    let unescaped = xml_unescape(raw);
    let normalized = unescaped.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    let mut sheet = Vec::new();
    let mut i = 0;
    while i + 2 < lines.len() {
        // 组首非数字视为错位/尾部噪声，跳过整组（保持 3 行步进不漂移）
        if let Ok(id) = lines[i].trim().parse::<u32>() {
            sheet.push(StyleSheetEntry {
                id,
                prefix: lines[i + 1].to_string(),
                suffix: lines[i + 2].to_string(),
            });
        }
        i += 3;
    }
    sheet
}

/// XML 属性值反转义：预定义实体（lt/gt/quot/apos/amp）与数字实体（`&#10;` / `&#x0A;`）。
/// 单次扫描——替换结果不再参与解析（`&amp;lt;` 还原为字面量 `&lt;`）；
/// 未识别的实体（如裸写的 HTML `&nbsp;`）原样保留，交给下游渲染层。
fn xml_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let entity = tail.find(';').map(|semi| &tail[1..semi]);
        let decoded = entity.and_then(|e| {
            if e.len() > 10 {
                return None; // 超长实体名无合法形式，按字面量处理
            }
            match e {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "amp" => Some('&'),
                _ => e.strip_prefix('#').and_then(|num| {
                    let code = match num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => num.parse::<u32>().ok(),
                    };
                    code.and_then(char::from_u32)
                }),
            }
        });
        match (decoded, entity) {
            (Some(c), Some(e)) => {
                out.push(c);
                rest = &tail[e.len() + 2..];
            }
            _ => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
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

    // ── xml_unescape ────────────────────────────────────────────

    #[test]
    fn unescapes_predefined_entities() {
        assert_eq!(xml_unescape("&lt;font&gt;"), "<font>");
        assert_eq!(xml_unescape("&quot;a&quot;"), "\"a\"");
        assert_eq!(xml_unescape("&apos;x&apos;"), "'x'");
        // 单次扫描：&amp;lt; 还原为字面量 &lt;，不再二次解析
        assert_eq!(xml_unescape("&amp;lt;"), "&lt;");
        assert_eq!(xml_unescape("&amp;nbsp;"), "&nbsp;");
    }

    #[test]
    fn unescapes_numeric_entities() {
        assert_eq!(xml_unescape("&#10;"), "\n");
        assert_eq!(xml_unescape("&#x41;"), "A");
    }

    #[test]
    fn keeps_unknown_entities_literal() {
        // HTML 实体（非 XML 预定义）不处理，原样保留给渲染层
        assert_eq!(xml_unescape("&nbsp;"), "&nbsp;");
        assert_eq!(xml_unescape("a & b"), "a & b");
        assert_eq!(xml_unescape("&notanentity;"), "&notanentity;");
    }

    // ── parse_style_sheet ───────────────────────────────────────

    #[test]
    fn style_sheet_three_line_groups() {
        let raw = "1\r\n&lt;font size=+2&gt;&lt;B&gt;\r\n&lt;/font&gt;&lt;/B&gt;&lt;br&gt;\r\n\
                   2\r\n&lt;i&gt;\r\n&lt;/i&gt;\r\n";
        let sheet = parse_style_sheet(raw);
        assert_eq!(
            sheet,
            vec![
                StyleSheetEntry {
                    id: 1,
                    prefix: "<font size=+2><B>".into(),
                    suffix: "</font></B><br>".into()
                },
                StyleSheetEntry { id: 2, prefix: "<i>".into(), suffix: "</i>".into() },
            ]
        );
    }

    #[test]
    fn style_sheet_blank_lines_are_significant() {
        // 空行占位必须保留：编号 1/2 的 前缀与后缀都是空串，编号 3 起才有内容。
        // 若丢弃空行，3 会错位到前缀 "3" 之外的槽位（js-mdict 的解析缺陷即此）。
        let raw = "1\n\n\n2\n\n\n3\n&lt;b&gt;\n\n";
        let sheet = parse_style_sheet(raw);
        assert_eq!(sheet.len(), 3);
        assert_eq!(sheet[0], StyleSheetEntry { id: 1, prefix: String::new(), suffix: String::new() });
        assert_eq!(sheet[1], StyleSheetEntry { id: 2, prefix: String::new(), suffix: String::new() });
        assert_eq!(sheet[2], StyleSheetEntry { id: 3, prefix: "<b>".into(), suffix: String::new() });
    }

    #[test]
    fn style_sheet_skips_malformed_group_without_drift() {
        // 组首非数字 → 跳过整组，后续编号仍按 3 行步进对齐
        let raw = "oops\n&lt;b&gt;\n&lt;/b&gt;\n7\n&lt;i&gt;\n&lt;/i&gt;\n";
        let sheet = parse_style_sheet(raw);
        assert_eq!(sheet, vec![StyleSheetEntry { id: 7, prefix: "<i>".into(), suffix: "</i>".into() }]);
    }

    #[test]
    fn style_sheet_empty_is_empty_vec() {
        assert!(parse_style_sheet("").is_empty());
        assert!(parse_style_sheet("\r\n").is_empty());
    }

    #[test]
    fn header_reads_style_sheet_attribute() {
        // 端到端：header 文本 → 属性解析 → 表
        let header = "<Dictionary Compact=\"Yes\" StyleSheet=\"1\n&lt;b&gt;\n&lt;/b&gt;\n\"/>";
        let mut found: Option<Vec<StyleSheetEntry>> = None;
        for (key, val) in parse_xml_attrs(header) {
            if key == "StyleSheet" {
                found = Some(parse_style_sheet(&val));
            }
        }
        assert_eq!(
            found.unwrap(),
            vec![StyleSheetEntry { id: 1, prefix: "<b>".into(), suffix: "</b>".into() }]
        );
    }
}
