const DEFAULT_ENABLED = true;

async function getEnabled() {
  const { enabled = DEFAULT_ENABLED } = await chrome.storage.local.get("enabled");
  return !!enabled;
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ enabled: !!enabled });
  await updateBadge(!!enabled);

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "yamli-state",
        enabled: !!enabled
      });
    } catch (_) {
      // Expected for chrome:// pages and tabs where the content script is absent.
    }
  }
  return !!enabled;
}

async function updateBadge(enabled) {
  await chrome.action.setBadgeText({ text: enabled ? "AR" : "" });
  if (enabled) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  }
}



let sxhrCounter = 1;

function parseYamliSXHR(word, raw) {
  const cleaned = String(raw ?? "").replace(/^\uFEFF/, "").trim();

  if (!cleaned) {
    throw new Error("Yamli returned an empty response.");
  }

  const marker = "Yamli.I.SXHRData.dataCallback(";
  const markerIndex = cleaned.indexOf(marker);
  let payload = null;

  if (markerIndex >= 0) {
    const objectStart = cleaned.indexOf("{", markerIndex + marker.length);
    if (objectStart < 0) {
      throw new Error("Yamli SXHR wrapper was present, but its payload was missing.");
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let objectEnd = -1;

    for (let i = objectStart; i < cleaned.length; i++) {
      const ch = cleaned[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          objectEnd = i;
          break;
        }
      }
    }

    if (objectEnd < 0) {
      throw new Error("Could not find the end of Yamli's SXHR payload.");
    }

    const outerText = cleaned.slice(objectStart, objectEnd + 1);

    let outer;
    try {
      outer = JSON.parse(outerText);
    } catch (err) {
      throw new Error(
        "Could not parse Yamli's outer SXHR object: " +
        (err?.message || String(err))
      );
    }

    if (typeof outer?.data !== "string") {
      throw new Error("Yamli SXHR response did not contain a string data field.");
    }

    try {
      payload = JSON.parse(outer.data);
    } catch (err) {
      throw new Error(
        "Could not parse Yamli's inner transliteration JSON: " +
        (err?.message || String(err))
      );
    }
  }

  if (!payload) {
    try {
      const parsed = JSON.parse(cleaned);
      payload = typeof parsed?.data === "string"
        ? JSON.parse(parsed.data)
        : parsed;
    } catch (_) {}
  }

  if (!payload || typeof payload !== "object") {
    const preview = cleaned.replace(/\s+/g, " ").slice(0, 260);
    throw new Error(
      "Unrecognised Yamli response. Raw response starts with: " + preview
    );
  }

  if (payload.staleClient) {
    throw new Error(
      "Yamli rejected the client build" +
      (payload.serverBuild ? ` (server build ${payload.serverBuild})` : "") +
      "."
    );
  }

  const roman = typeof payload.w === "string" ? payload.w : word;
  const packed = typeof payload.r === "string" ? payload.r : "";

  const items = packed
    .split("|")
    .map(part => {
      const slash = part.lastIndexOf("/");
      const trans = (slash >= 0 ? part.slice(0, slash) : part).trim();
      const type = slash >= 0 ? Number(part.slice(slash + 1)) || 0 : 0;
      return trans ? { trans, type } : null;
    })
    .filter(Boolean);

  return {
    roman,
    items,
    serverBuild: payload.serverBuild || null
  };
}

async function requestYamli(word) {
  word = String(word || "").trim();
  if (!word) throw new Error("No word supplied.");

  // Exact parameters captured from the working yamli.com client.
  const requestId = String(sxhrCounter++);

  const params = new URLSearchParams();
  params.set("word", word);
  params.set("tool", "api");
  params.set("account_id", "000006");
  params.set("prot", "https:");
  params.set("hostname", "www.yamli.com");
  params.set("path", "/");
  params.set("build", "5515");
  params.set("sxhr_id", requestId);

  const url =
    "https://api.yamli.com/transliterate.ashx?" + params.toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let response;
  let raw = "";

  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { "Accept": "*/*" },
      signal: controller.signal
    });

    raw = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const preview = raw.replace(/\s+/g, " ").slice(0, 220);
    throw new Error(
      `Yamli returned HTTP ${response.status}` +
      (preview ? ` — ${preview}` : "")
    );
  }

  const parsed = parseYamliSXHR(word, raw);

  if (!parsed.items.length) {
    throw new Error(
      `Yamli replied successfully but returned no candidates for "${word}".`
    );
  }

  return {
    ok: true,
    roman: parsed.roman,
    items: parsed.items,
    serverBuild: parsed.serverBuild,
    requestId,
    rawLength: raw.length,
    protocol: "Yamli SXHR / build 5515"
  };
}

async function injectIntoTab(tabId) {
  if (!tabId) throw new Error("No active tab.");

  // Inject CSS first. It is harmless if already present.
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["styles.css"]
    });
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
  } catch (err) {
    throw new Error(
      "Chrome would not allow injection into this page. " +
      (err?.message || String(err))
    );
  }
}

async function pingTab(tabId) {
  if (!tabId) return { ok: false, reason: "No active tab." };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "yamli-ping" });
    return response?.ok ? response : { ok: false, reason: "No response." };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get("enabled");
  if (typeof current.enabled !== "boolean") {
    await chrome.storage.local.set({ enabled: DEFAULT_ENABLED });
  }
  await updateBadge(await getEnabled());
});

chrome.runtime.onStartup.addListener(async () => {
  await updateBadge(await getEnabled());
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== "toggle-yamli") return;
  await setEnabled(!(await getEnabled()));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "yamli-get-state":
        return { ok: true, enabled: await getEnabled() };

      case "yamli-set-state":
        return { ok: true, enabled: await setEnabled(!!message.enabled) };

      case "yamli-transliterate":
        return await requestYamli(message.word);

      case "yamli-api-test": {
        const result = await requestYamli("salam");
        return {
          ok: true,
          candidates: result.items.slice(0, 5).map(x => x.trans),
          protocol: result.protocol,
          serverBuild: result.serverBuild,
          rawLength: result.rawLength
        };
      }

      case "yamli-inject": {
        await injectIntoTab(message.tabId);
        // Give the script a moment to initialise before pinging it.
        await new Promise(r => setTimeout(r, 120));
        return await pingTab(message.tabId);
      }

      case "yamli-ping-tab":
        return await pingTab(message.tabId);

      default:
        return { ok: false, error: "Unknown request." };
    }
  })()
    .then(sendResponse)
    .catch(err => {
      sendResponse({
        ok: false,
        error: err?.message || String(err)
      });
    });

  return true;
});
