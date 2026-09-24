const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

const load = (weight_kg, extra = {}) => ({ weight_kg, volume_m3: weight_kg / 500, weight_complete: true, volume_complete: true, missing: [], ...extra });

async function fixture(t, { rows = [1, 2, 3, 4], data = {}, trips = [] } = {}) {
  const page = await browser.newPage({ timezoneId: 'America/Panama' });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.setContent(`<form><input id="reff" name="Reff" data-required="Reff" value="W-1"><div id="prop"><table><thead><tr><th><input type="checkbox" id="all"></th><th>Reff</th><th>Cliente</th></tr></thead><tbody>${rows.map(n => `<tr><td><input type="checkbox" name="salida" value="${n}"></td><td>SO-${n}</td><td>Cliente ${n}</td></tr>`).join('')}</tbody></table></div><button type="button" id="create">Crear Wave</button></form>`);
  await page.addStyleTag({ path: path.join(__dirname, '../content.css') });
  await page.evaluate(({ data, trips, loadWeights }) => {
    // Simulates the WMS handler that previously selected every row, including hidden rows.
    document.querySelector('#all').onclick = event => document.querySelectorAll('tbody input').forEach(input => { input.checked = event.target.checked; });
    document.querySelector('#create').onclick = () => { window.resumed = true; };
    const date = new Date(); date.setDate(date.getDate() + 1);
    const tomorrow = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    window.tomorrow = tomorrow;
    const load = kg => ({ weight_kg: kg, volume_m3: kg / 500, weight_complete: true, volume_complete: true, missing: [] });
    window.data = Object.fromEntries([1, 2, 3].map(n => [`SO-${n}`, {
      route: { name: `Zona ${n}` }, delivery_route: { name: `Ruta ${n}` },
      delivery_date: n < 3 ? tomorrow : '2099-01-01',
      quantities: { total: n * 10, dry: n * 10, cold: 0, frozen: 0 }, pickup_at_warehouse: false,
      load: load(loadWeights[n - 1]),
    }]));
    for (const [so, info] of Object.entries(data)) window.data[so] = { ...(window.data[so] || {}), ...info };
    window.options = {
      ok: true,
      drivers: [{ id: 'd1', first_name: 'Ana', last_name: 'Ruiz' }, { id: 'd2', first_name: 'Luis' }],
      vehicles: [
        { id: 'v1', name: 'Hino 500', plate: 'CA3116', max_weight_kg: 1000, max_volume_m3: 6, is_active: true },
        { id: 'v2', name: 'Panel', plate: 'EI5852', max_weight_kg: 400, max_volume_m3: null, is_active: true },
        { id: 'v3', name: 'Rush', plate: null, max_weight_kg: null, max_volume_m3: null, is_active: true },
      ],
      trips: trips.map(trip => ({ ...trip, items: trip.items.map(item => ({ ...item, load: load(item.kg) })), load: load(trip.items.reduce((sum, item) => sum + item.kg, 0)) })),
    };
    window.messages = [];
    window.planResponse = { ok: true, ola: { internal_ola_number: 'OLA-1' } };
    window.chrome = { runtime: { sendMessage: async message => {
      window.messages.push(message);
      if (message.type === 'MLV_ENRICH') return { ok: true, salesOrders: window.data };
      if (message.type === 'MLV_PLANNING_OPTIONS') return window.options;
      if (message.type === 'MLV_PLAN_WAVE') return window.planResponse;
    } } };
  }, { data, trips, loadWeights: [200, 300, 900] });
  await page.addScriptTag({ path: path.join(__dirname, '../content.js') });
  await page.waitForFunction(() => document.querySelector('[data-mlv-route]') && document.querySelector('[data-mlv-key="peso"]')?.textContent.includes('kg'));
  return page;
}

async function openPlanning(page) {
  await page.locator('#create').click();
  await page.waitForFunction(() => !document.querySelector('[data-mlv-plan-save]').disabled);
}
const planMessage = page => page.evaluate(() => window.messages.find(message => message.type === 'MLV_PLAN_WAVE'));

