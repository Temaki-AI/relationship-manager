# Dependency security — 6 October 2026

The remaining security gate is active; no advisory is suppressed and no audit
severity threshold is lowered. Signed personal iOS build 10 is installed; its
provenance is recorded separately. The public audit gate remains open. The
6 October root audit in CI 37399778819 reported nine affected packages: seven high
and two moderate. A later scoped CSS-parser patch removes the two moderate findings;
the fresh local root audit reports seven high and zero moderate. The audit still
exits unsuccessfully, retaining the public release gate.

The parser adapters below are included in installed build 10. Its native
compilation/startup and offline validation pass; current phone launch is blocked
by the device lock. Build 12 retains these dependency versions. Its native device
and simulator Release builds, startup and offline journey pass in CI 37402857771;
the signed candidate also preserves the existing synthetic QA cache on upgrade.

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

Do not force npm's proposed Expo 44 or React Native 0.72 downgrade. Public release
requires upstream patches or verified compatible remediation, followed by actual
native compilation/startup, web build and security validation. Current npm audit
continues to exit unsuccessfully, accurately retaining the open gate.

The patched dependency tree at `7754c68` passes both native Release compilations,
linkage verification and isolated simulator startup with real SQLite/Keychain
initialization in [run 37267403749](https://github.com/Temaki-AI/relationship-manager/actions/runs/37267403749).
This validates compatibility of the applied patches; unresolved audit findings
remain open, and the installed personal build still has its recorded earlier source.

## Patched image and URI parsers — 6 October 2026

Scoped overrides replace Metro's image-size 1.2.1 with 2.0.4 and query-string's
decode-uri-component 0.2.2 with 0.5.0. Minimal checked-in patches adapt Metro 0.84.4
to the named buffer API and asynchronous, bounded file-header API, retaining its
zip-directory buffer path. Query-string 7.1.3 selects the ESM decoder's default
export and retains its existing Router interface and options. Expo 57, React
Native 0.86, React, Router and every native module keep their prior versions.

Pinned patch-package 8.0.1 applies both patches on postinstall with
`--error-on-fail`. A clean `npm ci` successfully reapplies them. Five new behavioral
checks cover PNG/SVG buffers, file and zip-directory assets, scale metadata,
recognized zero-sized HEIF/JXL/ICNS containers, Unicode/contact-method queries,
repeated/array parameters, malformed percent sequences and repeatable application.
Potentially hanging image/URI inputs run in subprocesses with hard deadlines;
both buffer and actual file parsing reject the malformed images. The URI case
preserves 20,000 malformed encoded bytes without recursive failure.

All **22 mobile package tests** pass with no failures/skips, including those five
new checks. Mobile types/lint and the iOS Hermes export pass (1,356 modules, 24
assets, 3.8 MB). The fresh mobile audit removes the
[HEIF/JXL loop advisory](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq),
[ICNS finding](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
[URI decoder finding](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr),
along with their query-string/Router propagation. The audit reports **22 high,
zero moderate** affected packages, compared with 21 high/three moderate before:
the patch tool and its workspace helper add two parents affected by the existing
braces advisory. They introduce no additional advisory. These are dependency
graph counts, not independent vulnerability counts.

The preceding root audit reported seven high findings; the later CI result above
adds two moderate affected packages. Braces 3.0.3 and node-forge 1.4.0 remained
unpatched in the preceding review. Dependency versions and audit thresholds have
not changed in the Calendar work; the public security gate remains open.
No root dependency, production Worker, provider grant or database migration changed
in that image/URI slice. Native build-10 run 37391200805 now passes both Release builds,
linkage/startup and its complete offline journey (452.447 seconds, one pass and
zero failures/skips). Its exact signed artifact upgrades the phone from build 9;
fresh metadata verifies build 10, while iOS blocks launch because the phone is
locked. The matching simulator runs with all 23 data tables and installation
identity unchanged. See [the build-10 record](personal-ios-build10.md). The preceding
passing build-9 delivery stays separately recorded.

## CSS selector parser compatibility — 6 October 2026

Scoped root overrides select postcss-selector-parser 7.1.6 for Tailwind and
postcss-nested. The lockfile changes only that parser; Tailwind remains 3.4.19,
postcss-nested remains 6.2.0 and all native dependencies retain their versions.
The patch closes the [flat-selector CPU-exhaustion advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
Upstream 7.0 changed insertion during iteration, so compatibility is verified
through the actual styling pipeline rather than inferred from the patch version.

The complete stylesheet generated from the current app sources is byte-identical
with the previous 6.1.4 parser and patched 7.1.6 parser: 74,018 bytes, SHA-256
`c979eea17bbcd9e76c57615508ca95192c3aceeef94d81cc5514eeceb230ce2e`.
Separate interactive/responsive utility and nested-selector fixtures also retain
identical output. Two persistent integration cases cover group/peer, ARIA/data,
focus-visible, responsive/dark selectors, nested rules and a 400 KB flat selector
in a subprocess with an enforceable deadline. Both cases pass with no skips.
Type checking, full lint, Cloudflare production build and Worker dry run pass; standalone
packaging excludes database/environment files. The fresh root audit drops from
nine affected packages (seven high/two moderate) to seven high/zero moderate.
This patch does not change the installed phone or deploy production. Unresolved
high findings, Google data OAuth and the integration pilots remain open.
