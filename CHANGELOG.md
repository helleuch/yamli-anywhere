# Changelog

## 0.3.4

- Fixed Space being swallowed after Latin input.
- Space is now intercepted only when a Yamli candidate is already ready to commit.
- After selecting the Latin candidate, Space is handled natively by the editor.
- Kept number keys as ordinary characters for Arabizi.
- Kept Arabic punctuation conversion limited to `,` → `،` and `?` → `؟`.

## 0.3.3

- Fixed duplicate separator/punctuation insertion in controlled editors such as Label Studio.
- Fixed code-switching after selecting the Latin candidate: Space now commits the Latin word and continues normally.
- Removed number-key candidate shortcuts; digits are always typed as normal characters for Arabizi (`3`, `5`, `7`, etc.).
- Removed numeric labels from the candidate popup.
- Arabic punctuation conversion is limited to `,` → `،` and `?` → `؟`; other punctuation is left untouched.
- Simplified synthetic editing events to avoid duplicate handling by framework-controlled fields.

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
