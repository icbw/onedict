use std::cmp::Ordering;

/// Compare two strings according to the StarDict specification.
///
/// First compares with g_ascii_strcasecmp (case-insensitive for ASCII A-Z only,
/// non-ASCII bytes compared as raw unsigned values). If equal, tiebreaks with
/// a raw byte-level strcmp.
pub fn stardict_strcmp(s1: &str, s2: &str) -> Ordering {
    let b1 = s1.as_bytes();
    let b2 = s2.as_bytes();

    // Phase 1: g_ascii_strcasecmp
    let common_len = b1.len().min(b2.len());
    for i in 0..common_len {
        let c1 = ascii_lower(b1[i]);
        let c2 = ascii_lower(b2[i]);
        if c1 != c2 {
            return c1.cmp(&c2);
        }
    }
    let case_cmp = b1.len().cmp(&b2.len());
    if case_cmp != Ordering::Equal {
        return case_cmp;
    }

    // Phase 2: raw byte strcmp tiebreaker
    for i in 0..common_len {
        if b1[i] != b2[i] {
            return b1[i].cmp(&b2[i]);
        }
    }
    b1.len().cmp(&b2.len())
}

fn ascii_lower(b: u8) -> u8 {
    if b.is_ascii_uppercase() {
        b + (b'a' - b'A')
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::stardict_strcmp;

    #[test]
    fn equal_strings() {
        assert_eq!(stardict_strcmp("apple", "apple"), std::cmp::Ordering::Equal);
    }

    #[test]
    fn shorter_string_is_less() {
        assert_eq!(
            stardict_strcmp("apple", "appleee"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn case_insensitive_then_length() {
        assert_eq!(
            stardict_strcmp("apple", "ApPleee"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn case_sensitive_tiebreaker() {
        assert_eq!(
            stardict_strcmp("apple", "ApPle"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn different_words_case_insensitive() {
        assert_eq!(
            stardict_strcmp("apple", "pEar"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn different_words_same_start() {
        assert_eq!(
            stardict_strcmp("pear", "pineapple"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn non_ascii_in_second_word() {
        assert_eq!(
            stardict_strcmp("pear", "pineäpple"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn non_ascii_not_folded() {
        assert_eq!(
            stardict_strcmp("pear", "peär"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn non_ascii_not_folded_longer() {
        assert_eq!(
            stardict_strcmp("pear", "peärs"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn non_ascii_length_difference() {
        assert_eq!(
            stardict_strcmp("peärs", "peär"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn hyphen_before_letter() {
        assert_eq!(
            stardict_strcmp("ap-ple", "apple"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn empty_strings_equal() {
        assert_eq!(stardict_strcmp("", ""), std::cmp::Ordering::Equal);
    }

    #[test]
    fn empty_vs_nonempty() {
        assert_eq!(stardict_strcmp("", "a"), std::cmp::Ordering::Less);
        assert_eq!(stardict_strcmp("a", ""), std::cmp::Ordering::Greater);
    }

    #[test]
    fn single_char_case_tiebreaker() {
        assert_eq!(
            stardict_strcmp("a", "A"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn case_insensitive_ordering_ignores_case() {
        assert_eq!(
            stardict_strcmp("B", "a"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn digits_not_folded() {
        assert_eq!(
            stardict_strcmp("a1", "a2"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            stardict_strcmp("a2", "a1"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn symmetric() {
        let a = "apple";
        let b = "banana";
        let cmp1 = stardict_strcmp(a, b);
        let cmp2 = stardict_strcmp(b, a);
        assert_eq!(cmp1, std::cmp::Ordering::Less);
        assert_eq!(cmp2, std::cmp::Ordering::Greater);
    }

    #[test]
    fn transitive() {
        assert_eq!(stardict_strcmp("ant", "bat"), std::cmp::Ordering::Less);
        assert_eq!(stardict_strcmp("bat", "cat"), std::cmp::Ordering::Less);
        assert_eq!(stardict_strcmp("ant", "cat"), std::cmp::Ordering::Less);
    }
}
