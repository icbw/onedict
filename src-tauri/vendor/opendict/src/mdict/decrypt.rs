/// MDict nibble-swap XOR decryption.
/// Used for keyword index decryption (Encrypted bit 2).
///
/// Algorithm per byte:
///   1. Swap high/low nibbles of the encrypted byte
///   2. XOR with: previous_encrypted_byte, position (i & 0xFF), key[i % key_len]
///   3. previous starts at 0x36
pub fn fast_decrypt(data: &[u8], key: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    let mut previous: u8 = 0x36;
    for (i, &byte) in data.iter().enumerate() {
        let swapped = byte.rotate_left(4);
        let decrypted = swapped ^ previous ^ (i as u8) ^ key[i % key.len()];
        previous = byte;
        result.push(decrypted);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fast_decrypt_matches_python() {
        // Verify against Python: _fast_decrypt(b"\xAB\xCD\xEF", b"\x01\x02\x03")
        // Byte 0: swap(0xAB)=0xBA, 0xBA ^ 0x36 ^ 0x00 ^ 0x01 = 0x8D
        // Byte 1: swap(0xCD)=0xDC, 0xDC ^ 0xAB ^ 0x01 ^ 0x02 = 0x74
        // Byte 2: swap(0xEF)=0xFE, 0xFE ^ 0xCD ^ 0x02 ^ 0x03 = 0x32
        let data = [0xAB, 0xCD, 0xEF];
        let key = [0x01, 0x02, 0x03];
        let result = fast_decrypt(&data, &key);
        assert_eq!(result, vec![0x8D, 0x74, 0x32]);
    }
}
