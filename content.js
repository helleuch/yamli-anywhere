(() => {
  // Prevent duplicate initialisation when the user force-injects the script.
  if (globalThis.__yamliAnywhereV2Loaded) {
    try {
      globalThis.__yamliAnywhereV2ShowToast?.("Yamli is already active on this page.");
    } catch (_) {}
    return;
  }
  globalThis.__yamliAnywhereV2Loaded = true;

  const STATE = {
    enabled: true,
    popup: null,
    list: null,
    toast: null,
    candidates: [],
    selectedIndex: 0,
    context: null,
    serial: 0,
    debounce: null,
    apiErrorShown: false,
    latinBypass: null,
    readyAt: Date.now()
  };

  const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ0-9'’_-]+$/;
  const EXCLUDED_RE = /^(?:https?:|ftp:|www\.|site:|cache:|link:|related:|info:|stocks:)|@/i;

  // Arabic punctuation. Colon and exclamation mark use the same glyphs
  // as Latin-script text; comma and question mark have Arabic forms.
  const PUNCTUATION_MAP = {
    ',': '،',
    ':': ':',
    '!': '!',
    '?': '؟'
  };

  function pageInfo() {
    try {
      return {
        protocol: location.protocol,
        hostname: location.hostname,
        pathname: location.pathname
      };
    } catch (_) {
      return {};
    }
  }

  function isTextControl(el) {
    if (el instanceof HTMLTextAreaElement) {
      return !el.disabled && !el.readOnly;
    }
    if (el instanceof HTMLInputElement) {
      const type = String(el.type || "text").toLowerCase();
      return ["text", "search", "url", "email", "tel"].includes(type) &&
             !el.disabled && !el.readOnly;
    }
    return false;
  }

  function isEditable(el) {
    if (!(el instanceof Element)) return false;
    return isTextControl(el) || !!el.isContentEditable ||
           el.getAttribute("role") === "textbox";
  }

  function editableFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (node instanceof Element && isEditable(node)) return node;
    }

    let el = event.target instanceof Element ? event.target : null;
    while (el) {
      if (isEditable(el)) return el;
      el = el.parentElement;
    }

    const active = document.activeElement;
    return active instanceof Element && isEditable(active) ? active : null;
  }

  function getControlContext(el) {
    let start = el.selectionStart;
    let end = el.selectionEnd;

    if (typeof start !== "number" || typeof end !== "number" || start !== end) {
      return null;
    }

    const before = el.value.slice(0, start);
    const match = before.match(WORD_RE);
    if (!match) return null;

    const word = match[0];
    if (!word || EXCLUDED_RE.test(word)) return null;

    return {
      kind: "control",
      el,
      word,
      start: start - word.length,
      end: start
    };
  }

  function findContentEditableTextContext(root) {
    const sel = root.ownerDocument?.getSelection?.() || window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;

    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    let offset = range.startOffset;

    // Typical contenteditable case: caret is directly inside a text node.
    if (node.nodeType === Node.TEXT_NODE) {
      const before = node.textContent.slice(0, offset);
      const match = before.match(WORD_RE);
      if (!match) return null;
      const word = match[0];
      if (EXCLUDED_RE.test(word)) return null;

      return {
        kind: "contenteditable",
        el: root,
        node,
        word,
        start: offset - word.length,
        end: offset
      };
    }

    // If the caret is on the element itself, inspect the nearest text node before it.
    if (node.nodeType === Node.ELEMENT_NODE) {
      const container = node;
      const child = container.childNodes[Math.max(0, offset - 1)];
      let textNode = null;

      if (child?.nodeType === Node.TEXT_NODE) {
        textNode = child;
      } else if (child instanceof Element) {
        const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) textNode = walker.currentNode;
      }

      if (textNode) {
        const before = textNode.textContent;
        const match = before.match(WORD_RE);
        if (!match) return null;
        const word = match[0];
        if (EXCLUDED_RE.test(word)) return null;

        return {
          kind: "contenteditable",
          el: root,
          node: textNode,
          word,
          start: textNode.textContent.length - word.length,
          end: textNode.textContent.length
        };
      }
    }

    return null;
  }

  function getContext(el) {
    if (!el) return null;

    if (isTextControl(el)) {
      return getControlContext(el);
    }

    if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
      return findContentEditableTextContext(el);
    }

    return null;
  }

  function contextValid(ctx) {
    if (!ctx?.el?.isConnected) return false;

    if (ctx.kind === "control") {
      const pos = ctx.el.selectionStart;
      return pos === ctx.end &&
             ctx.el.value.slice(ctx.start, ctx.end) === ctx.word;
    }

    if (ctx.kind === "contenteditable") {
      if (!ctx.node?.isConnected) return false;
      return ctx.node.textContent.slice(ctx.start, ctx.end) === ctx.word;
    }

    return false;
  }

  function fireInput(el, insertedText) {
    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: insertedText
      }));
    } catch (_) {
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
  }

  function replaceContext(ctx, replacement, suffix = "") {
    if (!ctx || !replacement) return false;
    const insert = replacement + suffix;

    if (ctx.kind === "control") {
      const el = ctx.el;
      const old = el.value;

      // Use the native value setter. This works better with React-controlled
      // inputs than assigning el.value directly.
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

      const next = old.slice(0, ctx.start) + insert + old.slice(ctx.end);

      if (setter) setter.call(el, next);
      else el.value = next;

      const caret = ctx.start + insert.length;
      try { el.setSelectionRange(caret, caret); } catch (_) {}

      fireInput(el, insert);
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    }

    if (ctx.kind === "contenteditable") {
      const node = ctx.node;
      const range = document.createRange();
      range.setStart(node, ctx.start);
      range.setEnd(node, ctx.end);
      range.deleteContents();

      const inserted = document.createTextNode(insert);
      range.insertNode(inserted);

      const sel = window.getSelection();
      const after = document.createRange();
      after.setStart(inserted, inserted.textContent.length);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);

      fireInput(ctx.el, insert);
      ctx.el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    }

    return false;
  }

  function insertTextAtCaret(el, text) {
    if (!el || !text) return false;

    if (isTextControl(el)) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (typeof start !== "number" || typeof end !== "number") return false;

      const old = el.value;
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const next = old.slice(0, start) + text + old.slice(end);

      if (setter) setter.call(el, next);
      else el.value = next;

      const caret = start + text.length;
      try { el.setSelectionRange(caret, caret); } catch (_) {}

      fireInput(el, text);
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    }

    if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
      const sel = el.ownerDocument?.getSelection?.() || window.getSelection();
      if (!sel || !sel.rangeCount) return false;

      const range = sel.getRangeAt(0);
      range.deleteContents();
      const inserted = document.createTextNode(text);
      range.insertNode(inserted);

      const after = document.createRange();
      after.setStart(inserted, inserted.textContent.length);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);

      fireInput(el, text);
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    }

    return false;
  }

  function ensureUI() {
    if (!document.documentElement) return;

    if (!STATE.popup) {
      const popup = document.createElement("div");
      popup.id = "yamli-anywhere-popup-v2";
      popup.hidden = true;
      popup.setAttribute("role", "listbox");

      const header = document.createElement("div");
      header.className = "yamli-anywhere-header";
      header.textContent = "Yamli";

      const list = document.createElement("div");
      list.className = "yamli-anywhere-list";

      popup.append(header, list);
      (document.body || document.documentElement).appendChild(popup);

      STATE.popup = popup;
      STATE.list = list;
    }

    if (!STATE.toast) {
      const toast = document.createElement("div");
      toast.id = "yamli-anywhere-toast-v2";
      (document.body || document.documentElement).appendChild(toast);
      STATE.toast = toast;
    }
  }

  function showToast(message, isError = false, duration = 1800) {
    ensureUI();
    if (!STATE.toast) return;
    STATE.toast.textContent = message;
    STATE.toast.classList.toggle("error", !!isError);
    STATE.toast.classList.add("show");

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      STATE.toast?.classList.remove("show");
    }, duration);
  }
  globalThis.__yamliAnywhereV2ShowToast = showToast;

  function markLatinAsChosen(ctx) {
    if (!ctx) return;
    STATE.latinBypass = {
      kind: ctx.kind,
      el: ctx.el,
      node: ctx.node || null,
      word: ctx.word,
      start: ctx.start,
      end: ctx.end
    };
  }

  function latinBypassStillValid(el) {
    const b = STATE.latinBypass;
    if (!b || b.el !== el || !b.el?.isConnected) return false;

    if (b.kind === "control") {
      const pos = b.el.selectionStart;
      return pos === b.end &&
             b.el.value.slice(b.start, b.end) === b.word;
    }

    if (b.kind === "contenteditable") {
      return !!b.node?.isConnected &&
             b.node.textContent.slice(b.start, b.end) === b.word;
    }

    return false;
  }

  function hidePopup() {
    STATE.candidates = [];
    STATE.selectedIndex = 0;
    STATE.context = null;
    if (STATE.popup) STATE.popup.hidden = true;
  }

  function positionPopup(ctx) {
    ensureUI();
    if (!STATE.popup || !ctx?.el) return;

    let rect = null;

    if (ctx.kind === "contenteditable") {
      try {
        const r = document.createRange();
        r.setStart(ctx.node, ctx.end);
        r.collapse(true);
        rect = r.getBoundingClientRect();
      } catch (_) {}
    }

    if (!rect || (!rect.width && !rect.height)) {
      rect = ctx.el.getBoundingClientRect();
    }

    const width = Math.min(320, Math.max(230, rect.width || 230));
    const margin = 8;

    STATE.popup.style.width = `${width}px`;
    STATE.popup.style.left = `${Math.max(
      margin,
      Math.min(window.innerWidth - width - margin, rect.left)
    )}px`;
    STATE.popup.style.top = `${Math.min(
      window.innerHeight - 80,
      rect.bottom + 7
    )}px`;

    requestAnimationFrame(() => {
      const p = STATE.popup?.getBoundingClientRect();
      if (!p) return;
      if (p.bottom > window.innerHeight - margin) {
        STATE.popup.style.top = `${Math.max(
          margin,
          rect.top - p.height - 7
        )}px`;
      }
    });
  }

  function renderPopup() {
    ensureUI();
    if (!STATE.popup || !STATE.list) return;

    STATE.list.replaceChildren();

    STATE.candidates.slice(0, 10).forEach((candidate, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "yamli-anywhere-candidate" +
        (index === STATE.selectedIndex ? " selected" : "");
      row.dataset.index = String(index);

      const num = document.createElement("span");
      num.className = "yamli-anywhere-number";
      // Latin stays unnumbered; Arabic candidates are numbered 1–9.
      num.textContent = index === 0 ? "" : String(index);

      const text = document.createElement("span");
      text.className = index === 0
        ? "yamli-anywhere-latin"
        : "yamli-anywhere-arabic";
      text.dir = index === 0 ? "ltr" : "rtl";
      text.textContent = candidate;

      row.append(num, text);

      row.addEventListener("mousedown", event => {
        event.preventDefault();
        event.stopPropagation();

        if (STATE.context && contextValid(STATE.context)) {
          if (index === 0) {
            // Keep the original Latin word. The next Space is allowed through.
            markLatinAsChosen(STATE.context);
          } else {
            replaceContext(STATE.context, candidate);
            STATE.latinBypass = null;
          }
        }
        hidePopup();
      });

      STATE.list.appendChild(row);
    });

    STATE.popup.hidden = !STATE.candidates.length;
  }

  async function requestCandidates(ctx, { commitSpace = false, commitSuffix = null } = {}) {
    if (!STATE.enabled || !ctx?.word) return false;

    const serial = ++STATE.serial;
    STATE.context = ctx;

    return await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: "yamli-transliterate",
        word: ctx.word,
        pageInfo: pageInfo()
      }, response => {
        if (serial !== STATE.serial) {
          resolve(false);
          return;
        }

        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message;
          if (!STATE.apiErrorShown) {
            showToast(`Yamli extension error: ${message}`, true, 4500);
            STATE.apiErrorShown = true;
          }
          resolve(false);
          return;
        }

        if (!response?.ok) {
          if (!STATE.apiErrorShown) {
            showToast(`Yamli API: ${response?.error || "request failed"}`, true, 4500);
            STATE.apiErrorShown = true;
          }
          resolve(false);
          return;
        }

        STATE.apiErrorShown = false;
        const candidates = Array.isArray(response.items)
          ? response.items.map(x => x?.trans).filter(Boolean)
          : [];

        if (!candidates.length) {
          resolve(false);
          return;
        }

        // Space and punctuation can commit the best result immediately.
        const immediateSuffix = commitSuffix !== null
          ? commitSuffix
          : (commitSpace ? " " : null);

        if (immediateSuffix !== null) {
          if (contextValid(ctx)) {
            replaceContext(ctx, candidates[0], immediateSuffix);
            STATE.latinBypass = null;
            hidePopup();
            resolve(true);
            return;
          }
          resolve(false);
          return;
        }

        if (!contextValid(ctx)) {
          resolve(false);
          return;
        }

        STATE.context = ctx;
        // Match the Yamli website: original Latin input first, while the
        // first Arabic candidate is highlighted by default.
        STATE.candidates = [
          ctx.word,
          ...[...new Set(candidates)].filter(candidate => candidate !== ctx.word)
        ];
        STATE.selectedIndex = STATE.candidates.length > 1 ? 1 : 0;
        renderPopup();
        positionPopup(ctx);
        resolve(true);
      });
    });
  }

  function scheduleCandidates(el) {
    clearTimeout(STATE.debounce);
    STATE.debounce = setTimeout(() => {
      const ctx = getContext(el);
      if (!ctx) {
        hidePopup();
        return;
      }
      requestCandidates(ctx);
    }, 120);
  }

  document.addEventListener("input", event => {
    if (!STATE.enabled) return;
    const el = editableFromEvent(event);
    if (!el) return;
    scheduleCandidates(el);
  }, true);

  document.addEventListener("keyup", event => {
    if (!STATE.enabled) return;
    if (["ArrowUp", "ArrowDown", "Enter", "Escape", " "].includes(event.key)) return;
    const el = editableFromEvent(event);
    if (!el) return;
    // Some framework editors swallow/replace input events; keyup is a fallback.
    scheduleCandidates(el);
  }, true);

  document.addEventListener("keydown", event => {
    if (!STATE.enabled) return;
    const el = editableFromEvent(event);
    if (!el) return;

    const mappedPunctuation = (!event.ctrlKey && !event.altKey && !event.metaKey)
      ? PUNCTUATION_MAP[event.key]
      : undefined;

    if (STATE.latinBypass && event.key !== " " && !mappedPunctuation &&
        !["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
      STATE.latinBypass = null;
    }

    if (STATE.popup && !STATE.popup.hidden && STATE.candidates.length && STATE.context) {
      const count = Math.min(STATE.candidates.length, 10);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        STATE.selectedIndex = (STATE.selectedIndex + 1) % count;
        renderPopup();
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        STATE.selectedIndex = (STATE.selectedIndex - 1 + count) % count;
        renderPopup();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hidePopup();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (contextValid(STATE.context)) {
          if (STATE.selectedIndex === 0) {
            markLatinAsChosen(STATE.context);
          } else {
            replaceContext(STATE.context, STATE.candidates[STATE.selectedIndex]);
            STATE.latinBypass = null;
          }
        }
        hidePopup();
        return;
      }

      // 1–9 select Arabic candidates. The Latin row is not numbered.
      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key);
        if (index < count) {
          event.preventDefault();
          event.stopPropagation();
          if (contextValid(STATE.context)) {
            replaceContext(STATE.context, STATE.candidates[index]);
            STATE.latinBypass = null;
          }
          hidePopup();
          return;
        }
      }

      if (mappedPunctuation) {
        event.preventDefault();
        event.stopPropagation();
        if (contextValid(STATE.context)) {
          if (STATE.selectedIndex === 0) {
            // Latin candidate selected: keep the Latin word but use Arabic punctuation.
            replaceContext(STATE.context, STATE.context.word, mappedPunctuation);
          } else {
            replaceContext(
              STATE.context,
              STATE.candidates[STATE.selectedIndex],
              mappedPunctuation
            );
          }
          STATE.latinBypass = null;
        }
        hidePopup();
        return;
      }

      if (event.key === " " && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (contextValid(STATE.context)) {
          if (STATE.selectedIndex === 0) {
            // Explicitly selected Latin: keep it and add the space.
            replaceContext(STATE.context, STATE.context.word, " ");
          } else {
            // Normal Yamli behaviour: first Arabic candidate is selected by default.
            replaceContext(
              STATE.context,
              STATE.candidates[STATE.selectedIndex],
              " "
            );
          }
          STATE.latinBypass = null;
        }
        hidePopup();
        return;
      }
    }

    // Punctuation behaves like a word terminator. If a Latin/Arabizi word is
    // still active, transliterate it first and append Arabic punctuation.
    if (mappedPunctuation) {
      event.preventDefault();
      event.stopPropagation();

      // If the user explicitly chose the Latin candidate, keep that word Latin.
      if (latinBypassStillValid(el)) {
        const ctx = STATE.latinBypass;
        STATE.latinBypass = null;
        replaceContext(ctx, ctx.word, mappedPunctuation);
        hidePopup();
        return;
      }

      const ctx = getContext(el);
      if (ctx) {
        requestCandidates(ctx, { commitSuffix: mappedPunctuation }).then(committed => {
          if (!committed && contextValid(ctx)) {
            // If Yamli is unavailable, preserve what the user typed and still
            // convert the punctuation.
            replaceContext(ctx, ctx.word, mappedPunctuation);
          }
        });
      } else {
        // The preceding text is already Arabic (or there is no word), so only
        // insert/convert the punctuation at the current caret position.
        insertTextAtCaret(el, mappedPunctuation);
      }
      return;
    }

    // If the Latin candidate was clicked, let the next Space pass through
    // normally instead of re-transliterating the same word.
    if (event.key === " " && !event.shiftKey && latinBypassStillValid(el)) {
      STATE.latinBypass = null;
      hidePopup();
      return;
    }

    // Crucial Label Studio / fast-typing fallback:
    // if the user hits Space before the popup request has finished,
    // hold the Space briefly and ask Yamli immediately.
    if (event.key === " " && !event.shiftKey) {
      const ctx = getContext(el);
      if (ctx) {
        event.preventDefault();
        event.stopPropagation();

        requestCandidates(ctx, { commitSpace: true }).then(committed => {
          if (!committed) {
            // Yamli failed or had no candidate: do not eat the user's space.
            if (ctx.kind === "control") {
              if (contextValid(ctx)) replaceContext(ctx, ctx.word, " ");
            } else if (ctx.kind === "contenteditable" && contextValid(ctx)) {
              replaceContext(ctx, ctx.word, " ");
            }
          }
        });
      }
    }
  }, true);

  document.addEventListener("mousedown", event => {
    if (STATE.popup && !STATE.popup.contains(event.target)) {
      hidePopup();
    }
  }, true);

  window.addEventListener("blur", hidePopup);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "yamli-ping") {
      sendResponse({
        ok: true,
        frameUrl: location.href,
        enabled: STATE.enabled,
        loadedAt: STATE.readyAt
      });
      return;
    }

    if (message?.type === "yamli-state") {
      STATE.enabled = !!message.enabled;
      hidePopup();
      showToast(STATE.enabled ? "Yamli: ON" : "Yamli: OFF");
      sendResponse({ ok: true });
    }
  });

  chrome.runtime.sendMessage({ type: "yamli-get-state" }, response => {
    if (response?.ok) STATE.enabled = !!response.enabled;
  });

  // This is intentionally visible in v0.2 so page injection is obvious.
  setTimeout(() => {
    showToast("Yamli Anywhere loaded ✓", false, 1400);
  }, 250);
})();
