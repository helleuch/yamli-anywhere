const enabled = document.getElementById("enabled");
const pageStatus = document.getElementById("pageStatus");
const apiStatus = document.getElementById("apiStatus");
const inject = document.getElementById("inject");
const testApi = document.getElementById("testApi");

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.classList.remove("good", "bad");
  if (kind) el.classList.add(kind);
}

async function send(message) {
  return await chrome.runtime.sendMessage(message);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshPageStatus() {
  const tab = await activeTab();
  if (!tab?.id) {
    setStatus(pageStatus, "No active tab.", "bad");
    return;
  }

  if (!/^https?:/i.test(tab.url || "")) {
    setStatus(pageStatus, "Chrome blocks extensions on this type of page.", "bad");
    inject.disabled = true;
    return;
  }

  const result = await send({ type: "yamli-ping-tab", tabId: tab.id });
  if (result?.ok) {
    setStatus(pageStatus, "Connected ✓ — typing hook is loaded.", "good");
  } else {
    setStatus(pageStatus, "Not connected yet. Click the button below.", "bad");
  }
}

enabled.addEventListener("change", async () => {
  const result = await send({
    type: "yamli-set-state",
    enabled: enabled.checked
  });
  if (!result?.ok) {
    enabled.checked = !enabled.checked;
  }
});

inject.addEventListener("click", async () => {
  inject.disabled = true;
  setStatus(pageStatus, "Injecting…");

  try {
    const tab = await activeTab();
    const result = await send({ type: "yamli-inject", tabId: tab?.id });

    if (result?.ok) {
      setStatus(pageStatus, "Connected ✓ — this page is ready.", "good");
    } else {
      setStatus(
        pageStatus,
        `Could not connect: ${result?.error || result?.reason || "unknown error"}`,
        "bad"
      );
    }
  } catch (err) {
    setStatus(pageStatus, `Injection failed: ${err.message}`, "bad");
  } finally {
    inject.disabled = false;
  }
});

testApi.addEventListener("click", async () => {
  testApi.disabled = true;
  setStatus(apiStatus, "Contacting Yamli…");

  try {
    const result = await send({ type: "yamli-api-test" });

    if (result?.ok) {
      setStatus(
        apiStatus,
        `Working ✓ — ${result.protocol || "Yamli"}\nsalam → ${result.candidates.join(" · ")}`,
        "good"
      );
    } else {
      setStatus(apiStatus, `Failed: ${result?.error || "unknown error"}`, "bad");
    }
  } catch (err) {
    setStatus(apiStatus, `Failed: ${err.message}`, "bad");
  } finally {
    testApi.disabled = false;
  }
});

(async () => {
  const state = await send({ type: "yamli-get-state" });
  enabled.checked = state?.ok ? !!state.enabled : true;
  await refreshPageStatus();
})();
