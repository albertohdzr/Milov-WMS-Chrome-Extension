const DEFAULT_API_BASE = "https://milov-web-app.vercel.app";

const apiBaseInput = document.getElementById("apiBase");
const apiKeyInput = document.getElementById("apiKey");
const statusEl = document.getElementById("status");

async function load() {
  const stored = await chrome.storage.local.get(["apiBase", "apiKey"]);
  apiBaseInput.value = stored.apiBase || DEFAULT_API_BASE;
  apiKeyInput.value = stored.apiKey || "";
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
}

document.getElementById("save").addEventListener("click", async () => {
  const apiBase = apiBaseInput.value.trim().replace(/\/+$/, "") || DEFAULT_API_BASE;
  const apiKey = apiKeyInput.value.trim();
  await chrome.storage.local.set({ apiBase, apiKey });
  setStatus("Guardado. Recarga la página del WMS para aplicar.", true);
});

document.getElementById("test").addEventListener("click", async () => {
  setStatus("Probando…", true);
  const response = await chrome.runtime.sendMessage({
    type: "MLV_TEST_CONNECTION",
    overrides: {
      apiBase: apiBaseInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
    },
  });
  if (response?.ok) {
    setStatus("Conexión y API key válidas ✔", true);
  } else {
    setStatus(response?.error || "Error desconocido", false);
  }
});

load();
