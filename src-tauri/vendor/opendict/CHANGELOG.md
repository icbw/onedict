# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each artifact (the `opendict-rs` crate, the `@opendict-rs/node` npm
package, the `@opendict-rs/expo` npm package) is versioned independently.
Entries are grouped by artifact under each release.

## [Unreleased]

### opendict-rs (crate)
- Initial public release: unified reader for StarDict and MDict, with
  zlib + LZO + gzip decompression, prefix search, synonym lookup, and
  format auto-detection.

### @opendict-rs/node
- Initial public release: Node.js bindings via napi-rs. Prebuilt for
  macOS x64/arm64, Linux x64/arm64 (gnu+musl), Windows x64/arm64.

### @opendict-rs/expo
- Initial public release: Expo native module wrapping opendict-rs via
  uniffi. iOS XCFramework (arm64 device + simulator). Android jniLibs
  for arm64-v8a, armeabi-v7a, x86, x86_64.

[Unreleased]: https://github.com/callum-gander/opendict-rs/commits/master
