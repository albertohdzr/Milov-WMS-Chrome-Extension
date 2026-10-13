// ============================================================================
// Service worker — único punto de red de la extensión.
//
// El content script NUNCA ve la API key: pide el enriquecimiento por mensaje
// y este worker hace el fetch a milov-app con Authorization: Bearer.
// Cache en memoria con TTL corto para absorber re-renders de la tabla.
// ============================================================================

const DEFAULT_API_BASE = "https://milov-web-app.vercel.app";
const ENRICH_PATH = "/api/sales-order-planning/enrich";
const PLANNING_PATH = "/api/sales-order-planning";
const PLANNING_OPTIONS_PATH = "/api/sales-order-planning/extension-options";
const CACHE_TTL_MS = 2 * 60 * 1000;

// so_number -> { at: epoch_ms, data: SalesOrderEnrichment | null }
const cache = new Map();

async function getSettings() {
  const stored = await chrome.storage.local.get(["apiBase", "apiKey"]);
  return {
    apiBase: (stored.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ""),
    apiKey: stored.apiKey || "",
  };
}

async function fetchEnrichment(soNumbers, settings) {
  const response = await fetch(settings.apiBase + ENRICH_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ sales_order_numbers: soNumbers }),
  });

  if (response.status === 401 || response.status === 403) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, code: "AUTH", error: body.error || "API key inválida o revocada" };
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, code: "HTTP", error: body.error || `Error ${response.status}` };
  }

  const body = await response.json();
  return { ok: true, salesOrders: body.sales_orders || {}, missing: body.missing || [] };
}

async function apiRequest(path, settings, options = {}) {
  const response = await fetch(settings.apiBase + path, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${settings.apiKey}`,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const body = await response.json().catch(() => ({}));

  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: "AUTH", error: body.error || "API key inválida o sin permiso para planificar waves" };
  }
  if (!response.ok) {
    return { ok: false, code: "HTTP", error: body.error || `Error ${response.status}` };
  }
  return { ok: true, ...body };
}

async function handleEnrich(soNumbers) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, code: "NO_KEY", error: "Configura la API key en las opciones de la extensión." };
  }

  const now = Date.now();
  const result = {};
  const toFetch = [];
  for (const so of soNumbers) {
    const hit = cache.get(so);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      if (hit.data) result[so] = hit.data;
    } else {
      toFetch.push(so);
    }
  }

  if (toFetch.length > 0) {
    // La API admite 300 SO por consulta; no cachear como ausentes las restantes.
    for (let offset = 0; offset < toFetch.length; offset += 300) {
      const batch = toFetch.slice(offset, offset + 300);
      const fetched = await fetchEnrichment(batch, settings);
      if (!fetched.ok) return fetched;
      for (const so of batch) {
        const data = fetched.salesOrders[so] || null;
        cache.set(so, { at: now, data });
        if (data) result[so] = data;
      }
    }
  }

  return { ok: true, salesOrders: result };
}

async function handleTestConnection(overrides) {
  const settings = await getSettings();
  if (overrides?.apiBase) settings.apiBase = overrides.apiBase.replace(/\/+$/, "");
  if (overrides?.apiKey) settings.apiKey = overrides.apiKey;
  if (!settings.apiKey) {
    return { ok: false, code: "NO_KEY", error: "Falta la API key." };
  }
  try {
    // SO-1 no existe: si la respuesta es 200 la autenticación funcionó.
    const probe = await fetchEnrichment(["SO-1"], settings);
    if (!probe.ok) return probe;
    return { ok: true };
  } catch (err) {
    return { ok: false, code: "NETWORK", error: `No se pudo conectar: ${err.message}` };
  }
}

async function handlePlanningOptions(date) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, code: "NO_KEY", error: "Configura la API key en las opciones de la extensión." };
  }
  const query = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? `?date=${date}` : "";
  return apiRequest(PLANNING_OPTIONS_PATH + query, settings);
}

async function handlePlanWave(payload) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, code: "NO_KEY", error: "Configura la API key en las opciones de la extensión." };
  }

  const response = await apiRequest(PLANNING_PATH, settings, {
    method: "POST",
    body: {
      sales_order_numbers: Array.isArray(payload?.soNumbers) ? payload.soNumbers : [],
      scheduled_date: payload?.scheduledDate,
      driver_id: payload?.driverId || null,
      vehicle_id: payload?.vehicleId || null,
      route_id: payload?.routeId || null,
      ola_id: payload?.olaId || null,
      confirm_over_capacity: payload?.confirmOverCapacity === true,
      notes: "Creada desde Komodin al generar wave",
    },
  });

  if (response.ok) {
    for (const so of payload?.soNumbers || []) cache.delete(so);
  }
  return response;
}

async function handleExportOla(payload) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, code: "NO_KEY", error: "Configura la API key en las opciones de la extensión." };
  }
  if (typeof payload?.olaId !== "string" || !payload.olaId.trim() || !["routes", "frozen"].includes(payload.report)) {
    return { ok: false, code: "INPUT", error: "Falta la OLA o el tipo de reporte." };
  }
  const response = await fetch(settings.apiBase + PLANNING_PATH + "/export-xlsx", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ ola_ids: [payload.olaId], report: payload.report }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, code: "HTTP", error: body.error || `No se pudo generar el Excel (${response.status})` };
  }
  const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (!response.headers.get("Content-Type")?.includes(mime)) {
    return { ok: false, code: "HTTP", error: "Milov no devolvió un archivo Excel. Verifica que la aplicación esté actualizada." };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const suggested = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1];
  const filename = (suggested || `OLA-${payload.report}.xlsx`).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_");
  // MV3 workers no tienen URL.createObjectURL. La descarga queda a cargo de
  // Chrome antes de que Komodin navegue y destruya el content script.
  const downloadId = await chrome.downloads.download({
    url: `data:${mime};base64,${btoa(binary)}`,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
  return { ok: true, downloadId };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MLV_EXPORT_OLA") {
    handleExportOla(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, code: "DOWNLOAD", error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "MLV_ENRICH") {
    handleEnrich(Array.isArray(message.soNumbers) ? message.soNumbers : [])
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, code: "NETWORK", error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "MLV_TEST_CONNECTION") {
    handleTestConnection(message.overrides).then(sendResponse);
    return true;
  }
  if (message?.type === "MLV_PLANNING_OPTIONS") {
    handlePlanningOptions(message.date)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, code: "NETWORK", error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "MLV_PLAN_WAVE") {
    handlePlanWave(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, code: "NETWORK", error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "MLV_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
