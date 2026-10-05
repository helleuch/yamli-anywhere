# Changelog

## 0.3.2

- Added Arabic punctuation conversion: `,` → `،` and `?` → `؟`.
- `:` and `!` are supported as punctuation terminators and keep their standard glyphs.
- Typing punctuation now commits the current Yamli candidate, e.g. `salam?` → `سلام؟`.

## 0.3.1

- Added the original Latin input as the first candidate, matching Yamli's code-switching workflow.
- The first Arabic candidate is still highlighted by default, so Space transliterates normally.
- Clicking the Latin candidate keeps the word in Latin script.
- Number keys 1–9 select Arabic candidates.

## 0.3.0

- Added working Yamli SXHR transliteration support.