test('route filter supports several routes, closes on outside click/Escape, and select-all respects filters', async t => {
  const page = await fixture(t);
  assert.match(await page.locator('tbody tr').first().locator('[data-mlv-key="ruta"]').innerText(), /Ruta 1\nZona 1/);
  await page.locator('.mlv-route-filter summary').click();
  await page.locator('[data-mlv-route][value="Ruta 1"]').check();
  await page.locator('[data-mlv-route][value="Ruta 2"]').check();
  assert.equal(await page.locator('.mlv-route-filter').evaluate(details => details.open), true);
  await page.locator('#prop').click({ position: { x: 5, y: 5 } });
  assert.equal(await page.locator('.mlv-route-filter').evaluate(details => details.open), false);
  await page.locator('.mlv-route-filter summary').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.mlv-route-filter').evaluate(details => details.open), false);
  assert.match(await page.locator('[data-mlv-routes-label]').innerText(), /Rutas \(2\)/);
  await page.locator('#all').check();
  assert.deepEqual(await page.locator('tbody input:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['1', '2']);
  assert.match(await page.locator('[data-mlv-selection]').innerText(), /2 seleccionadas · 30 unid\. · 500 kg/);
  await page.locator('#all').focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('tbody input:checked').count(), 0);
  await page.locator('[data-mlv-clear]').click();
  assert.equal(await page.locator('tbody tr:visible').count(), 4);
});

test('tomorrow uses local date, combines with search and clears hidden selections', async t => {
  const page = await fixture(t);
  await page.locator('#all').check();
  await page.locator('[data-mlv-tomorrow]').click();
  assert.equal(await page.locator('[data-mlv-filter="entrega"]').inputValue(), await page.evaluate(() => window.tomorrow));
  assert.deepEqual(await page.locator('tbody input:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['1', '2']);
  await page.locator('input[data-mlv-search]').fill('Cliente 2');
  assert.equal(await page.locator('tbody input:checked').count(), 1);
  await page.locator('input[data-mlv-search]').fill('no existe');
  assert.equal(await page.locator('tbody input:checked').count(), 0);
});

test('long notes keep line breaks, show three lines and expand on demand', async t => {
  const notes = 'SANDRA MONTENEGRO\nENTREGAR EN PAITILLA ROYAL CENTER, SECCION 1 PISO 1\nDEJARLO EN LA RECEPCIÓN DEL PISO\nPEDIDO PAGADO';
  const page = await fixture(t, { data: { 'SO-1': { notes } } });
  const cell = page.locator('tbody tr').first().locator('[data-mlv-key="notas"]');
  const text = cell.locator('.mlv-notes-text');
  assert.equal(await text.evaluate(element => getComputedStyle(element).whiteSpace), 'pre-line');
  const collapsed = await text.evaluate(element => element.clientHeight);
  await cell.getByRole('button', { name: 'Ver más' }).click();
  assert.ok(await text.evaluate(element => element.clientHeight) > collapsed);
  assert.equal(await text.innerText(), notes);
  assert.equal(await page.locator('tbody tr').first().locator('input').isChecked(), false);
});

test('weight column marks partial loads and explains missing product data', async t => {
  const page = await fixture(t, { data: { 'SO-1': { load: load(120, { weight_complete: false, missing: [{ sku: 'PS0001006', name: 'Orasi Almendra', quantity: 24, unit: 'PCS', missing: ['weight'], product_id: 'p1', wms_product_id: 'SKU-000123' }] }) } } });
  const cell = page.locator('tbody tr').first().locator('[data-mlv-key="peso"]');
  assert.match(await cell.innerText(), /≥ 120 kg\nParcial/);
  assert.match(await cell.locator('.mlv-badge').getAttribute('title'), /PS0001006 Orasi Almendra: falta en Komodin peso de caja/);
});

test('warehouse pickups are labeled, filterable and excluded from truck weight', async t => {
  const page = await fixture(t, { data: { 'SO-2': { pickup_at_warehouse: true } } });
  assert.match(await page.locator('tbody tr').nth(1).locator('[data-mlv-key="tipo"]').innerText(), /Retiro en bodega/);
  assert.match(await page.locator('tbody tr').nth(1).locator('[data-mlv-key="chofer"]').innerText(), /Retira cliente/);
  await page.locator('[data-mlv-filter="tipo"]').selectOption('Retiro en bodega');
  assert.equal(await page.locator('tbody tr:visible').count(), 1);
  await page.locator('[data-mlv-clear]').click();
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  assert.match(await page.locator('[data-mlv-selection]').innerText(), /200 kg.*1 retiro en bodega \(no van en camión\)/);
});

test('trucks panel shows each vehicle load for the day and free vehicles', async t => {
  const page = await fixture(t, { trips: [{ key: 'route:r1', kind: 'route', route_id: 'r1', route_number: 'RUTA-10', status: 'programada', ola_numbers: [], driver: { id: 'd1', name: 'Ana Ruiz' }, vehicle_id: 'v1', items: [{ sales_order_number: 'SO-90', kg: 820 }] }] });
  await page.locator('[data-mlv-tomorrow]').click();
  await page.locator('[data-mlv-trucks-toggle]').click();
  await page.waitForFunction(() => document.querySelector('[data-mlv-trucks-list]').children.length === 3);
  const first = page.locator('.mlv-truck').first();
  assert.match(await first.innerText(), /Hino 500[\s\S]*RUTA-10 · programada[\s\S]*Ana Ruiz · 1 SO[\s\S]*820 kg \/ 1,000 kg · 82%/);
  assert.match(await page.locator('.mlv-truck').nth(1).innerText(), /Panel[\s\S]*Libre/);
  assert.match(await page.locator('.mlv-truck').nth(2).innerText(), /Capacidad sin configurar/);
  const message = await page.evaluate(() => window.messages.find(item => item.type === 'MLV_PLANNING_OPTIONS'));
  assert.equal(message.date, await page.evaluate(() => window.tomorrow));
});

test('new trip: vehicle capacity, excess confirmation and saved payload', async t => {
  const page = await fixture(t);
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await openPlanning(page);
  assert.equal(await page.locator('[data-mlv-plan-date]').inputValue(), await page.evaluate(() => window.tomorrow));
  assert.match(await page.locator('[data-mlv-plan-summary]').innerText(), /2 SO · 500 kg de reparto/);
  await page.locator('[data-mlv-plan-vehicle]').selectOption('v1');
  assert.match(await page.locator('[data-mlv-plan-capacity]').innerText(), /500 kg \/ 1,000 kg · 50%/);
  assert.equal(await page.locator('[data-mlv-plan-capacity]').getAttribute('data-level'), 'ok');
  await page.locator('[data-mlv-plan-vehicle]').selectOption('v2');
  assert.equal(await page.locator('[data-mlv-plan-capacity]').getAttribute('data-level'), 'exceeded');
  assert.match(await page.locator('[data-mlv-plan-capacity]').innerText(), /Excede por 100 kg/);
  await page.locator('[data-mlv-plan-driver]').selectOption('d2');
  await page.locator('[data-mlv-plan-save]').click();
  assert.match(await page.locator('[data-mlv-plan-error]').innerText(), /excede la capacidad/);
  assert.equal(await planMessage(page), undefined);
  await page.locator('[data-mlv-plan-confirm]').check();
  await page.locator('[data-mlv-plan-save]').click();
  await page.waitForFunction(() => window.resumed);
  const message = await planMessage(page);
  assert.deepEqual(message.soNumbers, ['SO-1', 'SO-2']);
  assert.equal(message.vehicleId, 'v2'); assert.equal(message.driverId, 'd2');
  assert.equal(message.routeId, null); assert.equal(message.olaId, null);
  assert.equal(message.confirmOverCapacity, true);
});

test('joining an existing trip adds its current load, locks its vehicle and driver, and sends the target', async t => {
  const page = await fixture(t, { trips: [
    { key: 'route:r1', kind: 'route', route_id: 'r1', route_number: 'RUTA-10', status: 'programada', ola_numbers: [], driver: { id: 'd1', name: 'Ana Ruiz' }, vehicle_id: 'v1', items: [{ sales_order_number: 'SO-90', kg: 300 }, { sales_order_number: 'SO-1', kg: 999 }] },
    { key: 'ola:o2', kind: 'ola', route_id: null, route_number: null, ola_id: 'o2', status: 'pendiente', ola_numbers: ['OLA-2'], driver: { id: 'd9', name: 'Chofer inactivo' }, vehicle_id: null, items: [{ sales_order_number: 'SO-91', kg: 100 }] },
  ] });
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await openPlanning(page);
  // Mismo vehículo con un viaje ese día: se ofrece sumarse.
  await page.locator('[data-mlv-plan-vehicle]').selectOption('v1');
  assert.match(await page.locator('[data-mlv-plan-hint]').innerText(), /Hino 500 ya tiene un viaje/);
  await page.locator('[data-mlv-plan-hint] button').click();
  assert.equal(await page.locator('[data-mlv-trip][value="route:r1"]').isChecked(), true);
  assert.equal(await page.locator('[data-mlv-plan-vehicle]').isDisabled(), true);
  assert.equal(await page.locator('[data-mlv-plan-driver]').inputValue(), 'd1');
  // SO-1 ya estaba en el viaje: se reemplaza, no se suma dos veces.
  assert.match(await page.locator('[data-mlv-plan-capacity]').innerText(), /800 kg \/ 1,000 kg[\s\S]*ya en el viaje 300 kg \(1 SO\)/);
  await page.locator('[data-mlv-trip][value="ola:o2"]').check();
  assert.equal(await page.locator('[data-mlv-plan-vehicle]').isDisabled(), false);
  assert.equal(await page.locator('[data-mlv-plan-driver]').inputValue(), 'd9');
  await page.locator('[data-mlv-plan-vehicle]').selectOption('v1');
  await page.locator('[data-mlv-plan-save]').click();
  await page.waitForFunction(() => window.resumed);
  const message = await planMessage(page);
  assert.equal(message.olaId, 'o2'); assert.equal(message.routeId, null);
  assert.equal(message.vehicleId, 'v1'); assert.equal(message.driverId, 'd9');
});

test('pickup-only waves skip truck and driver; mixed waves show the pickup note', async t => {
  const page = await fixture(t, { data: { 'SO-1': { pickup_at_warehouse: true }, 'SO-2': { pickup_at_warehouse: true } } });
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await openPlanning(page);
  assert.equal(await page.locator('[data-mlv-plan-delivery]').isVisible(), false);
  assert.match(await page.locator('[data-mlv-plan-pickups]').innerText(), /no necesitan camión ni chofer/);
  await page.locator('[data-mlv-plan-save]').click();
  await page.waitForFunction(() => window.resumed);
  const message = await planMessage(page);
  assert.deepEqual(message.soNumbers, ['SO-1', 'SO-2']);
  assert.equal(message.driverId, null); assert.equal(message.vehicleId, null);
});

test('server-side capacity rejection keeps the dialog open and asks for confirmation', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.planResponse = { ok: false, error: 'Hino 500 excede su capacidad por 120 kg. Confirma el exceso para guardar.' }; });
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await openPlanning(page);
  await page.locator('[data-mlv-plan-vehicle]').selectOption('v1');
  await page.locator('[data-mlv-plan-driver]').selectOption('d1');
  await page.locator('[data-mlv-plan-save]').click();
  await page.waitForFunction(() => !document.querySelector('[data-mlv-plan-error]').hidden);
  assert.match(await page.locator('[data-mlv-plan-error]').innerText(), /excede su capacidad por 120 kg/);
  assert.equal(await page.locator('[data-mlv-plan-confirm-row]').isVisible(), true);
  assert.equal(await page.evaluate(() => window.resumed), undefined);
});

