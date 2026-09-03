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
    planningOptions: null,
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
      <span class="mlv-plan-hint">Al crear el wave se pedirá fecha y chofer</span>
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

    const response = await chrome.runtime.sendMessage({ type: "MLV_PLANNING_OPTIONS" });
    if (!response?.ok) {
      showPlanningError(response?.error || "No se pudieron cargar los choferes");
      setPlanningModalStatus("");
      return;
    }

    state.planningOptions = {
      drivers: Array.isArray(response.drivers) ? response.drivers : [],
      routes: Array.isArray(response.routes) ? response.routes : [],
    };
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
    planningModal.querySelector("[data-mlv-plan-form]").addEventListener("submit", saveWavePlan);
  }

  function renderPlanningOptions() {
    const driverSelect = planningModal.querySelector("[data-mlv-plan-driver]");
    const routeSelect = planningModal.querySelector("[data-mlv-plan-route]");
    driverSelect.innerHTML = '<option value="">Seleccionar chofer…</option>';
    routeSelect.innerHTML = '<option value="">Crear ruta cuando llegue el primer paquete</option>';

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
  }

  function syncRouteSelection(event) {
    const routeId = event.target.value;
    const dateInput = planningModal.querySelector("[data-mlv-plan-date]");
    const driverSelect = planningModal.querySelector("[data-mlv-plan-driver]");
    dateInput.disabled = !!routeId;
    driverSelect.disabled = false;
    if (!routeId) return;
    const route = state.planningOptions?.routes.find((item) => item.id === routeId);
    if (!route) return;
    dateInput.value = route.scheduled_date || "";
    if (route.driver_id) {
      driverSelect.value = route.driver_id;
      driverSelect.disabled = true;
    }
  }

  async function saveWavePlan(event) {
    event.preventDefault();
    const pending = state.pendingKomodinAction;
    if (!pending) return;

    const scheduledDate = planningModal.querySelector("[data-mlv-plan-date]").value;
    const driverId = planningModal.querySelector("[data-mlv-plan-driver]").value;
    const routeId = planningModal.querySelector("[data-mlv-plan-route]").value;
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
    const now = new Date();
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
  document.addEventListener("click", interceptWaveClick, true);
  document.addEventListener("submit", interceptWaveSubmit, true);
  scheduleProcess();
})();
