use std::fmt;

#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// File I/O failures (not found, permission denied, read errors)
    Io(std::io::Error),
    /// File is corrupt or malformed (bad magic, truncated, checksum mismatch)
    InvalidFormat(String),
    /// File uses features not yet implemented (LZO, Salsa20, v1.2, etc.)
    Unsupported(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "I/O error: {}", e),
            Error::InvalidFormat(msg) => write!(f, "invalid format: {}", msg),
            Error::Unsupported(msg) => write!(f, "unsupported: {}", msg),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
