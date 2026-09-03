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
    const fetched = await fetchEnrichment(toFetch, settings);
    if (!fetched.ok) return fetched;
    for (const so of toFetch) {
      const data = fetched.salesOrders[so] || null;
      cache.set(so, { at: now, data });
      if (data) result[so] = data;
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

async function handlePlanningOptions() {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, code: "NO_KEY", error: "Configura la API key en las opciones de la extensión." };
  }
  return apiRequest(PLANNING_OPTIONS_PATH, settings);
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
      driver_id: payload?.driverId,
      route_id: payload?.routeId || null,
      notes: "Creada desde Komodin al generar wave",
    },
  });

  if (response.ok) {
    for (const so of payload?.soNumbers || []) cache.delete(so);
  }
  return response;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    handlePlanningOptions()
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
