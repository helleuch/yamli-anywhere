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

  // Only characters whose Arabic glyph differs from the Latin one.
  // Other punctuation (., :, !) is left to the browser/editor unchanged.
  const PUNCTUATION_MAP = {
    ',': '،',
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
    if (!b) return false;

    if (b.el === el && b.el?.isConnected) {
      if (b.kind === "control") {
        const pos = b.el.selectionStart;
        if (pos === b.end && b.el.value.slice(b.start, b.end) === b.word) {
          return true;
        }
      }

      if (b.kind === "contenteditable" && b.node?.isConnected &&
          b.node.textContent.slice(b.start, b.end) === b.word) {
        return true;
      }
    }

    // Framework editors can recreate the underlying input/text node. Recover
    // the Latin choice from the word immediately before the current caret.
    const current = getContext(el);
    if (current && current.word === b.word) {
      STATE.latinBypass = {
        kind: current.kind,
        el: current.el,
        node: current.node || null,
        word: current.word,
        start: current.start,
        end: current.end
      };
      return true;
    }

    return false;
  }

  function restoreEditorFocus(ctx) {
    if (!ctx?.el?.isConnected) return;

    try {
      ctx.el.focus({ preventScroll: true });
    } catch (_) {
      try { ctx.el.focus(); } catch (_) {}
    }

    if (ctx.kind === "control") {
      const caret = Math.min(ctx.end, ctx.el.value.length);
      try { ctx.el.setSelectionRange(caret, caret); } catch (_) {}
      return;
    }

    if (ctx.kind === "contenteditable" && ctx.node?.isConnected) {
      const caret = Math.min(ctx.end, ctx.node.textContent.length);
      const range = document.createRange();
      range.setStart(ctx.node, caret);
      range.collapse(true);
      const sel = ctx.el.ownerDocument?.getSelection?.() || window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  function hidePopup() {
    // Invalidate any Yamli request that was started before the popup was
    // dismissed. Without this, a late response can reopen the popup after the
    // user has explicitly chosen the Latin option.
    STATE.serial += 1;
    clearTimeout(STATE.debounce);
    STATE.debounce = null;

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
      // A candidate is deliberately not a <button>: clicking a button can steal
      // focus from editors such as Label Studio, after which Space no longer
      // goes into the transcription field.
      const row = document.createElement("div");
      row.setAttribute("role", "option");
      row.tabIndex = -1;
      row.className = "yamli-anywhere-candidate" +
        (index === STATE.selectedIndex ? " selected" : "");
      row.dataset.index = String(index);

      const text = document.createElement("span");
      text.className = index === 0
        ? "yamli-anywhere-latin"
        : "yamli-anywhere-arabic";
      text.dir = index === 0 ? "ltr" : "rtl";
      text.textContent = candidate;

      row.append(text);

      row.addEventListener("mousedown", event => {
        event.preventDefault();
        event.stopPropagation();

        const chosenContext = STATE.context;
        if (chosenContext && contextValid(chosenContext)) {
          if (index === 0) {
            // Keep the original Latin word and remember that choice until the
            // following separator.
            markLatinAsChosen(chosenContext);
          } else {
            replaceContext(chosenContext, candidate);
            STATE.latinBypass = null;
          }
        }

        hidePopup();

        // Explicitly put focus/caret back in the editor. This is essential for
        // Label Studio, where interacting with the popup can otherwise leave
        // Space routed to the page instead of the transcription field.
        restoreEditorFocus(chosenContext);
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

    // input/beforeinput already handle word terminators and navigation keys.
    if (["ArrowUp", "ArrowDown", "Enter", "Escape", " ", ",", "?"].includes(event.key)) {
      return;
    }

    const el = editableFromEvent(event);
    if (!el) return;

    // Fallback for framework editors that do not reliably expose input events.
    // Number keys are deliberately treated like ordinary characters so Arabizi
    // such as 3, 5, 6, 7, 8 and 9 works normally.
    scheduleCandidates(el);
  }, true);

  document.addEventListener("keydown", event => {
    if (!STATE.enabled) return;
    const el = editableFromEvent(event);
    if (!el) return;

    const isWordTerminator = event.key === " " ||
      Object.prototype.hasOwnProperty.call(PUNCTUATION_MAP, event.key);

    // After the user explicitly chooses the Latin row, Space must always
    // behave like an ordinary word separator. Do this synchronously here,
    // before Label Studio/page shortcuts get a chance to consume the key.
    // There is deliberately no Yamli request on this path.
    if (event.key === " " && STATE.latinBypass && latinBypassStillValid(el)) {
      const inserted = insertTextAtCaret(el, " ");

      if (inserted) {
        event.preventDefault();
        event.stopImmediatePropagation();

        STATE.latinBypass = null;
        hidePopup();
      }

      return;
    }

    // A Latin choice remains committed until the user ends that word with a
    // space/punctuation. If they continue typing the word, allow Yamli to start
    // considering the expanded word again.
    if (STATE.latinBypass && !isWordTerminator &&
        !["Shift", "Control", "Alt", "Meta"].includes(event.key) &&
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) {
      STATE.latinBypass = null;
    }

    if (!(STATE.popup && !STATE.popup.hidden && STATE.candidates.length && STATE.context)) {
      return;
    }

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
          // Keep the original Latin word. Space/punctuation will commit it.
          markLatinAsChosen(STATE.context);
        } else {
          replaceContext(STATE.context, STATE.candidates[STATE.selectedIndex]);
          STATE.latinBypass = null;
        }
      }

      hidePopup();
    }

    // IMPORTANT: number keys are intentionally not intercepted here.
    // They must reach the editor as ordinary characters for Arabizi.
  }, true);

  document.addEventListener("beforeinput", event => {
    if (!STATE.enabled || event.isComposing) return;
    if (event.inputType && event.inputType !== "insertText") return;

    const el = editableFromEvent(event);
    if (!el) return;

    const typed = typeof event.data === "string" ? event.data : "";
    const isSpace = typed === " ";
    const hasArabicPunctuation = Object.prototype.hasOwnProperty.call(PUNCTUATION_MAP, typed);

    if (!isSpace && !hasArabicPunctuation) return;

    // IMPORTANT: never cancel a normal Space while waiting for the network.
    // Losing a separator is much worse than missing one transliteration. We
    // only intercept Space when we already have a visible candidate to commit.

    // 1) The user explicitly chose the Latin row. The word is already exactly
    // as they want it, so Space must be allowed through natively. For Arabic
    // comma/question mark we only replace the punctuation character itself.
    if (latinBypassStillValid(el)) {
      STATE.latinBypass = null;
      hidePopup();

      if (isSpace) {
        // Do not preventDefault(): the editor inserts one ordinary space.
        return;
      }

      if (!event.cancelable) return;
      event.preventDefault();
      event.stopPropagation();
      insertTextAtCaret(el, PUNCTUATION_MAP[typed]);
      return;
    }

    // 2) If Yamli candidates are already visible, committing is synchronous:
    // replace the current word with the highlighted choice and append the
    // separator exactly once.
    if (STATE.popup && !STATE.popup.hidden && STATE.candidates.length &&
        STATE.context && contextValid(STATE.context)) {
      if (!event.cancelable) return;

      event.preventDefault();
      event.stopPropagation();

      const suffix = isSpace ? " " : PUNCTUATION_MAP[typed];
      const replacement = STATE.selectedIndex === 0
        ? STATE.context.word
        : STATE.candidates[STATE.selectedIndex];

      replaceContext(STATE.context, replacement, suffix);
      STATE.latinBypass = null;
      hidePopup();
      return;
    }

    // 3) No ready candidate: Space remains a completely normal editor action.
    // We deliberately do NOT cancel it and then wait for an asynchronous Yamli
    // response; that was the cause of spaces being swallowed in v0.3.3.
    if (isSpace) {
      STATE.latinBypass = null;
      hidePopup();
      return;
    }

    // 4) Arabic comma/question mark can be converted synchronously even when
    // there is no candidate popup. If beforeinput cannot be cancelled, leave
    // the browser/editor untouched rather than risk double insertion.
    if (!event.cancelable) return;

    event.preventDefault();
    event.stopPropagation();
    insertTextAtCaret(el, PUNCTUATION_MAP[typed]);
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
