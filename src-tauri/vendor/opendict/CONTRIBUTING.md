# Contributing

## Repo layout

```
.
├── src/                  Rust core — the opendict-rs crate
├── benches/              criterion benchmarks
├── tests/                Rust integration tests + fixtures
├── node/                 napi-rs Node.js bindings (publishes as `@opendict-rs/node`)
├── mobile/               uniffi crate that produces Swift + Kotlin bindings
├── expo/                 Expo native module (publishes as `@opendict-rs/expo`)
├── examples/
│   ├── node-test/        smoke test for the node package
│   └── expo-test/        Expo app that runs an assertion suite over real dicts
├── scripts/
│   └── build-mobile.sh   builds the iOS XCFramework + all four Android ABIs
├── docs/                 spec notes + publishing plan
└── .github/workflows/    CI + per-artifact release workflows
```

## Building the Rust core

```bash
cargo test
cargo clippy --all-targets
cargo bench           # populates tests/dicts/ for the bench discovery to work
```

The `tests/dicts/` directory is git-ignored. Drop StarDict folders under
`tests/dicts/stardict/` and MDict folders under `tests/dicts/mdict/`;
the integration tests and benches pick them up automatically.

## Building the Node addon

```bash
cd node
npm install
npm run build         # produces ./opendict.<platform>.node
cd ../examples/node-test
npm install
node test.mjs         # runs the assertion suite
```

## Building the Expo module

The full mobile pipeline is one script:

```bash
./scripts/build-mobile.sh
```

Requires:
- Rust toolchain with iOS + Android targets:
  `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `aarch64-linux-android`,
  `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`
- Xcode (for `xcodebuild -create-xcframework`)
- Android NDK (the script picks the latest one in `$ANDROID_HOME/ndk/`)
- `cargo install cargo-ndk`
- Node 18+

Outputs:
- `expo/ios/opendict_mobile.xcframework/`
- `expo/android/src/main/jniLibs/{arm64-v8a,armeabi-v7a,x86,x86_64}/libopendict_mobile.so`
- Generated Swift bindings in `expo/ios/opendict_mobile.swift`
- Generated Kotlin bindings in `expo/android/src/main/java/uniffi/`
- Compiled TypeScript in `expo/build/`

To exercise the Expo bindings end-to-end:

```bash
cd examples/expo-test
npm install
npm run ios                       # boots the simulator, builds, installs
./scripts/setup-dicts.sh          # stages fixtures + tests/dicts/* into examples/expo-test/dicts/
./scripts/push-dicts.sh           # copies them to the simulator's documents dir
# reload the app
```

## API changes

Three layers wrap the Rust core. When changing the public Rust API:

1. Update `src/lib.rs` and confirm `cargo test` is clean
2. Update `node/src/lib.rs` to mirror the Rust API in napi shapes,
   then `cd node && npm run build && cd ../examples/node-test && node test.mjs`
3. Update `mobile/src/lib.rs` to mirror it in uniffi types, then run
   `./scripts/build-mobile.sh` and exercise the expo test app

The bindings should track the Rust API closely. Don't add JS-only
wrapper logic in `node/` or `mobile/` — keep that work in TypeScript
(`expo/src/index.ts`) or in user code.

## Releasing

The full plan is in [`docs/publishing-plan.md`](docs/publishing-plan.md);
this section is the operational summary.

Three release workflows live in `.github/workflows/`, each triggered by
a tag prefix:

- `crate-release.yml` — `crate-v*` → publishes `opendict-rs` to crates.io
- `node-release.yml`  — `node-v*`  → publishes `@opendict-rs/node` (and
  the eight per-platform packages) to npm
- `expo-release.yml`  — `expo-v*`  → publishes `@opendict-rs/expo` to npm

All three also accept `workflow_dispatch`, so they can be re-run from
the Actions tab without pushing a tag (useful for re-running a failed
publish).

### Bootstrap (first publish for each artifact)

The very first publish to each registry must be done manually from a
local machine — the registries need to know the package exists before
CI can push subsequent versions. The workflows currently run the
pre-publish smoke tests on tag push but leave the actual publish step
commented out for this reason.

1. **Rust crate (crates.io)**
   - `cargo login` (paste a crates.io API token)
   - From repo root: `cargo publish`
   - Then add `CARGO_REGISTRY_TOKEN` to repo secrets and uncomment the
     `cargo publish` line at the bottom of `crate-release.yml`.

2. **Expo package (`@opendict-rs/expo`)**
   - The `@opendict-rs` npm org should already exist (one-time setup at
     https://www.npmjs.com/org/create)
   - `npm login`
   - From `expo/`: `../scripts/build-mobile.sh && npm publish --access public`
   - Then add `NPM_TOKEN` to repo secrets and uncomment the publish line
     in `expo-release.yml`.

3. **Node package (`@opendict-rs/node`)**
   - This one is multi-package: the main `@opendict-rs/node` plus eight
     `@opendict-rs/node-<target>` platform packages, all sharing a version.
   - Easiest first-time path: trigger `node-release.yml` via
     `workflow_dispatch` (or push a `node-v0.1.0` tag), wait for the
     build matrix to upload artifacts, download them, then publish
     locally.
   - From `node/` after artifacts are downloaded: `npx napi prepublish -t npm`
     and `npm publish` for each `npm/<target>/` and the root.
   - Then add `NPM_TOKEN` and uncomment the publish step in `node-release.yml`.

### Subsequent releases (once bootstrapped)

```bash
# 1. Bump the version (Cargo.toml / expo/package.json / node/package.json
#    and every node/npm/<target>/package.json — or run `napi version`)

# 2. Commit
git commit -am "chore: release crate v0.2.0"

# 3. Tag and push — this fires the workflow
git tag crate-v0.2.0
git push origin master crate-v0.2.0
```

Same shape for `expo-v*` and `node-v*` tags.

### Versioning

- The three artifacts version independently. The Rust core is the
  source of truth — when its public API shape changes, expect to bump
  the bindings in lockstep.
- Use semver. While in 0.x, breaking changes bump the minor version.

## Style

- Rust: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`
- TypeScript: keep the surface small; `expo/src/index.ts` is the public
  API, everything else is plumbing
- Commit messages: [Conventional Commits](https://www.conventionalcommits.org/)
  style — `<type>(<scope>): <description>` where type is one of `feat`,
  `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `build`,
  `ci`. Scope is optional. No co-author footers.
