# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.5.0] - 2026-11-19

### Added

- **AI-driven hierarchy.** Once crawling goes idle, the whole article is sent to the model, which groups it into blocks → topics → sentences. Level names are generated from the content itself — no hard-coded categories — and proper nouns stay in their original language.
- **Three-tier structure fallback.** AI grouping first, HTML `h2`–`h4` headings second, flat web last. A failed grouping call degrades silently instead of emptying the web.
- **Short-label hints.** Label lines under the 12-character sentence threshold (`Talk 1:`, `Abstract:`, `Speaker:`) are kept as a `hint` on the next block, so tag-structured mail keeps its sectioning signal without disturbing the `Range` used for highlighting.

### Changed

- Branch limits widened: 24 points at normal width (was 16), up to 12 branches (was 9).
- Grouping output takes priority over the heading-based tree; the heading tree remains as a fallback.

## [2.4.0] - 2026-11-19

### Added

- **Layered web.** First level from HTML `h2` headings, second from AI topic branches; sentences fold into each branch's `kids` instead of crowding the main web.
- **Two expand modes.** Clicking a topic capsule focuses into a drill-down view at normal width, and grows the next layer in place in the enlarged view.

## [2.3.6] - 2026-11-18

### Fixed

- Pages whose text lives entirely in `div` / `section` / `td` (mail clients, docs, admin panels) scanned as `0 / 0`. The scanner now falls back to leaf containers when it finds fewer than three standard blocks.

## [2.3.5] - 2026-11-18

### Fixed

- Plain-language card buttons escaped the card — the card is now measured after its content is filled.

### Changed

- Keyword flight is slower and larger, with ease-in-out easing.

## [2.3.4] - 2026-11-18

### Changed

- The empty web now prints the actual reason the AI call failed instead of spinning forever.

## [2.3.3] - 2026-11-18

### Fixed

- Empty-web regression caused by a `kw` prompt wording that made the model emit invalid JSON. Reworded the instruction, added tolerant JSON repair, raised `max_tokens` to 4000.

## [2.3.2] - 2026-11-18

### Added

- Keyword flight: a keyword travels along a Bézier silk thread from the source sentence to its capsule, rests, then fades out.

## [2.3.1] - 2026-11-18

### Added

- Progressive weaving animation — silk is drawn outward from the hub and capsules pop in from the inside out.

## [2.3.0] - 2026-11-18

### Fixed

- On-demand calls failed silently when the service worker had been recycled. The content script now pings the worker before sending a request.

## [2.2.9] - 2026-11-17

### Fixed

- The plain-language channel failed silently; the real error is now surfaced.

## [2.2.8] - 2026-11-17

### Added

- Plain-language summary of the whole article, generated on demand and cached for the session.

## [2.2.7] - 2026-11-17

### Changed

- Hover transparency narrowed to the backdrop and silk only; all controls stay fully opaque.

## [2.2.6] - 2026-11-17

### Changed

- Hover transparency finalised at 0.81 opacity.

## [2.2.5] - 2026-11-17

### Added

- Hover transparency: the backdrop fades while the pointer is over the panel.

## [2.2.4] - 2026-11-17

### Added

- Point limit raised to 50; the panel enlarges automatically when there are many points.
- Restarting the crawl clears the web.

## [2.2.3] - 2026-11-17

### Added

- Panel zoom (372px → 620px); the web redraws for the new size.

### Changed

- Panel chrome is neutral grey; colour is reserved for the web itself.
- Thin silk brightened.

## [2.2.2] - 2026-11-17

### Added

- Node detail cards: type, branch, short summary, full sentence, locate and copy.

## [2.2.1] - 2026-11-17

### Fixed

- String sentence ids failed to match; the collapsible list was squashed by flex; output was not forced to Chinese.

## [2.2.0] - 2026-11-01

### Added

- The spider-web map lands: AI takeaways grouped into branches, rendered as a radial web with white silk and colour-coded tips.

[Unreleased]: https://github.com/fjdaj0419/tldr-crawler/compare/v2.5.0...HEAD
[2.5.0]: https://github.com/fjdaj0419/tldr-crawler/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/fjdaj0419/tldr-crawler/compare/v2.3.6...v2.4.0
[2.3.6]: https://github.com/fjdaj0419/tldr-crawler/compare/v2.3.1...v2.3.6
[2.3.1]: https://github.com/fjdaj0419/tldr-crawler/compare/v2.2.4...v2.3.1
[2.2.4]: https://github.com/fjdaj0419/tldr-crawler/compare/v2.2.0...v2.2.4
[2.2.0]: https://github.com/fjdaj0419/tldr-crawler/releases/tag/v2.2.0
