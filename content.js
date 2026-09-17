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
    { key: "chofer", label: "Chofer" },
    { key: "seco", label: "Cj. Seco", numeric: true },
    { key: "frio", label: "Cj. Frío/Cong", numeric: true },
    { key: "total", label: "Total Cj.", numeric: true },
    { key: "notas", label: "Notas" },
  ];

  const state = {
    filters: { rutas: [], zona: "", chofer: "", tipo: "", entrega: "", search: "" },
    lastData: {},
    planningOptions: null,
    vehicleId: "",
    pendingKomodinAction: null,
  };

  let bar = null;
  let processing = false;
  let planningModal = null;
  const bypassClickOnce = new WeakSet();
  const bypassSubmitOnce = new WeakSet();

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
      if (!state.planningOptions) void loadPlanningOptions().catch((error) => {
        bar.querySelector("[data-mlv-capacity]").textContent = `Capacidad no disponible: ${error.message}`;
      });
      setBarStatus("Cargando datos Milov…");

      const rows = [...table.tBodies[0].rows];
      const soNumbers = [];
      for (const row of rows) {
        const value = (row.cells[soIndex]?.textContent || "").trim().toUpperCase();
        if (SO_RE.test(value)) soNumbers.push(value);
      }

      injectHeader(table);
      injectPlaceholders(table, soIndex);
      bindSelectionSummary(table);
      state.lastData = {};

      if (soNumbers.length === 0) {
        fillRows(table, soIndex, {});
        rebuildFilterOptions({});
        applyFilters(table);
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
      updateSelectionSummary(table);
    } finally {
      processing = false;
      if (findWaveTable() !== table) scheduleProcess();
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

      // Zoho ruta_entrega es la ruta; ruta (sector) es la zona.
      const ruta = info.delivery_route?.name || "";
      const zona = info.route?.name || "";
      cells.ruta.innerHTML = "";
      cells.ruta.appendChild(stacked(ruta || "Sin ruta", zona || "Sin zona"));

      const tipo =
        info.pickup_at_warehouse === true ? "Retira Bod." :
        info.pickup_at_warehouse === false ? "Puerta" : "—";
      cells.tipo.textContent = tipo;

      cells.entrega.innerHTML = "";
      cells.entrega.appendChild(deliveryCell(info));

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
      setRowFilterData(row, { ruta, zona, chofer: chofer || "", tipo, entrega: info.delivery_date });
    }
  }

  function setRowFilterData(row, values) {
    row.dataset.mlvRuta = values?.ruta || "";
    row.dataset.mlvZona = values?.zona || "";
    row.dataset.mlvChofer = values?.chofer || "";
    row.dataset.mlvTipo = values?.tipo || "";
    row.dataset.mlvEntrega = values?.entrega || "";
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

  // --------------------------------------------------------------------------
  // Barra de filtros + resumen de selección
  // --------------------------------------------------------------------------

  function ensureBar(table) {
    if (bar && document.contains(bar)) return;
    bar = document.createElement("div");
    bar.className = "mlv-bar";
    bar.innerHTML = `
      <div class="mlv-bar-title">Milov</div>
      <details class="mlv-route-filter">
        <summary data-mlv-routes-label>Rutas: Todas</summary>
        <div class="mlv-route-options" data-mlv-routes></div>
      </details>
      <label>Zona <select data-mlv-filter="zona"><option value="">Todas</option></select></label>
      <label>Chofer <select data-mlv-filter="chofer"><option value="">Cualquiera</option></select></label>
      <label>Tipo Pedido <select data-mlv-filter="tipo"><option value="">Todos</option></select></label>
      <label>Entrega <input type="date" data-mlv-filter="entrega"></label>
      <button type="button" data-mlv-tomorrow>Mañana</button>
      <input type="search" data-mlv-search placeholder="Buscar cliente, SO, nota…">
      <button type="button" data-mlv-clear>Limpiar</button>
      <span class="mlv-chip" data-mlv-selection hidden></span>
      <label>Vehículo <select data-mlv-vehicle><option value="">Seleccionar vehículo…</option></select></label>
      <button type="button" data-mlv-reload-vehicles>Actualizar vehículos</button>
      <div class="mlv-capacity" data-mlv-capacity aria-live="polite">Selecciona un vehículo para ver su capacidad.</div>
      <span class="mlv-plan-hint">Al crear el wave se pedirá fecha y chofer</span>
      <span class="mlv-plan-hint">Seleccionar todo aplica a las salidas visibles. Al filtrar se desmarcan las ocultas.</span>
      <span class="mlv-status" data-mlv-status></span>
      <span class="mlv-error" data-mlv-error hidden></span>
    `;

    const anchor = table.closest("#prop") || table.parentElement;
    anchor.parentElement.insertBefore(bar, anchor);
    bar.querySelector("[data-mlv-vehicle]").addEventListener("change", (event) => {
      state.vehicleId = event.target.value;
      const current = findWaveTable();
      if (current) updateSelectionSummary(current);
    });
    bar.querySelector("[data-mlv-reload-vehicles]").addEventListener("click", async (event) => {
      const button = event.target;
      button.disabled = true;
      try { await loadPlanningOptions(); }
      catch (error) { bar.querySelector("[data-mlv-capacity]").textContent = `Capacidad no disponible: ${error.message}`; }
      finally { button.disabled = false; }
    });

    bar.addEventListener("change", (event) => {
      if (event.target.matches("[data-mlv-route]")) {
        state.filters.rutas = [...bar.querySelectorAll("[data-mlv-route]:checked")].map((input) => input.value);
        updateRoutesLabel();
        const current = findWaveTable();
        if (current) applyFilters(current);
        return;
      }
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
      state.filters = { rutas: [], zona: "", chofer: "", tipo: "", entrega: "", search: "" };
      for (const select of bar.querySelectorAll("[data-mlv-filter]")) select.value = "";
      for (const input of bar.querySelectorAll("[data-mlv-route]")) input.checked = false;
      updateRoutesLabel();
      bar.querySelector("[data-mlv-search]").value = "";
      const current = findWaveTable();
      if (current) applyFilters(current);
    });
    bar.querySelector("[data-mlv-tomorrow]").addEventListener("click", () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      state.filters.entrega = localDate(tomorrow);
      bar.querySelector('[data-mlv-filter="entrega"]').value = state.filters.entrega;
      const current = findWaveTable();
      if (current) applyFilters(current);
    });
  }

  function updateRoutesLabel() {
    const routes = state.filters.rutas;
    bar.querySelector("[data-mlv-routes-label]").textContent =
      routes.length ? `Rutas: ${routes.join(", ")}` : "Rutas: Todas";
  }

  function rebuildFilterOptions(data) {
    if (!bar) return;
    const values = { ruta: new Set(), zona: new Set(), chofer: new Set(), tipo: new Set() };
    for (const info of Object.values(data)) {
      if (info.delivery_route?.name) values.ruta.add(info.delivery_route.name);
      if (info.route?.name) values.zona.add(info.route.name);
      const chofer = info.driver_name || (info.pickup_at_warehouse ? "Cliente Retira" : null);
      if (chofer) values.chofer.add(chofer);
      if (info.pickup_at_warehouse === true) values.tipo.add("Retira Bod.");
      if (info.pickup_at_warehouse === false) values.tipo.add("Puerta");
    }

    for (const [key, set] of Object.entries(values)) {
      if (key === "ruta") {
        const container = bar.querySelector("[data-mlv-routes]");
        container.replaceChildren();
        // Keep selected filters across WMS re-renders, even if they have no matches.
        for (const value of [...new Set([...set, ...state.filters.rutas])].sort((a, b) => a.localeCompare(b))) {
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.dataset.mlvRoute = "";
          input.value = value;
          input.checked = state.filters.rutas.includes(value);
          label.append(input, document.createTextNode(value));
          container.appendChild(label);
        }
        updateRoutesLabel();
        continue;
      }
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
    const { rutas, zona, chofer, tipo, entrega, search } = state.filters;
    let visible = 0;
    for (const row of table.tBodies[0].rows) {
      const matches =
        (!rutas.length || rutas.includes(row.dataset.mlvRuta)) &&
        (!zona || row.dataset.mlvZona === zona) &&
        (!chofer || row.dataset.mlvChofer === chofer) &&
        (!tipo || row.dataset.mlvTipo === tipo) &&
        (!entrega || row.dataset.mlvEntrega === entrega) &&
        (!search || (row.dataset.mlvSearch || "").includes(search));
      row.classList.toggle("mlv-hidden", !matches);
      if (isRowVisible(row)) visible += 1;
      else setRowChecked(row, false);
    }
    setBarStatus(`${visible} salidas visibles`);
    updateSelectionSummary(table);
  }

  function isRowVisible(row) {
    return !row.classList.contains("mlv-hidden") && !row.hidden && row.getClientRects().length > 0;
  }

  function setRowChecked(row, checked) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox || checkbox.disabled || checkbox.checked === checked) return;
    checkbox.checked = checked;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function interceptSelectAll(event) {
    const checkbox = event.target;
    if (!checkbox.matches?.('thead input[type="checkbox"]')) return;
    const table = checkbox.closest("table");
    if (table !== findWaveTable()) return;
    // Stop Komodin's inline/jQuery bulk handler before it touches hidden rows.
    // Keep the checkbox default action so mouse and keyboard both work.
    event.stopImmediatePropagation();
    for (const row of table.tBodies[0]?.rows || []) {
      setRowChecked(row, isRowVisible(row) && checkbox.checked);
    }
    updateSelectionSummary(table);
  }

  function bindSelectionSummary(table) {
    if (table.dataset.mlvSelBound === "1") return;
    table.dataset.mlvSelBound = "1";
    table.addEventListener("change", (event) => {
      if (event.target.matches('input[type="checkbox"]')) {
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
    let unknown = 0;
    const visibleCheckboxes = [];
    for (const row of table.tBodies[0].rows) {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.disabled && isRowVisible(row)) visibleCheckboxes.push(checkbox);
      if (!checkbox || !checkbox.checked) continue;
      count += 1;
      if (!state.lastData[row.dataset.mlvSo] || !(Number(row.dataset.mlvTotal) > 0)) unknown += 1;
      seco += Number(row.dataset.mlvSeco || 0);
      frio += Number(row.dataset.mlvFrio || 0);
      total += Number(row.dataset.mlvTotal || 0);
    }
    for (const checkbox of table.tHead?.querySelectorAll('input[type="checkbox"]') || []) {
      const checked = visibleCheckboxes.filter((input) => input.checked).length;
      checkbox.checked = visibleCheckboxes.length > 0 && checked === visibleCheckboxes.length;
      checkbox.indeterminate = checked > 0 && checked < visibleCheckboxes.length;
    }
    renderCapacity(bar.querySelector("[data-mlv-capacity]"), selectedVehicle(), total, unknown);
    if (count === 0) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.textContent = `${count} seleccionadas · ${fmtQty(total)} cj (${fmtQty(seco)} seco / ${fmtQty(frio)} frío)`;
  }

  function selectedVehicle(id = state.vehicleId) {
    return state.planningOptions?.vehicles.find((vehicle) => vehicle.id === id);
  }

  async function loadPlanningOptions() {
    const response = await chrome.runtime.sendMessage({ type: "MLV_PLANNING_OPTIONS" });
    if (!response?.ok) throw new Error(response?.error || "No se pudieron cargar vehículos y choferes");
    state.planningOptions = {
      drivers: Array.isArray(response.drivers) ? response.drivers : [],
      routes: Array.isArray(response.routes) ? response.routes : [],
      vehicles: Array.isArray(response.vehicles) ? response.vehicles : [],
    };
    if (!selectedVehicle()) state.vehicleId = "";
    fillVehicleOptions(bar.querySelector("[data-mlv-vehicle]"), state.vehicleId);
    const table = findWaveTable();
    if (table) updateSelectionSummary(table);
  }

  function fillVehicleOptions(select, value, routeVehicle) {
    select.replaceChildren(new Option("Sin vehículo seleccionado", ""));
    const vehicles = [...(state.planningOptions?.vehicles || [])];
    if (routeVehicle && !vehicles.some(vehicle => vehicle.id === routeVehicle.id)) vehicles.push(routeVehicle);
    for (const vehicle of vehicles) {
      select.appendChild(new Option(`${vehicle.name}${vehicle.plate ? ` · ${vehicle.plate}` : ""} · ${vehicle.capacity_boxes} cajas${vehicle.is_active === false ? " (inactivo)" : ""}`, vehicle.id));
    }
    select.value = value || "";
  }

  function renderCapacity(element, vehicle, total, unknown = 0, existing = 0) {
    if (!element) return;
    element.replaceChildren();
    element.dataset.level = "normal";
    if (!vehicle || !(Number(vehicle.capacity_boxes) > 0)) {
      element.textContent = `${fmtQty(total)} cajas seleccionadas. Selecciona un vehículo para ver su capacidad.${unknown ? ` ${unknown} salidas sin cantidad disponible.` : ""}`;
      return;
    }
    const capacity = Number(vehicle.capacity_boxes);
    const load = total + existing;
    const percent = load / capacity * 100;
    element.dataset.level = load > capacity ? "exceeded" : unknown || load >= capacity * 0.9 ? "warning" : "normal";
    const label = document.createElement("strong");
    label.textContent = `${vehicle.name}: ${fmtQty(load)} / ${fmtQty(capacity)} cajas · ${percent.toFixed(1)}%`;
    const progress = document.createElement("progress");
    progress.max = capacity;
    progress.value = Math.min(load, capacity);
    progress.setAttribute("aria-label", `Ocupación de ${vehicle.name}`);
    const detail = document.createElement("span");
    detail.textContent = load > capacity ? `Excede por ${fmtQty(load - capacity)} cajas` : load === capacity ? "Capacidad máxima alcanzada" : `${fmtQty(capacity - load)} cajas disponibles`;
    if (existing) detail.textContent += ` · Incluye ${fmtQty(existing)} cajas ya asignadas a la ruta`;
    if (unknown) detail.textContent += ` · Total parcial: ${unknown} salidas sin cantidad; ocupación real desconocida`;
    element.append(label, progress, detail);
  }

  function updatePlanningCapacity() {
    const route = state.planningOptions?.routes.find(item => item.id === planningModal.querySelector("[data-mlv-plan-route]").value);
    const vehicleId = planningModal.querySelector("[data-mlv-plan-vehicle]").value;
    const vehicle = selectedVehicle(vehicleId) || (route?.vehicle?.id === vehicleId ? route.vehicle : null);
    const selected = state.pendingKomodinAction?.soNumbers || [];
    let total = 0;
    let unknown = 0;
    for (const so of selected) {
      const quantity = Number(state.lastData[so]?.quantities?.total);
      if (Number.isFinite(quantity) && quantity > 0) total += quantity;
      else unknown += 1;
    }
    // Komodin puede incluir transferencias/ensambles sin enriquecimiento Milov.
    for (const row of findWaveTable()?.tBodies[0]?.rows || []) {
      if (row.querySelector('input[type="checkbox"]')?.checked && !SO_RE.test(row.dataset.mlvSo || "")) unknown += 1;
    }
    let existing = 0;
    for (const item of route?.assigned_load || []) {
      if (selected.includes(item.sales_order_number)) continue;
      if (item.quantity === null || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) unknown += 1;
      else existing += Number(item.quantity);
    }
    renderCapacity(planningModal.querySelector("[data-mlv-plan-capacity]"), vehicle, total, unknown, existing);
  }

  function selectedSoNumbers(table = findWaveTable()) {
    if (!table?.tBodies[0]) return [];
    const selected = [];
    for (const row of table.tBodies[0].rows) {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox?.checked && SO_RE.test(row.dataset.mlvSo || "")) {
        selected.push(row.dataset.mlvSo);
      }
    }
    return [...new Set(selected)];
  }

  // --------------------------------------------------------------------------
  // Planeación del wave: fecha, chofer y ruta opcional
  // --------------------------------------------------------------------------

  function isWaveCreateAction(element) {
    if (!element || element.closest(".mlv-modal")) return false;
    const label = [
      element.textContent,
      element.value,
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return /\bwave\b/.test(label) &&
      /\b(?:crear|generar|guardar|procesar|create|generate|save|new|nuevo)\b/.test(label);
  }

  function interceptWaveClick(event) {
    const action = event.target.closest?.('button, input[type="submit"], input[type="button"], a');
    if (!action || bypassClickOnce.has(action) || !isWaveCreateAction(action)) return;

    const soNumbers = selectedSoNumbers();
    if (soNumbers.length === 0) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    openPlanningModal({ type: "click", target: action, soNumbers }).catch((error) => {
      console.error("[milov-ext] No se pudo abrir la planeación", error);
    });
  }

  function interceptWaveSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || bypassSubmitOnce.has(form)) return;
    const submitter = event.submitter;
    if (!isWaveCreateAction(submitter)) return;

    const soNumbers = selectedSoNumbers();
    if (soNumbers.length === 0) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    openPlanningModal({ type: "submit", form, submitter, soNumbers }).catch((error) => {
      console.error("[milov-ext] No se pudo abrir la planeación", error);
    });
  }

  async function openPlanningModal(pendingAction) {
    ensurePlanningModal();
    state.pendingKomodinAction = pendingAction;
    planningModal.hidden = false;
    document.documentElement.classList.add("mlv-modal-open");

    planningModal.querySelector("[data-mlv-plan-count]").textContent =
      `${pendingAction.soNumbers.length} salida${pendingAction.soNumbers.length === 1 ? "" : "s"}`;
    planningModal.querySelector("[data-mlv-plan-sos]").textContent = pendingAction.soNumbers.join(", ");
    planningModal.querySelector("[data-mlv-plan-date]").value = suggestedScheduledDate(pendingAction.soNumbers);
    planningModal.querySelector("[data-mlv-plan-date]").disabled = false;
    planningModal.querySelector("[data-mlv-plan-driver]").disabled = false;
    planningModal.querySelector("[data-mlv-plan-error]").hidden = true;
    planningModal.querySelector("[data-mlv-plan-save]").disabled = true;
    setPlanningModalStatus("Cargando choferes y rutas…");

    try { await loadPlanningOptions(); }
    catch (error) {
      showPlanningError(error.message);
      setPlanningModalStatus("");
      return;
    }

    renderPlanningOptions();
    planningModal.querySelector("[data-mlv-plan-save]").disabled = false;
    setPlanningModalStatus("");
  }

  function ensurePlanningModal() {
    if (planningModal && document.contains(planningModal)) return;
    planningModal = document.createElement("div");
    planningModal.className = "mlv-modal";
    planningModal.hidden = true;
    planningModal.innerHTML = `
      <div class="mlv-modal-backdrop"></div>
      <section class="mlv-modal-card" role="dialog" aria-modal="true" aria-labelledby="mlv-plan-title">
        <div class="mlv-modal-header">
          <div>
            <h2 id="mlv-plan-title">Planificar wave en Milov</h2>
            <p><strong data-mlv-plan-count></strong> quedarán en espera de sus paquetes.</p>
          </div>
          <button type="button" class="mlv-modal-close" data-mlv-plan-cancel aria-label="Cerrar">×</button>
        </div>
        <div class="mlv-modal-sos" data-mlv-plan-sos></div>
        <form data-mlv-plan-form>
          <label>
            Fecha de salida
            <input type="date" data-mlv-plan-date required>
          </label>
          <label>
            Chofer
            <select data-mlv-plan-driver required>
              <option value="">Seleccionar chofer…</option>
            </select>
          </label>
          <label>
            Vehículo
            <select data-mlv-plan-vehicle><option value="">Sin vehículo seleccionado</option></select>
          </label>
          <div class="mlv-capacity" data-mlv-plan-capacity aria-live="polite"></div>
          <label>
            Ruta existente (opcional)
            <select data-mlv-plan-route>
              <option value="">Crear ruta cuando llegue el primer paquete</option>
            </select>
          </label>
          <p class="mlv-modal-help">Puedes reutilizar una ruta programada o en curso. Al elegirla se usarán su fecha y chofer.</p>
          <div class="mlv-modal-error" data-mlv-plan-error hidden></div>
          <div class="mlv-modal-status" data-mlv-plan-status></div>
          <div class="mlv-modal-actions">
            <button type="button" data-mlv-plan-cancel>Cancelar</button>
            <button type="submit" class="mlv-primary" data-mlv-plan-save>Guardar y crear wave</button>
          </div>
        </form>
      </section>
    `;
    document.body.appendChild(planningModal);

    for (const button of planningModal.querySelectorAll("[data-mlv-plan-cancel]")) {
      button.addEventListener("click", closePlanningModal);
    }
    planningModal.querySelector(".mlv-modal-backdrop").addEventListener("click", closePlanningModal);
    planningModal.querySelector("[data-mlv-plan-route]").addEventListener("change", syncRouteSelection);
    planningModal.querySelector("[data-mlv-plan-vehicle]").addEventListener("change", () => {
      state.vehicleId = planningModal.querySelector("[data-mlv-plan-vehicle]").value;
      bar.querySelector("[data-mlv-vehicle]").value = state.vehicleId;
      updatePlanningCapacity();
      const table = findWaveTable();
      if (table) updateSelectionSummary(table);
    });
    planningModal.querySelector("[data-mlv-plan-form]").addEventListener("submit", saveWavePlan);
  }

  function renderPlanningOptions() {
    const driverSelect = planningModal.querySelector("[data-mlv-plan-driver]");
    const routeSelect = planningModal.querySelector("[data-mlv-plan-route]");
    driverSelect.innerHTML = '<option value="">Seleccionar chofer…</option>';
    routeSelect.innerHTML = '<option value="">Crear ruta cuando llegue el primer paquete</option>';
    const vehicleSelect = planningModal.querySelector("[data-mlv-plan-vehicle]");
    fillVehicleOptions(vehicleSelect, state.vehicleId);
    vehicleSelect.disabled = false;

    for (const driver of state.planningOptions.drivers) {
      const option = document.createElement("option");
      option.value = driver.id;
      option.textContent = personName(driver) || "Chofer";
      driverSelect.appendChild(option);
    }

    for (const route of state.planningOptions.routes) {
      const option = document.createElement("option");
      option.value = route.id;
      option.textContent = [
        route.route_number,
        route.scheduled_date,
        personName(route.driver) || "sin chofer",
        route.status === "en_curso" ? "en curso" : "programada",
        `${Number(route.package_count || 0)} paq.`,
      ].join(" · ");
      routeSelect.appendChild(option);
    }
    updatePlanningCapacity();
  }

  function syncRouteSelection(event) {
    const routeId = event.target.value;
    const dateInput = planningModal.querySelector("[data-mlv-plan-date]");
    const driverSelect = planningModal.querySelector("[data-mlv-plan-driver]");
    dateInput.disabled = !!routeId;
    driverSelect.disabled = false;
    const vehicleSelect = planningModal.querySelector("[data-mlv-plan-vehicle]");
    vehicleSelect.disabled = false;
    if (!routeId) {
      fillVehicleOptions(vehicleSelect, state.vehicleId);
      updatePlanningCapacity();
      return;
    }
    const route = state.planningOptions?.routes.find((item) => item.id === routeId);
    if (!route) return;
    fillVehicleOptions(vehicleSelect, route.vehicle_id || state.vehicleId, route.vehicle);
    vehicleSelect.disabled = !!route.vehicle_id;
    dateInput.value = route.scheduled_date || "";
    if (route.driver_id) {
      driverSelect.value = route.driver_id;
      driverSelect.disabled = true;
    }
    updatePlanningCapacity();
  }

  async function saveWavePlan(event) {
    event.preventDefault();
    const pending = state.pendingKomodinAction;
    if (!pending) return;
    if (pending.soNumbers.length > 300) {
      showPlanningError("Selecciona como máximo 300 SO por wave.");
      return;
    }

    const scheduledDate = planningModal.querySelector("[data-mlv-plan-date]").value;
    const driverId = planningModal.querySelector("[data-mlv-plan-driver]").value;
    const routeId = planningModal.querySelector("[data-mlv-plan-route]").value;
    const vehicleId = planningModal.querySelector("[data-mlv-plan-vehicle]").value;
    if (!scheduledDate || !driverId) {
      showPlanningError("Selecciona la fecha de salida y el chofer.");
      return;
    }

    const saveButton = planningModal.querySelector("[data-mlv-plan-save]");
    saveButton.disabled = true;
    showPlanningError("");
    setPlanningModalStatus("Guardando planeación en Milov…");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "MLV_PLAN_WAVE",
        soNumbers: pending.soNumbers,
        scheduledDate,
        driverId,
        vehicleId: vehicleId || null,
        routeId: routeId || null,
      });
      if (!response?.ok) throw new Error(response?.error || "No se pudo guardar el wave");

      const olaNumber = response.ola?.internal_ola_number || "OLA";
      closePlanningModal();
      setBarStatus(`${olaNumber} guardada · continuando en Komodin…`);
      resumeKomodinAction(pending);
    } catch (error) {
      showPlanningError(error instanceof Error ? error.message : String(error));
      setPlanningModalStatus("");
      saveButton.disabled = false;
    }
  }

  function resumeKomodinAction(pending) {
    if (pending.type === "click" && document.contains(pending.target)) {
      bypassClickOnce.add(pending.target);
      if (pending.target.form) bypassSubmitOnce.add(pending.target.form);
      pending.target.click();
      window.setTimeout(() => {
        bypassClickOnce.delete(pending.target);
        if (pending.target.form) bypassSubmitOnce.delete(pending.target.form);
      }, 500);
      return;
    }
    if (pending.type === "submit" && document.contains(pending.form)) {
      bypassSubmitOnce.add(pending.form);
      pending.form.requestSubmit(pending.submitter || undefined);
      window.setTimeout(() => bypassSubmitOnce.delete(pending.form), 500);
    }
  }

  function closePlanningModal() {
    if (!planningModal) return;
    planningModal.hidden = true;
    document.documentElement.classList.remove("mlv-modal-open");
    state.pendingKomodinAction = null;
  }

  function showPlanningError(message) {
    const element = planningModal?.querySelector("[data-mlv-plan-error]");
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
  }

  function setPlanningModalStatus(message) {
    const element = planningModal?.querySelector("[data-mlv-plan-status]");
    if (element) element.textContent = message;
  }

  function suggestedScheduledDate(soNumbers) {
    const dates = [...new Set(
      soNumbers.map((so) => state.lastData[so]?.delivery_date).filter(Boolean)
    )];
    if (dates.length === 1) return dates[0];
    return state.filters.entrega || localDate(new Date());
  }

  function localDate(now) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function personName(person) {
    if (!person) return "";
    return [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
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
    if (!value) return "0";
    return Number.isInteger(value) ? String(value) : value.toLocaleString("es-MX", { maximumFractionDigits: 4 });
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
  document.addEventListener("click", interceptWaveClick, true);
  document.addEventListener("submit", interceptWaveSubmit, true);
  window.addEventListener("click", interceptSelectAll, true);
  window.addEventListener("change", interceptSelectAll, true);
  scheduleProcess();
})();
