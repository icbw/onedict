use std::fs;
use std::io::Read;
use std::path::Path;

use flate2::read::GzDecoder;

/// Read a file, decompressing with gzip if the path ends in .gz or .dz.
pub fn read_file(path: &Path) -> crate::Result<Vec<u8>> {
    let data = fs::read(path)?;
    if path.extension().is_some_and(|ext| ext == "gz" || ext == "dz") {
        let mut decoder = GzDecoder::new(&data[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)?;
        Ok(decompressed)
    } else {
        Ok(data)
    }
}
