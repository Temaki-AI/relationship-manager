# Dependency security — 5 October 2026

The remaining security gate is active; no advisory is suppressed and no audit
severity threshold is lowered. Signed personal iOS build 7 is the installed
release; its earlier source/provenance is recorded separately. The public audit
gate remains open. A fresh root audit still reports seven high findings.

## Compatible patches applied

The root Drizzle TypeScript loader now uses a scoped esbuild 0.25.12 override.
Only that nested esbuild and its platform binaries change. Its actual sync/async
configuration compilation is covered by two integration tests. The older loader's
esbuild development-server advisory is removed.

Mobile lockfile patches remain within the dependencies' existing version ranges:
xmldom 0.8.15/0.9.12, brace-expansion 1.1.21/5.0.12, js-yaml 4.3.2,
nanoid 3.3.19, PostCSS 8.5.28, Browserslist 4.29.3 and baseline-browser-mapping
2.11.27, plus the associated browser-data packages. Expo, Expo Modules Core,
React Native, Router, FileSystem, image modules, screens, Reanimated and Worklets
versions are unchanged. Native type checking, five package tests, lint and Hermes
export pass after the changes. Root TypeScript/lint and all 805 application
tests and the Cloudflare build also pass. The complete test run uses two workers to fit this Mac's available
memory/disk; no tests are skipped.

The actual audit changes from 11 to 7 reported root packages (all high), and from
31 to 24 reported mobile packages (21 high, three moderate). These counts include
parent packages affected by a vulnerable transitive dependency; they are not
counts of independent vulnerabilities.

## Unresolved findings

- [braces stack exhaustion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): latest 3.0.3 is affected and the advisory has no patched release. This reaches Tailwind/Next lint on web and Metro on mobile.
- [node-forge signature verification](https://github.com/advisories/GHSA-86w9-cpqp-85rv): latest 1.4.0 is affected and has no published patch. This reaches Expo CLI/code-signing tooling. Apple app signing continues to use the local system codesign tool; that does not resolve the Expo dependency finding.
- [image-size malformed-image loops](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and [ICNS loop](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr): installed 1.2.1 is affected. Patched 2.0.4 changes the interface. Metro calls the version-1 default export with both buffers and file paths; a blind override would break asset compilation. A compatible integration fix remains required.
- [decode-uri-component malformed-input complexity](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr): Router's query-string dependency uses CommonJS decoder 0.2.2. The patched 0.5.0 is ESM and is outside its range. A tested Router-compatible decoder update remains required.

Do not force npm's proposed Expo 44 or React Native 0.72 downgrade. Public release
requires upstream patches or verified compatible remediation, followed by actual
native compilation/startup, web build and security validation. Current npm audit
continues to exit unsuccessfully, accurately retaining the open gate.

The patched dependency tree at `7754c68` passes both native Release compilations,
linkage verification and isolated simulator startup with real SQLite/Keychain
initialization in [run 37267403749](https://github.com/Temaki-AI/relationship-manager/actions/runs/37267403749).
This validates compatibility of the applied patches; unresolved audit findings
remain open, and the installed personal build still has its recorded earlier source.
