use std::cmp::Ordering;
use std::str;

/// Extract a null-terminated UTF-8 word from raw index data.
pub(crate) fn word_at<'a>(data: &'a [u8], offsets: &[u32], i: usize) -> &'a str {
    let start = offsets[i] as usize;
    let null_pos = data[start..].iter().position(|&b| b == 0).unwrap();
    str::from_utf8(&data[start..start + null_pos]).unwrap()
}

/// Binary search for an exact word match. Returns the matching index.
pub(crate) fn find_match<F>(
    data: &[u8],
    offsets: &[u32],
    word: &str,
    cmp: F,
) -> Option<usize>
where
    F: Fn(&str, &str) -> Ordering,
{
    let mut low = 0usize;
    let mut high = offsets.len();
    while low < high {
        let mid = low + (high - low) / 2;
        match cmp(word_at(data, offsets, mid), word) {
            Ordering::Equal => return Some(mid),
            Ordering::Less => low = mid + 1,
            Ordering::Greater => high = mid,
        }
    }
    None
}
