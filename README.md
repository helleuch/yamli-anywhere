# Yamli Anywhere

A simple Chrome/Edge extension that brings **Yamli Arabic transliteration** to text boxes on web pages.

## How it works

The extension uses Yamli's transliteration service to convert Latin/Arabizi input into Arabic suggestions.

For example:

```text
salam
```

can give:

```text
سلام
سلم
سالم
```

The original Latin word is also shown as the first option for code-switching. The first Arabic suggestion is highlighted by default, so pressing **Space** still selects Arabic.

## Installation

1. Download this repository as a ZIP:
   **Code → Download ZIP**
2. Extract the ZIP somewhere on your computer.
3. Open:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted `yamli-anywhere` folder.
7. Reload the page where you want to use the extension.

## Test that it works

1. Click the **Yamli Anywhere** extension icon.
2. Make sure **Enabled** is checked.
3. Under **CURRENT PAGE**, you should see:

```text
Connected ✓ — this page is ready.
```

If not, click **Enable on this page**.

4. Under **YAMLI API**, click:

```text
Test with "salam"
```

A successful test should return Arabic candidates such as:

```text
سلام · سلم · سالم
```

5. Click inside a text box and type:

```text
salam
```

A list of Arabic suggestions should appear.

## Controls

- **Space** — accept the highlighted suggestion and add a space. The first Arabic suggestion is selected by default.
- **Latin option** — click the first (Latin) row to keep the word in Latin script for code-switching.
- **Enter** — accept the highlighted suggestion.
- **↑ / ↓** — move between suggestions.
- **1–9** — choose a numbered suggestion.
- **Esc** — close the suggestion box.
- **Alt + Shift + A** — enable/disable the extension.

## Note

This is an unofficial extension and is not affiliated with Yamli.
It relies on Yamli's online transliteration service, so an internet connection is required.