test('Komodin validations win: fewer than two outbounds or a missing reference never opens the dialog', async t => {
  const page = await fixture(t);
  await page.locator('tbody tr').first().locator('input').check();
  await page.locator('#create').click();
  assert.equal(await page.evaluate(() => window.resumed), true);
  assert.equal(await page.locator('.mlv-modal').count(), 0);
  await page.evaluate(() => { window.resumed = false; document.querySelector('#reff').value = ''; });
  await page.locator('tbody tr').nth(1).locator('input').check();
  await page.locator('#create').click();
  assert.equal(await page.evaluate(() => window.resumed), true);
  assert.equal(await page.locator('.mlv-modal').count(), 0);
});

test('filter survives WMS table replacement without duplicate headers', async t => {
  const page = await fixture(t);
  await page.locator('[data-mlv-tomorrow]').click();
  await page.evaluate(() => {
    const table = document.querySelector('table');
    const clone = table.cloneNode(true);
    delete clone.dataset.mlvDone; delete clone.dataset.mlvSelBound;
    clone.querySelectorAll('.mlv-cell,.mlv-col').forEach(cell => cell.remove());
    table.replaceWith(clone);
  });
  await page.waitForFunction(() => document.querySelector('table[data-mlv-done="1"] [data-mlv-key="entrega"]')?.textContent === window.tomorrow);
  assert.equal(await page.locator('tbody tr:visible').count(), 2);
  assert.equal(await page.locator('th.mlv-col').count(), 7);
});
