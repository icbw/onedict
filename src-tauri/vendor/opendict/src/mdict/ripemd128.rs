/// RIPEMD-128 hash function.
/// Ported from the Python reference implementation by zhansliu/writemdict.
/// Reference: http://homes.esat.kuleuven.be/~bosselae/ripemd/rmd128.txt
pub fn ripemd128(message: &[u8]) -> [u8; 16] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xefcdab89;
    let mut h2: u32 = 0x98badcfe;
    let mut h3: u32 = 0x10325476;

    let blocks = pad_and_split(message);
    for block in &blocks {
        let (mut a, mut b, mut c, mut d) = (h0, h1, h2, h3);
        let (mut ap, mut bp, mut cp, mut dp) = (h0, h1, h2, h3);

        for j in 0..64usize {
            let t = rol(S[j], add(a, f(j, b, c, d), block[R[j] as usize], k_const(j)));
            a = d;
            d = c;
            c = b;
            b = t;

            let t = rol(SP[j], add(ap, f(63 - j, bp, cp, dp), block[RP[j] as usize], kp_const(j)));
            ap = dp;
            dp = cp;
            cp = bp;
            bp = t;
        }

        let t = h1.wrapping_add(c).wrapping_add(dp);
        h1 = h2.wrapping_add(d).wrapping_add(ap);
        h2 = h3.wrapping_add(a).wrapping_add(bp);
        h3 = h0.wrapping_add(b).wrapping_add(cp);
        h0 = t;
    }

    let mut result = [0u8; 16];
    result[0..4].copy_from_slice(&h0.to_le_bytes());
    result[4..8].copy_from_slice(&h1.to_le_bytes());
    result[8..12].copy_from_slice(&h2.to_le_bytes());
    result[12..16].copy_from_slice(&h3.to_le_bytes());
    result
}

fn f(j: usize, x: u32, y: u32, z: u32) -> u32 {
    match j {
        0..=15 => x ^ y ^ z,
        16..=31 => (x & y) | (z & !x),
        32..=47 => (x | !y) ^ z,
        48..=63 => (x & z) | (y & !z),
        _ => unreachable!(),
    }
}

fn k_const(j: usize) -> u32 {
    match j {
        0..=15 => 0x00000000,
        16..=31 => 0x5a827999,
        32..=47 => 0x6ed9eba1,
        48..=63 => 0x8f1bbcdc,
        _ => unreachable!(),
    }
}

fn kp_const(j: usize) -> u32 {
    match j {
        0..=15 => 0x50a28be6,
        16..=31 => 0x5c4dd124,
        32..=47 => 0x6d703ef3,
        48..=63 => 0x00000000,
        _ => unreachable!(),
    }
}

fn add(a: u32, b: u32, c: u32, d: u32) -> u32 {
    a.wrapping_add(b).wrapping_add(c).wrapping_add(d)
}

fn rol(s: u32, x: u32) -> u32 {
    x.rotate_left(s)
}

fn pad_and_split(message: &[u8]) -> Vec<[u32; 16]> {
    let orig_len = message.len();
    // Minimum padding is 1 byte (0x80). Pad to 56 mod 64, then add 8 bytes for length.
    let pad_length = 64 - ((orig_len.wrapping_sub(56)) % 64);

    let mut padded = Vec::with_capacity(orig_len + pad_length + 8);
    padded.extend_from_slice(message);
    padded.push(0x80);
    padded.resize(orig_len + pad_length, 0u8);
    padded.extend_from_slice(&((orig_len as u64 * 8).to_le_bytes()));

    debug_assert!(padded.len() % 64 == 0);

    padded
        .chunks_exact(64)
        .map(|chunk| {
            let mut block = [0u32; 16];
            for (i, word) in chunk.chunks_exact(4).enumerate() {
                block[i] = u32::from_le_bytes([word[0], word[1], word[2], word[3]]);
            }
            block
        })
        .collect()
}

#[rustfmt::skip]
const R: [u8; 64] = [
     0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15,
     7,  4, 13,  1, 10,  6, 15,  3, 12,  0,  9,  5,  2, 14, 11,  8,
     3, 10, 14,  4,  9, 15,  8,  1,  2,  7,  0,  6, 13, 11,  5, 12,
     1,  9, 11, 10,  0,  8, 12,  4, 13,  3,  7, 15, 14,  5,  6,  2,
];

#[rustfmt::skip]
const RP: [u8; 64] = [
     5, 14,  7,  0,  9,  2, 11,  4, 13,  6, 15,  8,  1, 10,  3, 12,
     6, 11,  3,  7,  0, 13,  5, 10, 14, 15,  8, 12,  4,  9,  1,  2,
    15,  5,  1,  3,  7, 14,  6,  9, 11,  8, 12,  2, 10,  0,  4, 13,
     8,  6,  4,  1,  3, 11, 15,  0,  5, 12,  2, 13,  9,  7, 10, 14,
];

#[rustfmt::skip]
const S: [u32; 64] = [
    11, 14, 15, 12,  5,  8,  7,  9, 11, 13, 14, 15,  6,  7,  9,  8,
     7,  6,  8, 13, 11,  9,  7, 15,  7, 12, 15,  9, 11,  7, 13, 12,
    11, 13,  6,  7, 14,  9, 13, 15, 14,  8, 13,  6,  5, 12,  7,  5,
    11, 12, 14, 15, 14, 15,  9,  8,  9, 14,  5,  6,  8,  6,  5, 12,
];

#[rustfmt::skip]
const SP: [u32; 64] = [
     8,  9,  9, 11, 13, 15, 15,  5,  7,  7,  8, 11, 14, 14, 12,  6,
     9, 13, 15,  7, 12,  8,  9, 11,  7,  7, 12,  7,  6, 15, 13, 11,
     9,  7, 15, 11,  8,  6,  6, 14, 12, 13,  5, 14, 13, 13,  7,  5,
    15,  5,  8, 11, 14, 14,  6, 14,  6,  9, 12,  9, 12,  5, 15,  8,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ripemd128_known_vector() {
        // From the Python reference: ripemd128(b"The quick brown fox jumps over the lazy dog")
        let digest = ripemd128(b"The quick brown fox jumps over the lazy dog");
        let expected: [u8; 16] = [
            0x3f, 0xa9, 0xb5, 0x7f, 0x05, 0x3c, 0x05, 0x3f,
            0xbe, 0x27, 0x35, 0xb2, 0x38, 0x0d, 0xb5, 0x96,
        ];
        assert_eq!(digest, expected);
    }

    #[test]
    fn test_ripemd128_empty() {
        // RIPEMD-128("") = cdf26213a150dc3ecb610f18f6b38b46
        let digest = ripemd128(b"");
        let expected: [u8; 16] = [
            0xcd, 0xf2, 0x62, 0x13, 0xa1, 0x50, 0xdc, 0x3e,
            0xcb, 0x61, 0x0f, 0x18, 0xf6, 0xb3, 0x8b, 0x46,
        ];
        assert_eq!(digest, expected);
    }

    #[test]
    fn test_ripemd128_abc() {
        // RIPEMD-128("abc") = c14a1219 9c66e4ba 84636b0f 69144c77
        let digest = ripemd128(b"abc");
        let expected: [u8; 16] = [
            0xc1, 0x4a, 0x12, 0x19, 0x9c, 0x66, 0xe4, 0xba,
            0x84, 0x63, 0x6b, 0x0f, 0x69, 0x14, 0x4c, 0x77,
        ];
        assert_eq!(digest, expected);
    }
}
