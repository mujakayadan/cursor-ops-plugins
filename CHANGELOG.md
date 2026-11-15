# Changelog

## [1.6.2](https://github.com/mujakayadan/cursor-ops-plugins/compare/v1.6.1...v1.6.2) (2026-11-15)


### Bug Fixes

* catch lowercase and WSL personal paths, cover portability in reviews ([#38](https://github.com/mujakayadan/cursor-ops-plugins/issues/38)) ([4985ea9](https://github.com/mujakayadan/cursor-ops-plugins/commit/4985ea9af6e9f254f9aa5b8d1ac9da391bf69d94))

## [1.6.1](https://github.com/mujakayadan/cursor-ops-plugins/compare/v1.6.0...v1.6.1) (2026-11-15)


### Bug Fixes

* keep personal values out of shared code, docs and examples ([#34](https://github.com/mujakayadan/cursor-ops-plugins/issues/34)) ([cd5467b](https://github.com/mujakayadan/cursor-ops-plugins/commit/cd5467b08b69fec760a696e7ecfb9fba257fed3f))

## [1.6.0](https://github.com/mujakayadan/cursor-ops-plugins/compare/v1.5.0...v1.6.0) (2026-11-15)


### Features

* add ops-mermaid and ops-latex authoring plugins ([#19](https://github.com/mujakayadan/cursor-ops-plugins/issues/19)) ([60349ec](https://github.com/mujakayadan/cursor-ops-plugins/commit/60349ececd5b5fa8028b79736a3b75a13c0d766f))
* add ops-standards and ops-docs review lenses ([#21](https://github.com/mujakayadan/cursor-ops-plugins/issues/21)) ([44d1539](https://github.com/mujakayadan/cursor-ops-plugins/commit/44d1539dba2b70f492c61a13070fa48c924f3550))
* add the ops command and per-plugin CLI installers ([#24](https://github.com/mujakayadan/cursor-ops-plugins/issues/24)) ([047cfb6](https://github.com/mujakayadan/cursor-ops-plugins/commit/047cfb615f641920797383e2de9baae5b90d39f7))
* agent-driven machine setup with per-plugin onboarding ([#26](https://github.com/mujakayadan/cursor-ops-plugins/issues/26)) ([6a1579c](https://github.com/mujakayadan/cursor-ops-plugins/commit/6a1579cbd54079b684e67d26a824443e763cd1da))
* load the whole suite in every workspace and add ops-control ([#23](https://github.com/mujakayadan/cursor-ops-plugins/issues/23)) ([710c1da](https://github.com/mujakayadan/cursor-ops-plugins/commit/710c1daf94b39259883a4fded7f98dcad897d569))
* serve read tiers from one shared local HTTP server ([#25](https://github.com/mujakayadan/cursor-ops-plugins/issues/25)) ([c0f24cc](https://github.com/mujakayadan/cursor-ops-plugins/commit/c0f24cc6c970021827192fb858c2f61ecc3e85d3))
* ship the engineering standards in every scaffolded project ([#22](https://github.com/mujakayadan/cursor-ops-plugins/issues/22)) ([d2dd712](https://github.com/mujakayadan/cursor-ops-plugins/commit/d2dd71249686ac2236a7035b195df39c21b92cb2))


### Bug Fixes

* keep the branch-delete guard inside its own command ([#31](https://github.com/mujakayadan/cursor-ops-plugins/issues/31)) ([47b9f16](https://github.com/mujakayadan/cursor-ops-plugins/commit/47b9f1626ce5e55d167bde012c6b6917e3088388))
* probe a shared login once in ops doctor ([#29](https://github.com/mujakayadan/cursor-ops-plugins/issues/29)) ([084861c](https://github.com/mujakayadan/cursor-ops-plugins/commit/084861c18a67c2e3ceab2d7ceff09f8d6db055df))
* tighten onboarding docs, doctor fixes and server logging after review ([#27](https://github.com/mujakayadan/cursor-ops-plugins/issues/27)) ([9220f0c](https://github.com/mujakayadan/cursor-ops-plugins/commit/9220f0c41631745d589f64ece5be7a42b959c38f))


### Performance Improvements

* parallel doctor probes, rate-limited refusal log, one installer name ([#28](https://github.com/mujakayadan/cursor-ops-plugins/issues/28)) ([d12618e](https://github.com/mujakayadan/cursor-ops-plugins/commit/d12618e9f26554ca131d75fda50b7f41b43cb8d2))

## [1.5.0](https://github.com/mujakayadan/cursor-ops-plugins/compare/v1.4.0...v1.5.0) (2026-11-15)


### Features

* **scaffold:** API contract checks for backends and opt-in Git LFS ([#11](https://github.com/mujakayadan/cursor-ops-plugins/issues/11)) ([62862ff](https://github.com/mujakayadan/cursor-ops-plugins/commit/62862ff4ae65ca9aa8fbaf1f429b8e1235254a5b))

## [1.4.0](https://github.com/mujakayadan/cursor-ops-plugins/compare/v1.3.0...v1.4.0) (2026-11-14)


### Features

* GitOps standard for this repo, the templates and the agent ([#1](https://github.com/mujakayadan/cursor-ops-plugins/issues/1)) ([46415bc](https://github.com/mujakayadan/cursor-ops-plugins/commit/46415bc4f725aac210aed86321dd030ebb96472d))


### Bug Fixes

* keep release-please version bumps lint-clean; ignore @types/node majors ([#6](https://github.com/mujakayadan/cursor-ops-plugins/issues/6)) ([dd0d5f9](https://github.com/mujakayadan/cursor-ops-plugins/commit/dd0d5f900940bbcb907c79524583eab13ccda44a))
