// ============================================================================
// Content script — columnas Milov, filtros y planeación del wave en Komodin.
//
// La tabla del WMS es HTML plano insertado por jQuery dentro de #prop tras
// "Aplicar Filtros" (POST /wave_new_ajax/). Cada re-render reemplaza el HTML,
// así que un MutationObserver reprocesa la tabla nueva. La columna "Reff"
// trae el número de SO, que es la llave contra milov-app.
//
// Carga de camiones: milov-app calcula peso y volumen por SO (peso de caja de
// Zoho ÷ piezas por caja del WMS) y entrega los viajes del día con su carga.
// Aquí solo se suman esas cargas para mostrar la ocupación al instante; el
// servidor vuelve a validar al guardar.
// ============================================================================

(() => {
  const SO_RE = /^SO-\d+$/;
  const OPTIONS_TTL_MS = 60 * 1000;

  const ADDED_COLUMNS = [
    { key: "ruta", label: "Ruta / Zona" },
    { key: "tipo", label: "Tipo" },
    { key: "entrega", label: "Fecha Ent." },
    { key: "chofer", label: "Chofer / OLA" },
    { key: "cajas", label: "Cantidad", numeric: true },
    { key: "peso", label: "Peso", numeric: true },
    { key: "notas", label: "Notas" },
  ];

  const PICKUP_LABEL = "Retiro en bodega";
  const DELIVERY_LABEL = "Reparto";
  const MISSING_LABELS = {
    product: "producto no encontrado",
    conversion: "piezas por caja",
    weight: "peso de caja",
    volume: "medidas de caja",
  };

  const state = {
    filters: { rutas: [], zona: "", chofer: "", tipo: "", entrega: "", search: "" },
    lastData: {},
    optionsByDate: new Map(),
    trucksDate: "",
    pendingKomodinAction: null,
  };

  let bar = null;
  let processing = false;
  let planningModal = null;
  let modal = null;
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
      bindSelectionSummary(table);
      state.lastData = {};

      if (soNumbers.length === 0) {
        fillRows(table, {});
        rebuildFilterOptions({});
        applyFilters(table);
        setBarStatus("Sin SOs en la tabla");
        return;
      }

      const response = await chrome.runtime.sendMessage({ type: "MLV_ENRICH", soNumbers });

      if (!response || !response.ok) {
        showError(response);
        return;
      }

      hideError();
      state.lastData = response.salesOrders || {};
      fillRows(table, state.lastData);
      rebuildFilterOptions(state.lastData);
      applyFilters(table);
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

  function fillRows(table, data) {
    for (const row of table.tBodies[0].rows) {
      const so = row.dataset.mlvSo;
      const info = so ? data[so] : null;
      const cells = {};
      for (const cell of row.querySelectorAll(".mlv-cell")) {
        cells[cell.dataset.mlvKey] = cell;
      }
      if (!cells.ruta) continue;
      if (!info) {
        for (const key of Object.keys(cells)) cells[key].replaceChildren(dim("—"));
        setRowFilterData(row, null);
        continue;
      }

      // Zoho ruta_entrega es la ruta; ruta (sector) es la zona.
      const ruta = info.delivery_route?.name || "";
      const zona = info.route?.name || "";
      cells.ruta.replaceChildren(stacked(ruta || "Sin ruta", zona || "Sin zona"));

      const tipo = tipoLabel(info);
      cells.tipo.replaceChildren(
        info.pickup_at_warehouse === true ? badge(PICKUP_LABEL, "amber") :
        info.pickup_at_warehouse === false ? text(DELIVERY_LABEL) : dim("—")
      );

      cells.entrega.replaceChildren(deliveryCell(info));

      const chofer = choferLabel(info);
      const olaDetail = [info.ola?.number, info.ola?.vehicle_name].filter(Boolean).join(" · ");
      cells.chofer.replaceChildren(chofer ? stacked(chofer, olaDetail, !olaDetail) : dim("Sin asignar"));

      const dry = num(info.quantities?.dry);
      const cold = num(info.quantities?.cold) + num(info.quantities?.frozen);
      const total = num(info.quantities?.total);
      cells.cajas.replaceChildren(stacked(fmtQty(total), cold ? `${fmtQty(dry)} seco · ${fmtQty(cold)} frío` : "", !cold));

      cells.peso.replaceChildren(weightCell(info.load));
      cells.notas.replaceChildren(notesCell(info.notes));

      row.dataset.mlvTotal = String(total);
      setRowFilterData(row, { ruta, zona, chofer: chofer || "", tipo, entrega: info.delivery_date });
    }
  }

  function tipoLabel(info) {
    return info.pickup_at_warehouse === true ? PICKUP_LABEL :
      info.pickup_at_warehouse === false ? DELIVERY_LABEL : "";
  }

  function choferLabel(info) {
    return info.driver_name || (info.pickup_at_warehouse ? "Retira cliente" : null);
  }

  function setRowFilterData(row, values) {
    row.dataset.mlvRuta = values?.ruta || "";
    row.dataset.mlvZona = values?.zona || "";
    row.dataset.mlvChofer = values?.chofer || "";
    row.dataset.mlvTipo = values?.tipo || "";
    row.dataset.mlvEntrega = values?.entrega || "";
    row.dataset.mlvSearch = (row.textContent || "").toLowerCase();
  }

  function text(value) {
    return document.createTextNode(value);
  }

  function dim(value) {
    const span = document.createElement("span");
    span.className = "mlv-dim";
    span.textContent = value;
    return span;
  }

  function badge(label, tone, title) {
    const span = document.createElement("span");
    span.className = `mlv-badge mlv-badge-${tone}`;
    span.textContent = label;
    if (title) span.title = title;
    return span;
  }

  function stacked(top, bottom, hideBottom = false) {
    const wrap = document.createElement("div");
    const a = document.createElement("div");
    a.className = "mlv-strong";
    a.textContent = top;
    wrap.append(a);
    if (!hideBottom && bottom) {
      const b = document.createElement("div");
      b.className = "mlv-dim mlv-small";
      b.textContent = bottom;
      wrap.append(b);
    }
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
      wrap.appendChild(badge("Difiere", "red", `OLA planificada para ${olaDate}, entrega pedida ${info.delivery_date}`));
    }
    return wrap;
  }

  function weightCell(load) {
    if (!load) return dim("—");
    const wrap = document.createElement("div");
    const kg = document.createElement("div");
    kg.className = "mlv-strong";
    kg.textContent = `${load.weight_complete ? "" : "≥ "}${fmtKg(load.weight_kg)}`;
    wrap.append(kg);
    if (!load.weight_complete) {
      wrap.append(badge("Parcial", "amber", missingSummary(load.missing)));
    } else if (num(load.volume_m3)) {
      const m3 = document.createElement("div");
      m3.className = "mlv-dim mlv-small";
      m3.textContent = fmtM3(load.volume_m3);
      wrap.append(m3);
    }
    return wrap;
  }

  function notesCell(notes) {
    if (!notes) return dim("—");
    const wrap = document.createElement("div");
    wrap.className = "mlv-notes";
    const body = document.createElement("div");
    body.className = "mlv-notes-text";
    body.textContent = notes;
    wrap.append(body);
    // Notas largas o con saltos de línea: se muestran en 3 líneas y se expanden.
    if (notes.length > 90 || /\n/.test(notes)) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "mlv-link";
      toggle.textContent = "Ver más";
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const open = wrap.classList.toggle("mlv-notes-open");
        toggle.textContent = open ? "Ver menos" : "Ver más";
      });
      wrap.append(toggle);
    }
    return wrap;
  }

  function missingText(item) {
    if (!item.wms_product_id && item.missing.includes("conversion")) return "sin ficha en Komodin";
    return `falta en Komodin ${item.missing.map((field) => MISSING_LABELS[field] || field).join(", ")}`;
  }

  function missingSummary(missing = []) {
    if (!missing.length) return "";
    const lines = missing.slice(0, 6).map((item) => `${item.sku} ${item.name}: ${missingText(item)}`);
    if (missing.length > 6) lines.push(`… y ${missing.length - 6} más`);
    return `Peso mínimo; sin datos completos:\n${lines.join("\n")}`;
  }

  // --------------------------------------------------------------------------
  // Barra de filtros + resumen de selección + peso por camión
  // --------------------------------------------------------------------------

  function ensureBar(table) {
    if (bar && document.contains(bar)) return;
    bar = document.createElement("div");
    bar.className = "mlv-bar";
    bar.innerHTML = `
      <div class="mlv-bar-row">
        <div class="mlv-bar-title">Milov</div>
        <details class="mlv-route-filter">
          <summary data-mlv-routes-label>Rutas: Todas</summary>
          <div class="mlv-route-options" data-mlv-routes></div>
        </details>
        <label>Zona <select data-mlv-filter="zona"><option value="">Todas</option></select></label>
        <label>Chofer <select data-mlv-filter="chofer"><option value="">Cualquiera</option></select></label>
        <label>Tipo <select data-mlv-filter="tipo"><option value="">Todos</option></select></label>
        <label>Entrega <input type="date" data-mlv-filter="entrega"></label>
        <button type="button" data-mlv-tomorrow>Mañana</button>
        <input type="search" data-mlv-search placeholder="Buscar cliente, SO, nota…">
        <button type="button" data-mlv-clear>Limpiar</button>
        <span class="mlv-status" data-mlv-status></span>
      </div>
      <div class="mlv-bar-row">
        <span class="mlv-selection" data-mlv-selection>Selecciona salidas para ver su peso.</span>
        <button type="button" class="mlv-trucks-toggle" data-mlv-trucks-toggle aria-expanded="false">Peso por camión</button>
        <span class="mlv-plan-hint">Al crear el wave eliges el camión y el chofer. Seleccionar todo aplica solo a las salidas visibles.</span>
        <span class="mlv-error" data-mlv-error hidden></span>
      </div>
      <section class="mlv-trucks" data-mlv-trucks hidden>
        <div class="mlv-trucks-head">
          <strong>Carga por camión</strong>
          <label>Fecha <input type="date" data-mlv-trucks-date></label>
          <button type="button" data-mlv-trucks-refresh>Actualizar</button>
          <span class="mlv-dim" data-mlv-trucks-status></span>
        </div>
        <div class="mlv-trucks-list" data-mlv-trucks-list></div>
      </section>
    `;

    const anchor = table.closest("#prop") || table.parentElement;
    anchor.parentElement.insertBefore(bar, anchor);

    const routeFilter = bar.querySelector(".mlv-route-filter");
    // El listado de rutas se cierra al hacer clic fuera o con Escape.
    document.addEventListener("click", (event) => {
      if (routeFilter.open && !routeFilter.contains(event.target)) routeFilter.open = false;
    }, true);
    routeFilter.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && routeFilter.open) {
        routeFilter.open = false;
        routeFilter.querySelector("summary").focus();
      }
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
      state.filters.entrega = tomorrowDate();
      bar.querySelector('[data-mlv-filter="entrega"]').value = state.filters.entrega;
      const current = findWaveTable();
      if (current) applyFilters(current);
    });

    const trucksToggle = bar.querySelector("[data-mlv-trucks-toggle]");
    trucksToggle.addEventListener("click", () => {
      const panel = bar.querySelector("[data-mlv-trucks]");
      panel.hidden = !panel.hidden;
      trucksToggle.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) {
        const input = bar.querySelector("[data-mlv-trucks-date]");
        if (!input.value) input.value = state.filters.entrega || tomorrowDate();
        void renderTrucks(false);
      }
    });
    bar.querySelector("[data-mlv-trucks-date]").addEventListener("change", () => void renderTrucks(false));
    bar.querySelector("[data-mlv-trucks-refresh]").addEventListener("click", () => void renderTrucks(true));
  }

  function updateRoutesLabel() {
    const routes = state.filters.rutas;
    bar.querySelector("[data-mlv-routes-label]").textContent =
      routes.length ? `Rutas (${routes.length}): ${routes.join(", ")}` : "Rutas: Todas";
  }

  function rebuildFilterOptions(data) {
    if (!bar) return;
    const values = { ruta: new Set(), zona: new Set(), chofer: new Set(), tipo: new Set() };
    for (const info of Object.values(data)) {
      if (info.delivery_route?.name) values.ruta.add(info.delivery_route.name);
      if (info.route?.name) values.zona.add(info.route.name);
      const chofer = choferLabel(info);
      if (chofer) values.chofer.add(chofer);
      const tipo = tipoLabel(info);
      if (tipo) values.tipo.add(tipo);
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
        select.appendChild(new Option(value, value));
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

  /** Selección actual separada en reparto y retiro en bodega, con su carga. */
  function selectionBreakdown(table = findWaveTable()) {
    const result = { count: 0, boxes: 0, deliveries: [], pickups: [], unknown: 0, load: null };
    if (!table?.tBodies[0]) return { ...result, load: combineLoads([]) };
    const loads = [];
    for (const row of table.tBodies[0].rows) {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox?.checked) continue;
      result.count += 1;
      result.boxes += Number(row.dataset.mlvTotal || 0);
      const so = row.dataset.mlvSo;
      const info = so ? state.lastData[so] : null;
      if (!info) {
        // Transferencias/ensambles de Komodin o SO sin datos Milov: peso desconocido.
        result.unknown += 1;
        loads.push(null);
        continue;
      }
      if (info.pickup_at_warehouse === true) {
        result.pickups.push(so);
        continue;
      }
      result.deliveries.push(so);
      loads.push(info.load || null);
    }
    result.load = combineLoads(loads);
    return result;
  }

  function updateSelectionSummary(table) {
    if (!bar || !table.tBodies[0]) return;
    const visibleCheckboxes = [];
    for (const row of table.tBodies[0].rows) {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.disabled && isRowVisible(row)) visibleCheckboxes.push(checkbox);
    }
    for (const checkbox of table.tHead?.querySelectorAll('input[type="checkbox"]') || []) {
      const checked = visibleCheckboxes.filter((input) => input.checked).length;
      checkbox.checked = visibleCheckboxes.length > 0 && checked === visibleCheckboxes.length;
      checkbox.indeterminate = checked > 0 && checked < visibleCheckboxes.length;
    }

    const chip = bar.querySelector("[data-mlv-selection]");
    const selection = selectionBreakdown(table);
    chip.classList.toggle("mlv-selection-active", selection.count > 0);
    if (selection.count === 0) {
      chip.textContent = "Selecciona salidas para ver su peso.";
      chip.title = "";
      return;
    }
    const parts = [
      `${selection.count} seleccionada${selection.count === 1 ? "" : "s"}`,
      `${fmtQty(selection.boxes)} unid.`,
      `${selection.load.weight_complete ? "" : "≥ "}${fmtKg(selection.load.weight_kg)}`,
    ];
    if (num(selection.load.volume_m3)) parts.push(fmtM3(selection.load.volume_m3));
    if (selection.pickups.length) parts.push(`${selection.pickups.length} retiro en bodega (no van en camión)`);
    if (selection.unknown) parts.push(`${selection.unknown} sin datos Milov`);
    chip.textContent = parts.join(" · ");
    chip.title = selection.load.weight_complete ? "" : missingSummary(selection.load.missing);
  }

  // --------------------------------------------------------------------------
  // Catálogos y viajes del día
  // --------------------------------------------------------------------------

  async function loadOptions(date, force = false) {
    const cached = state.optionsByDate.get(date);
    if (!force && cached && Date.now() - cached.at < OPTIONS_TTL_MS) return cached.data;
    const response = await chrome.runtime.sendMessage({ type: "MLV_PLANNING_OPTIONS", date });
    if (!response?.ok) throw new Error(response?.error || "No se pudieron cargar vehículos, choferes y viajes");
    const data = {
      drivers: Array.isArray(response.drivers) ? response.drivers : [],
      vehicles: Array.isArray(response.vehicles) ? response.vehicles : [],
      trips: Array.isArray(response.trips) ? response.trips : [],
    };
    state.optionsByDate.set(date, { at: Date.now(), data });
    return data;
  }

  function vehicleById(options, id) {
    return options?.vehicles.find((vehicle) => vehicle.id === id) || null;
  }

  function tripTitle(trip) {
    if (trip.kind === "route") return `${trip.route_number}${trip.status === "en_curso" ? " · en curso" : " · programada"}`;
    return `${trip.ola_numbers.join(", ")} · espera paquetes`;
  }

  async function renderTrucks(force) {
    const list = bar.querySelector("[data-mlv-trucks-list]");
    const status = bar.querySelector("[data-mlv-trucks-status]");
    const date = bar.querySelector("[data-mlv-trucks-date]").value;
    if (!date) return;
    state.trucksDate = date;
    status.textContent = "Cargando…";
    try {
      const options = await loadOptions(date, force);
      if (state.trucksDate !== date) return;
      list.replaceChildren();
      const byVehicle = new Map();
      for (const trip of options.trips) {
        const key = trip.vehicle_id || "";
        byVehicle.set(key, [...(byVehicle.get(key) || []), trip]);
      }
      const vehicles = [...options.vehicles].sort((a, b) =>
        (byVehicle.has(b.id) ? 1 : 0) - (byVehicle.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name));
      for (const vehicle of vehicles) {
        list.append(truckCard(vehicle, byVehicle.get(vehicle.id) || []));
      }
      if (byVehicle.has("")) list.append(truckCard(null, byVehicle.get("")));
      status.textContent = `${options.trips.length} viaje${options.trips.length === 1 ? "" : "s"} activo${options.trips.length === 1 ? "" : "s"} el ${fmtDate(date)}`;
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function truckCard(vehicle, trips) {
    const card = document.createElement("div");
    card.className = "mlv-truck";
    const head = document.createElement("div");
    head.className = "mlv-truck-head";
    const name = document.createElement("strong");
    name.textContent = vehicle ? vehicle.name : "Sin vehículo asignado";
    head.append(name);
    if (vehicle) head.append(dim(capacityLabel(vehicle)));
    card.append(head);
    if (!trips.length) {
      card.append(dim("Libre"));
      return card;
    }
    for (const trip of trips) {
      const row = document.createElement("div");
      row.className = "mlv-truck-trip";
      row.append(stacked(tripTitle(trip), [trip.driver?.name || "Sin chofer", `${trip.items.length} SO`].join(" · ")));
      row.append(meter(trip.load, vehicle, true));
      card.append(row);
    }
    return card;
  }

  function capacityLabel(vehicle) {
    if (!vehicle) return "";
    const parts = [];
    if (num(vehicle.max_weight_kg)) parts.push(`${fmtKg(vehicle.max_weight_kg)} máx.`);
    if (num(vehicle.max_volume_m3)) parts.push(fmtM3(vehicle.max_volume_m3));
    return parts.length ? parts.join(" · ") : "Capacidad sin configurar en Milov";
  }

  /**
   * Ocupación por peso y volumen. La versión compacta (tarjetas de viaje) usa
   * una línea y una sola barra: la del recurso más ocupado.
   */
  function meter(load, vehicle, compact = false) {
    const status = capacityStatus(load, vehicle);
    const wrap = document.createElement("div");
    wrap.className = "mlv-meter" + (compact ? " mlv-meter-compact" : "");
    wrap.dataset.level = status.level;
    const weight = ["Peso", load.weight_kg, vehicle?.max_weight_kg, load.weight_complete, fmtKg, status.weight_percent];
    const volume = ["Volumen", load.volume_m3, vehicle?.max_volume_m3, load.volume_complete, fmtM3, status.volume_percent];
    const caption = ([, value, max, complete, fmt, percent]) =>
      `${complete ? "" : "≥ "}${fmt(value)}${num(max) ? ` / ${fmt(max)}` : ""}${percent !== null ? ` · ${percent.toFixed(0)}%` : ""}`;
    if (compact) {
      const line = document.createElement("div");
      line.className = "mlv-meter-line";
      const label = document.createElement("span");
      label.textContent = [caption(weight), num(load.volume_m3) || num(vehicle?.max_volume_m3) ? caption(volume) : null].filter(Boolean).join(" · ");
      line.append(label);
      const worst = (status.volume_percent ?? -1) > (status.weight_percent ?? -1) ? volume : weight;
      if (num(worst[2])) line.append(progressBar(worst[1], worst[2], `${worst[0]} ocupado`));
      wrap.append(line);
      return wrap;
    }
    const rows = [weight];
    if (num(vehicle?.max_volume_m3) || num(load.volume_m3)) rows.push(volume);
    for (const [label, value, max, complete, fmt, percent] of rows) {
      const line = document.createElement("div");
      line.className = "mlv-meter-line";
      const text = document.createElement("span");
      text.textContent = `${label}: ${caption([label, value, max, complete, fmt, percent])}`;
      line.append(text);
      if (num(max)) line.append(progressBar(value, max, `${label} ocupado`));
      wrap.append(line);
    }
    return wrap;
  }

  function progressBar(value, max, label) {
    const progress = document.createElement("progress");
    progress.max = num(max);
    progress.value = Math.min(num(value), num(max));
    progress.setAttribute("aria-label", label);
    return progress;
  }

  // --------------------------------------------------------------------------
  // Planeación del wave: fecha, camión (viaje) y chofer
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

  /**
   * Komodin rechaza el wave sin 2 salidas o con campos obligatorios vacíos
   * (Referencia, Slot). En ese caso se deja pasar su propia alerta y no se
   * guarda en Milov una OLA de un wave que no se va a crear.
   */
  function komodinWillReject() {
    const table = findWaveTable();
    const checked = table?.tBodies[0]?.querySelectorAll('input[type="checkbox"]:checked').length || 0;
    if (checked < 2) return true;
    // Mismo criterio que el botón de Komodin: todos los [data-required] del documento.
    return [...document.querySelectorAll("[data-required]")]
      .some((field) => !field.closest(".mlv-bar, .mlv-modal") && !String(field.value || "").trim());
  }

  function interceptWaveClick(event) {
    const action = event.target.closest?.('button, input[type="submit"], input[type="button"], a');
    if (!action || bypassClickOnce.has(action) || !isWaveCreateAction(action)) return;

    const selection = selectionBreakdown();
    if (selection.deliveries.length + selection.pickups.length === 0 || komodinWillReject()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    openPlanningModal({ type: "click", target: action, selection }).catch((error) => {
      console.error("[milov-ext] No se pudo abrir la planeación", error);
    });
  }

  function interceptWaveSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || bypassSubmitOnce.has(form)) return;
    const submitter = event.submitter;
    if (!isWaveCreateAction(submitter)) return;

    const selection = selectionBreakdown();
    if (selection.deliveries.length + selection.pickups.length === 0 || komodinWillReject()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    openPlanningModal({ type: "submit", form, submitter, selection }).catch((error) => {
      console.error("[milov-ext] No se pudo abrir la planeación", error);
    });
  }

  async function openPlanningModal(pendingAction) {
    ensurePlanningModal();
    const selection = pendingAction.selection;
    state.pendingKomodinAction = pendingAction;
    modal = {
      pending: pendingAction,
      selection,
      date: suggestedScheduledDate([...selection.deliveries, ...selection.pickups]),
      options: null,
      target: "new",
      vehicleId: "",
      driverId: "",
      confirmOver: false,
      loadToken: 0,
    };
    planningModal.hidden = false;
    document.documentElement.classList.add("mlv-modal-open");
    planningModal.querySelector("[data-mlv-plan-date]").value = modal.date;
    planningModal.querySelector("[data-mlv-plan-confirm]").checked = false;
    renderSelectionSummary();
    showPlanningError("");
    await reloadModalOptions(false);
  }

  async function reloadModalOptions(force) {
    const token = ++modal.loadToken;
    const saveButton = planningModal.querySelector("[data-mlv-plan-save]");
    saveButton.disabled = true;
    setPlanningModalStatus("Cargando viajes, vehículos y choferes…");
    try {
      const options = await loadOptions(modal.date, force);
      if (!modal || token !== modal.loadToken) return;
      modal.options = options;
      if (modal.target !== "new" && !options.trips.some((trip) => trip.key === modal.target)) modal.target = "new";
      renderPlanningOptions();
      setPlanningModalStatus("");
      saveButton.disabled = false;
    } catch (error) {
      if (!modal || token !== modal.loadToken) return;
      showPlanningError(error.message);
      setPlanningModalStatus("");
    }
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
            <p data-mlv-plan-summary></p>
          </div>
          <button type="button" class="mlv-modal-close" data-mlv-plan-cancel aria-label="Cerrar">×</button>
        </div>
        <details class="mlv-modal-sos">
          <summary data-mlv-plan-count></summary>
          <div data-mlv-plan-sos></div>
        </details>
        <form data-mlv-plan-form>
          <label class="mlv-field-inline">
            Fecha de salida
            <input type="date" data-mlv-plan-date required>
          </label>
          <div class="mlv-pickup-note" data-mlv-plan-pickups hidden></div>
          <fieldset class="mlv-trip-picker" data-mlv-plan-delivery>
            <legend>¿En qué camión va?</legend>
            <div class="mlv-trip-list" data-mlv-plan-trips role="radiogroup" aria-label="Viaje"></div>
            <div class="mlv-trip-fields">
              <label>Vehículo <select data-mlv-plan-vehicle></select></label>
              <label>Chofer <select data-mlv-plan-driver><option value="">Seleccionar chofer…</option></select></label>
            </div>
            <div class="mlv-vehicle-hint" data-mlv-plan-hint hidden></div>
            <div class="mlv-capacity" data-mlv-plan-capacity aria-live="polite"></div>
            <label class="mlv-confirm" data-mlv-plan-confirm-row hidden>
              <input type="checkbox" data-mlv-plan-confirm>
              Confirmo que la carga excede la capacidad del vehículo
            </label>
          </fieldset>
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
    planningModal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePlanningModal();
    });
    planningModal.querySelector("[data-mlv-plan-date]").addEventListener("change", (event) => {
      if (!event.target.value) return;
      modal.date = event.target.value;
      void reloadModalOptions(false);
    });
    planningModal.querySelector("[data-mlv-plan-trips]").addEventListener("change", (event) => {
      if (!event.target.matches("[data-mlv-trip]")) return;
      selectTarget(event.target.value);
    });
    planningModal.querySelector("[data-mlv-plan-vehicle]").addEventListener("change", (event) => {
      modal.vehicleId = event.target.value;
      renderCapacity();
    });
    planningModal.querySelector("[data-mlv-plan-driver]").addEventListener("change", (event) => {
      modal.driverId = event.target.value;
    });
    planningModal.querySelector("[data-mlv-plan-confirm]").addEventListener("change", (event) => {
      modal.confirmOver = event.target.checked;
    });
    planningModal.querySelector("[data-mlv-plan-form]").addEventListener("submit", saveWavePlan);
  }

  function renderSelectionSummary() {
    const { selection } = modal;
    const total = selection.deliveries.length + selection.pickups.length;
    const parts = [`${total} SO`];
    if (selection.deliveries.length) {
      parts.push(`${selection.load.weight_complete ? "" : "≥ "}${fmtKg(selection.load.weight_kg)} de reparto`);
      if (num(selection.load.volume_m3)) parts.push(fmtM3(selection.load.volume_m3));
    }
    planningModal.querySelector("[data-mlv-plan-summary]").textContent = parts.join(" · ");
    planningModal.querySelector("[data-mlv-plan-count]").textContent =
      `Ver SO (${selection.deliveries.length} reparto${selection.pickups.length ? `, ${selection.pickups.length} retiro en bodega` : ""}${selection.unknown ? `, ${selection.unknown} sin datos Milov` : ""})`;
    const sos = planningModal.querySelector("[data-mlv-plan-sos]");
    sos.replaceChildren();
    for (const so of selection.deliveries) sos.append(chip(so, ""));
    for (const so of selection.pickups) sos.append(chip(so, "amber", PICKUP_LABEL));

    const pickups = planningModal.querySelector("[data-mlv-plan-pickups]");
    pickups.hidden = selection.pickups.length === 0;
    pickups.textContent = selection.deliveries.length
      ? `${selection.pickups.length} SO de retiro en bodega: van en el wave de Komodin pero no se cargan al camión ni se asignan a ruta.`
      : "Todas las SO son de retiro en bodega: no necesitan camión ni chofer. Sus paquetes quedarán listos para entrega en bodega.";
    planningModal.querySelector("[data-mlv-plan-delivery]").hidden = selection.deliveries.length === 0;
  }

  function chip(label, tone, title) {
    const span = document.createElement("span");
    span.className = `mlv-chip-so${tone ? ` mlv-chip-${tone}` : ""}`;
    span.textContent = label;
    if (title) span.title = title;
    return span;
  }

  function renderPlanningOptions() {
    const { options } = modal;
    const tripsList = planningModal.querySelector("[data-mlv-plan-trips]");
    tripsList.replaceChildren();
    tripsList.append(tripOption("new", "Nuevo viaje", "Elige el vehículo y el chofer", null, null));
    for (const trip of options.trips) {
      const vehicle = vehicleById(options, trip.vehicle_id);
      tripsList.append(tripOption(
        trip.key,
        `${vehicle ? vehicle.name : "Sin vehículo"} · ${tripTitle(trip)}`,
        `${trip.driver?.name || "Sin chofer"} · ${trip.items.length} SO`,
        trip.load,
        vehicle,
      ));
    }
    if (!options.trips.length) {
      const empty = document.createElement("p");
      empty.className = "mlv-dim mlv-small";
      empty.textContent = `No hay viajes planificados para el ${fmtDate(modal.date)}.`;
      tripsList.append(empty);
    }

    const driverSelect = planningModal.querySelector("[data-mlv-plan-driver]");
    driverSelect.replaceChildren(new Option("Seleccionar chofer…", ""));
    for (const driver of options.drivers) driverSelect.append(new Option(personName(driver) || "Chofer", driver.id));
    selectTarget(modal.target);
  }

  function tripOption(value, title, subtitle, load, vehicle) {
    const label = document.createElement("label");
    label.className = "mlv-trip";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "mlv-trip";
    input.value = value;
    input.dataset.mlvTrip = "";
    const body = document.createElement("div");
    body.className = "mlv-trip-body";
    body.append(stacked(title, subtitle));
    if (load) body.append(meter(load, vehicle, true));
    label.append(input, body);
    return label;
  }

  function selectTarget(key) {
    modal.target = key;
    const trip = currentTrip();
    for (const input of planningModal.querySelectorAll("[data-mlv-trip]")) input.checked = input.value === key;

    const vehicleSelect = planningModal.querySelector("[data-mlv-plan-vehicle]");
    const driverSelect = planningModal.querySelector("[data-mlv-plan-driver]");
    if (trip) {
      modal.vehicleId = trip.vehicle_id || modal.vehicleId;
      modal.driverId = trip.driver?.id || modal.driverId;
    }
    fillVehicleOptions(vehicleSelect, modal.vehicleId);
    modal.vehicleId = vehicleSelect.value;
    // El chofer de un viaje existente puede ya no estar activo en el catálogo.
    if (trip?.driver && ![...driverSelect.options].some((option) => option.value === trip.driver.id)) {
      driverSelect.append(new Option(trip.driver.name, trip.driver.id));
    }
    driverSelect.value = modal.driverId;
    if (driverSelect.value !== modal.driverId) modal.driverId = "";
    // Un viaje existente conserva su vehículo y chofer; solo se completan si faltan.
    vehicleSelect.disabled = !!trip?.vehicle_id;
    driverSelect.disabled = !!trip?.driver;
    renderCapacity();
  }

  function currentTrip() {
    return modal.target === "new" ? null : modal.options?.trips.find((trip) => trip.key === modal.target) || null;
  }

  function fillVehicleOptions(select, value) {
    const { options } = modal;
    select.replaceChildren(new Option("Sin vehículo (no se valida capacidad)", ""));
    for (const vehicle of options.vehicles) {
      const trips = options.trips.filter((trip) => trip.vehicle_id === vehicle.id);
      const busy = trips.length
        ? `${trips.length} viaje${trips.length === 1 ? "" : "s"}: ${fmtKg(trips.reduce((sum, trip) => sum + num(trip.load.weight_kg), 0))}`
        : "libre";
      select.append(new Option(
        `${vehicle.name}${vehicle.plate && !vehicle.name.replace(/\s/g, "").includes(vehicle.plate.replace(/\s/g, "")) ? ` · ${vehicle.plate}` : ""} — ${capacityLabel(vehicle)} · ${busy}${vehicle.is_active === false ? " (inactivo)" : ""}`,
        vehicle.id,
      ));
    }
    select.value = value || "";
  }

  function renderCapacity() {
    const element = planningModal.querySelector("[data-mlv-plan-capacity]");
    const hint = planningModal.querySelector("[data-mlv-plan-hint]");
    const confirmRow = planningModal.querySelector("[data-mlv-plan-confirm-row]");
    const trip = currentTrip();
    const vehicle = vehicleById(modal.options, modal.vehicleId);
    const selected = new Set([...modal.selection.deliveries, ...modal.selection.pickups]);
    const remaining = (trip?.items || []).filter((item) => !item.sales_order_number || !selected.has(item.sales_order_number));
    const existing = combineLoads(remaining.map((item) => item.load));
    const total = combineLoads([existing, modal.selection.load]);
    const status = capacityStatus(total, vehicle);
    modal.status = status;

    element.replaceChildren();
    element.dataset.level = status.level;
    const title = document.createElement("strong");
    title.textContent = vehicle
      ? `${vehicle.name}: ${status.level === "exceeded" ? "excede su capacidad" : status.level === "unknown" ? "capacidad sin configurar en Milov" : "carga del viaje"}`
      : "Sin vehículo: se muestra la carga, pero no se valida capacidad";
    element.append(title, meter(total, vehicle));
    const detail = document.createElement("span");
    const wave = `${modal.selection.load.weight_complete ? "" : "≥ "}${fmtKg(modal.selection.load.weight_kg)}`;
    detail.textContent = remaining.length
      ? `Esta wave ${wave} + ya en el viaje ${existing.weight_complete ? "" : "≥ "}${fmtKg(existing.weight_kg)} (${remaining.length} SO).`
      : `Esta wave ${wave}.`;
    if (status.over_weight_kg) detail.textContent += ` Excede por ${fmtKg(status.over_weight_kg)}.`;
    if (status.over_volume_m3) detail.textContent += ` Excede por ${fmtM3(status.over_volume_m3)}.`;
    element.append(detail);
    if (!total.weight_complete || !total.volume_complete || modal.selection.unknown) element.append(missingDetails(total, modal.selection.unknown));

    // Mismo vehículo con otro viaje ese día: ofrecer sumarse en vez de crear otro.
    const others = vehicle ? modal.options.trips.filter((item) => item.vehicle_id === vehicle.id && item.key !== trip?.key) : [];
    hint.hidden = !(modal.target === "new" && others.length);
    hint.replaceChildren();
    if (!hint.hidden) {
      hint.append(text(`${vehicle.name} ya tiene ${others.length === 1 ? "un viaje" : `${others.length} viajes`} el ${fmtDate(modal.date)}: `));
      for (const other of others) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mlv-link";
        button.textContent = `Sumar a ${other.route_number || other.ola_numbers.join(", ")} (${fmtKg(other.load.weight_kg)})`;
        button.addEventListener("click", () => selectTarget(other.key));
        hint.append(button, text(" "));
      }
      hint.append(text("o crea un viaje nuevo si el camión sale dos veces."));
    }

    confirmRow.hidden = !status.exceeded;
    if (!status.exceeded) {
      modal.confirmOver = false;
      planningModal.querySelector("[data-mlv-plan-confirm]").checked = false;
    }
  }

  function missingDetails(load, unknownCount) {
    const details = document.createElement("details");
    details.className = "mlv-missing";
    const summary = document.createElement("summary");
    const count = load.missing.length;
    summary.textContent = [
      count ? `${count} producto${count === 1 ? "" : "s"} sin datos completos` : null,
      unknownCount ? `${unknownCount} salida${unknownCount === 1 ? "" : "s"} sin datos Milov` : null,
    ].filter(Boolean).join(" · ") + ": el total es un mínimo";
    details.append(summary);
    const list = document.createElement("ul");
    for (const item of load.missing.slice(0, 15)) {
      const li = document.createElement("li");
      li.append(text(`${item.sku} · ${item.name} (${fmtQty(item.quantity)} ${item.unit || ""}) — ${missingText(item)} `));
      // La extensión corre en Komodin: la ficha se abre en el mismo WMS.
      if (item.wms_product_id) {
        const link = document.createElement("a");
        link.href = `/products_console/?id=${encodeURIComponent(item.wms_product_id)}`;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Abrir ficha";
        li.append(link);
      }
      list.append(li);
    }
    if (load.missing.length > 15) list.append(Object.assign(document.createElement("li"), { textContent: `… y ${load.missing.length - 15} más` }));
    details.append(list);
    return details;
  }

  async function saveWavePlan(event) {
    event.preventDefault();
    const pending = state.pendingKomodinAction;
    if (!pending || !modal?.options) return;
    const { selection } = modal;
    const soNumbers = [...selection.deliveries, ...selection.pickups];
    if (soNumbers.length > 300) {
      showPlanningError("Selecciona como máximo 300 SO por wave.");
      return;
    }
    const scheduledDate = planningModal.querySelector("[data-mlv-plan-date]").value;
    const trip = currentTrip();
    const hasDelivery = selection.deliveries.length > 0;
    if (!scheduledDate) {
      showPlanningError("Selecciona la fecha de salida.");
      return;
    }
    if (hasDelivery && !modal.driverId) {
      showPlanningError("Selecciona el chofer del viaje.");
      return;
    }
    if (hasDelivery && modal.status?.exceeded && !modal.confirmOver) {
      showPlanningError("La carga excede la capacidad del vehículo. Elige otro camión o confirma el exceso.");
      planningModal.querySelector("[data-mlv-plan-confirm]").focus();
      return;
    }

    const saveButton = planningModal.querySelector("[data-mlv-plan-save]");
    saveButton.disabled = true;
    showPlanningError("");
    setPlanningModalStatus("Guardando planeación en Milov…");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "MLV_PLAN_WAVE",
        soNumbers,
        scheduledDate,
        driverId: hasDelivery ? modal.driverId : null,
        vehicleId: hasDelivery ? modal.vehicleId || null : null,
        routeId: hasDelivery && trip?.kind === "route" ? trip.route_id : null,
        olaId: hasDelivery && trip?.kind === "ola" ? trip.ola_id : null,
        confirmOverCapacity: modal.confirmOver,
      });
      if (!response?.ok) {
        // El servidor revalida la capacidad: otro usuario pudo cargar el mismo viaje.
        if (/excede su capacidad/i.test(response?.error || "")) {
          state.optionsByDate.delete(scheduledDate);
          planningModal.querySelector("[data-mlv-plan-confirm-row]").hidden = false;
        }
        throw new Error(response?.error || "No se pudo guardar el wave");
      }

      const olaNumber = response.ola?.internal_ola_number || "OLA";
      state.optionsByDate.delete(scheduledDate);
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
    modal = null;
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

  function tomorrowDate() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return localDate(tomorrow);
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
  // Carga: suma y ocupación (mismo criterio que milov-app)
  // --------------------------------------------------------------------------

  function combineLoads(loads) {
    let weight = 0;
    let volume = 0;
    let weightComplete = true;
    let volumeComplete = true;
    const missing = new Map();
    for (const load of loads) {
      if (!load) {
        weightComplete = false;
        volumeComplete = false;
        continue;
      }
      weight += num(load.weight_kg);
      volume += num(load.volume_m3);
      weightComplete = weightComplete && load.weight_complete !== false;
      volumeComplete = volumeComplete && load.volume_complete !== false;
      for (const item of load.missing || []) {
        const key = `${item.product_id || item.sku}|${item.unit}`;
        const current = missing.get(key);
        if (current) current.quantity += num(item.quantity);
        else missing.set(key, { ...item, quantity: num(item.quantity) });
      }
    }
    return {
      weight_kg: weight,
      volume_m3: volume,
      weight_complete: weightComplete,
      volume_complete: volumeComplete,
      missing: [...missing.values()].sort((a, b) => b.quantity - a.quantity),
    };
  }

  function capacityStatus(load, vehicle) {
    const maxWeight = num(vehicle?.max_weight_kg);
    const maxVolume = num(vehicle?.max_volume_m3);
    const weightPercent = maxWeight ? (num(load.weight_kg) / maxWeight) * 100 : null;
    const volumePercent = maxVolume ? (num(load.volume_m3) / maxVolume) * 100 : null;
    const percents = [weightPercent, volumePercent].filter((value) => value !== null);
    const worst = percents.length ? Math.max(...percents) : null;
    const level =
      worst === null ? "unknown" :
      worst > 100 ? "exceeded" :
      worst >= 90 || !load.weight_complete || (maxVolume && !load.volume_complete) ? "warning" :
      "ok";
    return {
      level,
      exceeded: worst !== null && worst > 100,
      weight_percent: weightPercent,
      volume_percent: volumePercent,
      over_weight_kg: maxWeight && load.weight_kg > maxWeight ? load.weight_kg - maxWeight : 0,
      over_volume_m3: maxVolume && load.volume_m3 > maxVolume ? load.volume_m3 - maxVolume : 0,
    };
  }

  // --------------------------------------------------------------------------
  // Estado / errores
  // --------------------------------------------------------------------------

  function setBarStatus(value) {
    const el = bar?.querySelector("[data-mlv-status]");
    if (el) el.textContent = value;
  }

  function showError(response) {
    const el = bar?.querySelector("[data-mlv-error]");
    if (!el) return;
    el.hidden = false;
    el.replaceChildren(text(response?.error || "Error consultando milov-app"), text(" "));
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
    return Number.isInteger(value) ? String(value) : value.toLocaleString("es-PA", { maximumFractionDigits: 2 });
  }

  function fmtKg(value) {
    const kg = num(value);
    return `${kg.toLocaleString("es-PA", { maximumFractionDigits: kg >= 100 ? 0 : 1 })} kg`;
  }

  function fmtM3(value) {
    return `${num(value).toLocaleString("es-PA", { maximumFractionDigits: 2 })} m³`;
  }

  function fmtDate(value) {
    const [year, month, day] = String(value).split("-");
    return year && month && day ? `${day}/${month}/${year}` : value;
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
