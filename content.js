// ============================================================================
// Content script — inyección de columnas Milov en la tabla Crear Wave.
//
// La tabla del WMS es HTML plano insertado por jQuery dentro de #prop tras
// "Aplicar Filtros" (POST /wave_new_ajax/). Cada re-render reemplaza el HTML,
// así que un MutationObserver reprocesa la tabla nueva. La columna "Reff"
// trae el número de SO, que es la llave contra milov-app.
// ============================================================================

(() => {
  const SO_RE = /^SO-\d+$/;

  const ADDED_COLUMNS = [
    { key: "ruta", label: "Ruta / Zona" },
    { key: "tipo", label: "Tipo Pedido" },
    { key: "entrega", label: "Fecha Ent." },
    { key: "factura", label: "Factura" },
    { key: "chofer", label: "Chofer" },
    { key: "seco", label: "Cj. Seco", numeric: true },
    { key: "frio", label: "Cj. Frío/Cong", numeric: true },
    { key: "total", label: "Total Cj.", numeric: true },
    { key: "notas", label: "Notas" },
  ];

  const state = {
    filters: { ruta: "", zona: "", chofer: "", tipo: "", search: "" },
    lastData: {},
  };

  let bar = null;
  let processing = false;

  // --------------------------------------------------------------------------
  // Localización de la tabla
  // --------------------------------------------------------------------------

  function findWaveTable() {
    for (const table of document.querySelectorAll("#prop table, table")) {
      const headers = headerCells(table);
      if (headers.some((cell) => cell.textContent.trim().toLowerCase() === "reff")) {
        return table;
      }
    }
    return null;
  }

  function headerCells(table) {
    return table.tHead && table.tHead.rows[0] ? [...table.tHead.rows[0].cells] : [];
  }

  function reffIndex(table) {
    return headerCells(table).findIndex(
      (cell) => cell.textContent.trim().toLowerCase() === "reff"
    );
  }

  // --------------------------------------------------------------------------
  // Render principal
  // --------------------------------------------------------------------------

  async function processTable() {
    if (processing) return;
    const table = findWaveTable();
    if (!table || table.dataset.mlvDone === "1") return;

    const soIndex = reffIndex(table);
    if (soIndex < 0 || !table.tBodies[0]) return;

    processing = true;
    table.dataset.mlvDone = "1";

    try {
      ensureBar(table);
      setBarStatus("Cargando datos Milov…");

      const rows = [...table.tBodies[0].rows];
      const soNumbers = [];
      for (const row of rows) {
        const value = (row.cells[soIndex]?.textContent || "").trim().toUpperCase();
        if (SO_RE.test(value)) soNumbers.push(value);
      }

      injectHeader(table);
      injectPlaceholders(table, soIndex);

      if (soNumbers.length === 0) {
        setBarStatus("Sin SOs en la tabla");
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: "MLV_ENRICH",
        soNumbers,
      });

      if (!response || !response.ok) {
        showError(response);
        return;
      }

      hideError();
      state.lastData = response.salesOrders || {};
      fillRows(table, soIndex, state.lastData);
      rebuildFilterOptions(state.lastData);
      applyFilters(table);
      bindSelectionSummary(table, soIndex);
      updateSelectionSummary(table);
      setBarStatus(`${Object.keys(state.lastData).length}/${soNumbers.length} SOs enriquecidas`);
    } finally {
      processing = false;
    }
  }

  function injectHeader(table) {
    const headRow = table.tHead?.rows[0];
    if (!headRow || headRow.querySelector(".mlv-col")) return;
    for (const col of ADDED_COLUMNS) {
      const th = document.createElement("th");
      th.className = "mlv-col" + (col.numeric ? " mlv-num" : "");
      th.textContent = col.label;
      headRow.appendChild(th);
    }
  }

  function injectPlaceholders(table, soIndex) {
    for (const row of table.tBodies[0].rows) {
      if (row.querySelector(".mlv-cell")) continue;
      for (const col of ADDED_COLUMNS) {
        const td = document.createElement("td");
        td.className = "mlv-cell" + (col.numeric ? " mlv-num" : "");
        td.dataset.mlvKey = col.key;
        td.textContent = "…";
        row.appendChild(td);
      }
      const so = (row.cells[soIndex]?.textContent || "").trim().toUpperCase();
      row.dataset.mlvSo = SO_RE.test(so) ? so : "";
    }
  }

  function fillRows(table, soIndex, data) {
    for (const row of table.tBodies[0].rows) {
      const so = row.dataset.mlvSo;
      const info = so ? data[so] : null;
      const cells = {};
      for (const cell of row.querySelectorAll(".mlv-cell")) {
        cells[cell.dataset.mlvKey] = cell;
      }
      if (!cells.ruta) continue;
      if (!info) {
        for (const key of Object.keys(cells)) cells[key].innerHTML = '<span class="mlv-dim">—</span>';
        setRowFilterData(row, null);
        continue;
      }

      const ruta = info.route?.name || "";
      const zona = info.delivery_route?.name || "";
      cells.ruta.innerHTML = "";
      cells.ruta.appendChild(stacked(ruta || "Sin ruta", zona || "Sin zona"));

      const tipo =
        info.pickup_at_warehouse === true ? "Retira Bod." :
        info.pickup_at_warehouse === false ? "Puerta" : "—";
      cells.tipo.textContent = tipo;

      cells.entrega.innerHTML = "";
      cells.entrega.appendChild(deliveryCell(info));

      cells.factura.innerHTML = "";
      cells.factura.appendChild(invoiceCell(info));

      const chofer = info.driver_name || (info.pickup_at_warehouse ? "Cliente Retira" : null);
      if (chofer) {
        cells.chofer.textContent = chofer;
      } else {
        cells.chofer.innerHTML = '<span class="mlv-dim">Sin asignar</span>';
      }

      const dry = num(info.quantities?.dry);
      const cold = num(info.quantities?.cold) + num(info.quantities?.frozen);
      const total = num(info.quantities?.total);
      cells.seco.textContent = fmtQty(dry);
      cells.frio.textContent = fmtQty(cold);
      cells.total.textContent = fmtQty(total);
      cells.total.classList.add("mlv-strong");

      cells.notas.innerHTML = "";
      if (info.notes) {
        const span = document.createElement("span");
        span.className = "mlv-notes";
        span.textContent = info.notes;
        span.title = info.notes;
        cells.notas.appendChild(span);
      } else {
        cells.notas.innerHTML = '<span class="mlv-dim">—</span>';
      }

      row.dataset.mlvSeco = String(dry);
      row.dataset.mlvFrio = String(cold);
      row.dataset.mlvTotal = String(total);
      setRowFilterData(row, { ruta, zona, chofer: chofer || "", tipo });
    }
  }

  function setRowFilterData(row, values) {
    row.dataset.mlvRuta = values?.ruta || "";
    row.dataset.mlvZona = values?.zona || "";
    row.dataset.mlvChofer = values?.chofer || "";
    row.dataset.mlvTipo = values?.tipo || "";
    row.dataset.mlvSearch = (row.textContent || "").toLowerCase();
  }

  function stacked(top, bottom) {
    const wrap = document.createElement("div");
    const a = document.createElement("div");
    a.className = "mlv-strong";
    a.textContent = top;
    const b = document.createElement("div");
    b.className = "mlv-dim";
    b.textContent = bottom;
    wrap.append(a, b);
    return wrap;
  }

  function deliveryCell(info) {
    const wrap = document.createElement("div");
    const date = document.createElement("div");
    date.textContent = info.delivery_date || "—";
    if (!info.delivery_date) date.className = "mlv-dim";
    wrap.appendChild(date);

    const olaDate = info.ola?.scheduled_date;
    if (info.delivery_date && olaDate && olaDate !== info.delivery_date) {
      const badge = document.createElement("span");
      badge.className = "mlv-badge mlv-badge-red";
      badge.textContent = "Difiere";
      badge.title = `OLA planificada para ${olaDate}, entrega pedida ${info.delivery_date}`;
      wrap.appendChild(badge);
    }
    return wrap;
  }

  function invoiceCell(info) {
    const wrap = document.createElement("div");
    const invoices = Array.isArray(info.invoices) ? info.invoices : [];
    if (invoices.length > 0) {
      const first = document.createElement("div");
      first.textContent = invoices[0].number + (invoices.length > 1 ? ` (+${invoices.length - 1})` : "");
      first.title = invoices.map((inv) => `${inv.number}${inv.status ? ` · ${inv.status}` : ""}`).join("\n");
      wrap.appendChild(first);
    } else {
      const pending = document.createElement("span");
      pending.className = "mlv-dim mlv-italic";
      pending.textContent = "Pendiente";
      wrap.appendChild(pending);
    }
    return wrap;
  }

  // --------------------------------------------------------------------------
  // Barra de filtros + resumen de selección
  // --------------------------------------------------------------------------

  function ensureBar(table) {
    if (bar && document.contains(bar)) return;
    bar = document.createElement("div");
    bar.className = "mlv-bar";
    bar.innerHTML = `
      <div class="mlv-bar-title">Milov</div>
      <label>Ruta <select data-mlv-filter="ruta"><option value="">Todas</option></select></label>
      <label>Zona <select data-mlv-filter="zona"><option value="">Todas</option></select></label>
      <label>Chofer <select data-mlv-filter="chofer"><option value="">Cualquiera</option></select></label>
      <label>Tipo Pedido <select data-mlv-filter="tipo"><option value="">Todos</option></select></label>
      <input type="search" data-mlv-search placeholder="Buscar cliente, SO, nota…">
      <button type="button" data-mlv-clear>Limpiar</button>
      <span class="mlv-chip" data-mlv-selection hidden></span>
      <span class="mlv-status" data-mlv-status></span>
      <span class="mlv-error" data-mlv-error hidden></span>
    `;

    const anchor = table.closest("#prop") || table.parentElement;
    anchor.parentElement.insertBefore(bar, anchor);

    bar.addEventListener("change", (event) => {
      const select = event.target.closest("[data-mlv-filter]");
      if (!select) return;
      state.filters[select.dataset.mlvFilter] = select.value;
      const current = findWaveTable();
      if (current) applyFilters(current);
    });
    bar.querySelector("[data-mlv-search]").addEventListener("input", (event) => {
      state.filters.search = event.target.value.trim().toLowerCase();
      const current = findWaveTable();
      if (current) applyFilters(current);
    });
    bar.querySelector("[data-mlv-clear]").addEventListener("click", () => {
      state.filters = { ruta: "", zona: "", chofer: "", tipo: "", search: "" };
      for (const select of bar.querySelectorAll("[data-mlv-filter]")) select.value = "";
      bar.querySelector("[data-mlv-search]").value = "";
      const current = findWaveTable();
      if (current) applyFilters(current);
    });
  }

  function rebuildFilterOptions(data) {
    if (!bar) return;
    const values = { ruta: new Set(), zona: new Set(), chofer: new Set(), tipo: new Set() };
    for (const info of Object.values(data)) {
      if (info.route?.name) values.ruta.add(info.route.name);
      if (info.delivery_route?.name) values.zona.add(info.delivery_route.name);
      const chofer = info.driver_name || (info.pickup_at_warehouse ? "Cliente Retira" : null);
      if (chofer) values.chofer.add(chofer);
      if (info.pickup_at_warehouse === true) values.tipo.add("Retira Bod.");
      if (info.pickup_at_warehouse === false) values.tipo.add("Puerta");
    }

    for (const [key, set] of Object.entries(values)) {
      const select = bar.querySelector(`[data-mlv-filter="${key}"]`);
      const previous = state.filters[key];
      while (select.options.length > 1) select.remove(1);
      for (const value of [...set].sort((a, b) => a.localeCompare(b))) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }
      select.value = [...set].includes(previous) ? previous : "";
      state.filters[key] = select.value;
    }
  }

  function applyFilters(table) {
    if (!table.tBodies[0]) return;
    const { ruta, zona, chofer, tipo, search } = state.filters;
    let visible = 0;
    for (const row of table.tBodies[0].rows) {
      const matches =
        (!ruta || row.dataset.mlvRuta === ruta) &&
        (!zona || row.dataset.mlvZona === zona) &&
        (!chofer || row.dataset.mlvChofer === chofer) &&
        (!tipo || row.dataset.mlvTipo === tipo) &&
        (!search || (row.dataset.mlvSearch || "").includes(search));
      row.classList.toggle("mlv-hidden", !matches);
      if (matches) visible += 1;
    }
    setBarStatus(`${visible} salidas visibles`);
    updateSelectionSummary(table);
  }

  function bindSelectionSummary(table, soIndex) {
    if (table.dataset.mlvSelBound === "1") return;
    table.dataset.mlvSelBound = "1";
    table.addEventListener("change", (event) => {
      if (event.target.matches('input[type="checkbox"]')) {
        // El "seleccionar todo" del encabezado marca los checkboxes vía jQuery;
        // dale un tick al event loop para leer el estado final.
        setTimeout(() => updateSelectionSummary(table), 0);
      }
    });
  }

  function updateSelectionSummary(table) {
    if (!bar || !table.tBodies[0]) return;
    const chip = bar.querySelector("[data-mlv-selection]");
    let count = 0;
    let seco = 0;
    let frio = 0;
    let total = 0;
    for (const row of table.tBodies[0].rows) {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox || !checkbox.checked) continue;
      count += 1;
      seco += Number(row.dataset.mlvSeco || 0);
      frio += Number(row.dataset.mlvFrio || 0);
      total += Number(row.dataset.mlvTotal || 0);
    }
    if (count === 0) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.textContent = `${count} seleccionadas · ${fmtQty(total)} cj (${fmtQty(seco)} seco / ${fmtQty(frio)} frío)`;
  }

  // --------------------------------------------------------------------------
  // Estado / errores
  // --------------------------------------------------------------------------

  function setBarStatus(text) {
    const el = bar?.querySelector("[data-mlv-status]");
    if (el) el.textContent = text;
  }

  function showError(response) {
    const el = bar?.querySelector("[data-mlv-error]");
    if (!el) return;
    el.hidden = false;
    el.innerHTML = "";
    el.append(escapeText(response?.error || "Error consultando milov-app"), " ");
    if (response?.code === "NO_KEY" || response?.code === "AUTH") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Abrir opciones";
      btn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "MLV_OPEN_OPTIONS" }));
      el.appendChild(btn);
    }
    setBarStatus("");
  }

  function hideError() {
    const el = bar?.querySelector("[data-mlv-error]");
    if (el) el.hidden = true;
  }

  // --------------------------------------------------------------------------
  // Utilidades
  // --------------------------------------------------------------------------

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function fmtQty(value) {
    if (!value) return "-";
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  function escapeText(text) {
    return document.createTextNode(text);
  }

  // --------------------------------------------------------------------------
  // Observador: la tabla se reemplaza completa en cada "Aplicar Filtros"
  // --------------------------------------------------------------------------

  let debounceTimer = null;
  function scheduleProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      processTable().catch((err) => console.error("[milov-ext]", err));
    }, 250);
  }

  const target = document.querySelector("#prop") || document.body;
  new MutationObserver(scheduleProcess).observe(target, { childList: true, subtree: true });
  scheduleProcess();
})();
