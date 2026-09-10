#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct DictEntry {
    pub type_id: char,
    pub data: Vec<u8>,
}

impl DictEntry {
    pub fn new(type_id: char, data: Vec<u8>) -> Self {
        Self { type_id, data }
    }
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct DictInfo {
    pub name: String,
    pub author: String,
    pub description: String,
    pub word_count: usize,
}
