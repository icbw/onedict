//! 索引磁盘缓存（onedict 本地改造，MIT，与 crate 同许可；来源见 crate 根 ONEDICT-NOTES.md）。
//!
//! `MdictFile::open` 的成本大头是 key block 逐块解压 + 逐条解析（数十万词条量级）与
//! 排序索引构建。本模块把解析后的可复用状态序列化到磁盘，后续启动直接装配
//! （GoldenDict index cache 同思路）。自写小端二进制，magic `ODIDX01`；
//! 缓存失效由调用方通过「源文件指纹嵌入缓存文件名」实现，读取侧无需 stat 源文件；
//! 结构校验失败一律返回 Err，由调用方回退正常解析（坏缓存自动覆盖重建）。

use std::io::{self, Read, Write};
use std::path::Path;

/// 可序列化的索引快照（与 `MdictFile` 的同名字段一一对应）。
pub(super) struct CachedIndex {
    pub keywords: Vec<String>,
    pub record_offsets: Vec<u64>,
    /// usize 收窄为 u32（词条数远小于 2^32；读取侧转回）
    pub sorted_indices: Vec<u32>,
    /// (comp_offset, comp_size, decomp_size)
    pub record_blocks: Vec<(u64, u64, u64)>,
    pub record_blocks_start: u64,
}

const MAGIC: &[u8; 7] = b"ODIDX01";
/// 容量防御上限：损坏文件伪造的超大长度直接拒绝，避免分配爆内存
const MAX_ITEMS: u32 = 100_000_000;
const MAX_STR: u32 = 10_000_000;

/// 原子写（temp + rename），防半写文件被并发读到。
pub(super) fn write(path: &Path, idx: &CachedIndex) -> io::Result<()> {
    let mut buf = Vec::new();
    buf.extend_from_slice(MAGIC);
    put_u32(&mut buf, idx.keywords.len() as u32);
    for k in &idx.keywords {
        put_u32(&mut buf, k.len() as u32);
        buf.extend_from_slice(k.as_bytes());
    }
    put_u32(&mut buf, idx.record_offsets.len() as u32);
    for v in &idx.record_offsets {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    put_u32(&mut buf, idx.sorted_indices.len() as u32);
    for v in &idx.sorted_indices {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    put_u32(&mut buf, idx.record_blocks.len() as u32);
    for &(a, b, c) in &idx.record_blocks {
        buf.extend_from_slice(&a.to_le_bytes());
        buf.extend_from_slice(&b.to_le_bytes());
        buf.extend_from_slice(&c.to_le_bytes());
    }
    buf.extend_from_slice(&idx.record_blocks_start.to_le_bytes());

    let tmp = path.with_extension("idxcache.tmp");
    std::fs::File::create(&tmp)?.write_all(&buf)?;
    std::fs::rename(&tmp, path)
}

/// 读缓存；magic/长度/编码任一异常即 Err。
pub(super) fn read(path: &Path) -> io::Result<CachedIndex> {
    let mut buf = Vec::new();
    std::fs::File::open(path)?.read_to_end(&mut buf)?;
    let mut c = io::Cursor::new(buf);

    let mut magic = [0u8; 7];
    c.read_exact(&mut magic)?;
    if &magic != MAGIC {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad magic"));
    }

    let n_keywords = take_u32(&mut c)? as usize;
    if n_keywords > MAX_ITEMS as usize {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "keywords len"));
    }
    let mut keywords = Vec::with_capacity(n_keywords);
    for _ in 0..n_keywords {
        let len = take_u32(&mut c)? as usize;
        if len > MAX_STR as usize {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "keyword len"));
        }
        let mut b = vec![0u8; len];
        c.read_exact(&mut b)?;
        keywords.push(String::from_utf8(b).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "utf8"))?);
    }

    let n_offsets = take_u32(&mut c)? as usize;
    if n_offsets > MAX_ITEMS as usize {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "offsets len"));
    }
    let mut record_offsets = Vec::with_capacity(n_offsets);
    for _ in 0..n_offsets {
        record_offsets.push(take_u64(&mut c)?);
    }

    let n_sorted = take_u32(&mut c)? as usize;
    if n_sorted > MAX_ITEMS as usize {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "sorted len"));
    }
    let mut sorted_indices = Vec::with_capacity(n_sorted);
    for _ in 0..n_sorted {
        sorted_indices.push(take_u32(&mut c)?);
    }

    let n_blocks = take_u32(&mut c)? as usize;
    if n_blocks == 0 || n_blocks > MAX_ITEMS as usize {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "blocks len"));
    }
    let mut record_blocks = Vec::with_capacity(n_blocks);
    for _ in 0..n_blocks {
        record_blocks.push((take_u64(&mut c)?, take_u64(&mut c)?, take_u64(&mut c)?));
    }
    let record_blocks_start = take_u64(&mut c)?;

    if sorted_indices.len() != keywords.len() || record_offsets.len() != keywords.len() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "index count mismatch"));
    }

    Ok(CachedIndex {
        keywords,
        record_offsets,
        sorted_indices,
        record_blocks,
        record_blocks_start,
    })
}

fn put_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}
fn take_u32(c: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    c.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn take_u64(c: &mut impl Read) -> io::Result<u64> {
    let mut b = [0u8; 8];
    c.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CachedIndex {
        CachedIndex {
            keywords: vec!["foo".into(), "bar".into(), "中文词".into()],
            record_offsets: vec![0, 10, 20],
            sorted_indices: vec![1, 0, 2],
            record_blocks: vec![(100, 50, 200), (150, 60, 220)],
            record_blocks_start: 1234,
        }
    }

    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join("opendict-idxcache-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("rt.idxcache");
        write(&p, &sample()).unwrap();
        let back = read(&p).unwrap();
        assert_eq!(back.keywords, sample().keywords);
        assert_eq!(back.record_offsets, sample().record_offsets);
        assert_eq!(back.sorted_indices, sample().sorted_indices);
        assert_eq!(back.record_blocks, sample().record_blocks);
        assert_eq!(back.record_blocks_start, 1234);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rejects_bad_magic() {
        let dir = std::env::temp_dir().join("opendict-idxcache-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("bad.idxcache");
        std::fs::write(&p, b"NOTMAGIC......").unwrap();
        assert!(read(&p).is_err());
        std::fs::remove_file(&p).ok();
    }
}
