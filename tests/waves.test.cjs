const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, synced = false) {
  const page = await browser.newPage({ timezoneId: 'America/Monterrey' });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.setContent(`<div id="prop"><table><thead><tr><th><input type="checkbox" id="all"></th><th>Reff</th><th>Cliente</th></tr></thead><tbody>${[1,2,3,4].map(n => `<tr><td><input type="checkbox" name="salida" value="${n}"></td><td>SO-${n}</td><td>Cliente ${n}</td></tr>`).join('')}</tbody></table></div><button id="create">Crear Wave</button>`);
  await page.addStyleTag({ path: path.join(__dirname, '../content.css') });
  await page.evaluate(synced => {
    // Simulates the WMS handler that previously selected every row, including hidden rows.
    document.querySelector('#all').onclick = event => document.querySelectorAll('tbody input').forEach(input => { input.checked = event.target.checked; });
    document.querySelector('#create').onclick = () => { window.resumed = true; };
    const date = new Date(); date.setDate(date.getDate() + 1);
    const tomorrow = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    window.tomorrow = tomorrow;
    const vehicle = { id:'v1',name:'Camión 1',plate:'ABC',capacity_boxes:30,is_active:true };
    if (synced) Object.assign(vehicle,{wms_id:'17',wms_capacity_bins:2,wms_warehouse:'Bodega Principal',capacity_boxes:null});
    window.capacityResult={ok:true,complete:true,total_pallets:0.5,existing_pallets:0,capacity_pallets:2,percent:25,missing:[]};
    window.data = Object.fromEntries([1,2,3].map(n => [`SO-${n}`, {
      route:{name:`Zona ${n}`}, delivery_route:{name:`Ruta ${n}`},
      delivery_date:n < 3 ? tomorrow : '2099-01-01',
      quantities:{total:n*10,dry:n*10,cold:0,frozen:0},pickup_at_warehouse:false,
    }]));
    window.messages = [];
    window.chrome = { runtime:{sendMessage:async message => {
      window.messages.push(message);
      if(message.type === 'MLV_ENRICH') return {ok:true,salesOrders:window.data};
      if(message.type === 'MLV_PLANNING_OPTIONS') return {ok:true,drivers:[{id:'d1',first_name:'Ana'}],vehicles:[vehicle,{id:'v2',name:'Van',capacity_boxes:20,is_active:true}],routes:[{id:'r1',route_number:'R-1',driver_id:'d1',scheduled_date:tomorrow,vehicle_id:'v1',vehicle,assigned_load:[{sales_order_number:'SO-99',quantity:15}]}]};
      if(message.type === 'MLV_CAPACITY') return window.holdCapacity ? new Promise(resolve => {window.resolveCapacity=resolve;}) : window.capacityResult;
      if(message.type === 'MLV_PLAN_WAVE') return {ok:true,ola:{internal_ola_number:'OLA-1'}};
    }}};
  }, synced);
  await page.addScriptTag({ path: path.join(__dirname, '../content.js') });
  await page.waitForFunction(() => document.querySelector('[data-mlv-route]') && document.querySelector('[data-mlv-vehicle] option[value="v1"]'));
  return page;
}

test('route/zone mapping, multiple routes and select-all respect filtered rows', async t => {
  const page = await fixture(t);
  assert.equal(await page.locator('th').filter({hasText:'Factura'}).count(), 0);
  assert.match(await page.locator('tbody tr').first().locator('[data-mlv-key="ruta"]').innerText(), /Ruta 1\nZona 1/);
  await page.locator('.mlv-route-filter summary').click();
  await page.locator('[data-mlv-route][value="Ruta 1"]').check();
  await page.locator('[data-mlv-route][value="Ruta 2"]').check();
  await page.locator('.mlv-route-filter summary').click();
  await page.locator('#all').check();
  assert.deepEqual(await page.locator('tbody input:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['1','2']);
  assert.match(await page.locator('[data-mlv-selection]').innerText(), /30 cj/);
  await page.locator('#all').focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('tbody input:checked').count(), 0);
  await page.locator('#all').focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('tbody input:checked').count(), 2);
  await page.locator('[data-mlv-filter="zona"]').selectOption('Zona 1');
  assert.equal(await page.locator('tbody input:checked').count(), 1);
  await page.locator('[data-mlv-clear]').click();
  assert.equal(await page.locator('tbody tr:visible').count(), 4);
  assert.equal(await page.locator('#all').evaluate(input => input.indeterminate), true);
});

test('tomorrow uses local date, combines with search and clears hidden selections', async t => {
  const page = await fixture(t);
  await page.locator('#all').check();
  await page.locator('[data-mlv-tomorrow]').click();
  assert.equal(await page.locator('[data-mlv-filter="entrega"]').inputValue(), await page.evaluate(() => window.tomorrow));
  assert.deepEqual(await page.locator('tbody input:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['1','2']);
  await page.locator('input[data-mlv-search]').fill('Cliente 2');
  assert.equal(await page.locator('tbody input:checked').count(), 1);
  await page.locator('input[data-mlv-search]').fill('no existe');
  assert.equal(await page.locator('tbody input:checked').count(), 0);
  await page.locator('#all').click();
  assert.equal(await page.locator('tbody input:checked').count(), 0);
});

test('capacity shows exact limit, excess and unknown quantities', async t => {
  const page = await fixture(t);
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await page.locator('[data-mlv-vehicle]').selectOption('v1');
  assert.match(await page.locator('[data-mlv-capacity]').innerText(), /30 \/ 30 cajas · 100.0%/);
  await page.locator('[data-mlv-vehicle]').selectOption('v2');
  assert.match(await page.locator('[data-mlv-capacity]').innerText(), /Excede por 10 cajas/);
  assert.equal(await page.locator('[data-mlv-capacity]').getAttribute('data-level'), 'exceeded');
  await page.locator('[data-mlv-clear]').click(); await page.locator('#all').check();
  assert.match(await page.locator('[data-mlv-capacity]').innerText(), /Total parcial: 1 salidas sin cantidad/);
});

test('planning sends only filtered SOs and selected vehicle before resuming WMS', async t => {
  const page = await fixture(t);
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await page.locator('[data-mlv-vehicle]').selectOption('v2');
  await page.locator('#create').click();
  await page.waitForFunction(() => !document.querySelector('[data-mlv-plan-save]').disabled);
  assert.equal(await page.locator('[data-mlv-plan-vehicle]').inputValue(), 'v2');
  await page.locator('[data-mlv-plan-driver]').selectOption('d1');
  await page.locator('[data-mlv-plan-save]').click();
  await page.waitForFunction(() => window.resumed);
  const message = await page.evaluate(() => window.messages.find(message => message.type === 'MLV_PLAN_WAVE'));
  assert.deepEqual(message.soNumbers, ['SO-1','SO-2']); assert.equal(message.vehicleId, 'v2');
});

test('reused route locks vehicle and includes previously assigned boxes', async t => {
  const page = await fixture(t);
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await page.locator('#create').click();
  await page.waitForFunction(() => !document.querySelector('[data-mlv-plan-save]').disabled);
  await page.locator('[data-mlv-plan-route]').selectOption('r1');
  assert.equal(await page.locator('[data-mlv-plan-vehicle]').isDisabled(), true);
  assert.match(await page.locator('[data-mlv-plan-capacity]').innerText(), /45 \/ 30 cajas/);
  assert.match(await page.locator('[data-mlv-plan-capacity]').innerText(), /15 cajas ya asignadas/);
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
  assert.equal(await page.locator('th.mlv-col').count(), 8);
});


test('WMS vehicle capacity uses per-product pallets and sends the reused route', async t => {
  const page = await fixture(t, true);
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await page.locator('[data-mlv-vehicle]').selectOption('v1');
  await page.waitForFunction(() => document.querySelector('[data-mlv-capacity]').textContent.includes('25.0%'));
  assert.match(await page.locator('[data-mlv-capacity]').innerText(), /0.5 \/ 2 pallets equivalentes/);
  assert.equal(await page.locator('[data-mlv-capacity] progress').count(),1);
  await page.locator('#create').click();
  await page.waitForFunction(() => !document.querySelector('[data-mlv-plan-save]').disabled);
  await page.locator('[data-mlv-plan-route]').selectOption('r1');
  await page.waitForFunction(() => window.messages.some(message => message.type === 'MLV_CAPACITY' && message.routeId === 'r1'));
  const message=await page.evaluate(() => window.messages.find(message => message.type === 'MLV_CAPACITY' && message.routeId === 'r1'));
  assert.deepEqual(message.soNumbers,['SO-1','SO-2']);assert.equal(message.vehicleId,'v1');
});

test('missing pallet rules show an incomplete indicator without a misleading percentage', async t => {
  const page = await fixture(t, true);
  await page.evaluate(() => { window.capacityResult={...window.capacityResult,complete:false,percent:null,missing:[{sku:'PS1',reason:'Falta regla activa'}]}; });
  await page.locator('[data-mlv-tomorrow]').click();await page.locator('#all').check();
  await page.locator('[data-mlv-vehicle]').selectOption('v1');
  await page.waitForFunction(() => document.querySelector('[data-mlv-capacity]').textContent.includes('Cálculo incompleto'));
  assert.equal(await page.locator('[data-mlv-capacity] progress').count(),0);
  assert.doesNotMatch(await page.locator('[data-mlv-capacity]').innerText(), /%/);
  assert.match(await page.locator('[data-mlv-capacity]').innerText(), /PS1: Falta regla activa/);
});

test('slow WMS capacity response cannot overwrite a newer vehicle selection', async t => {
  const page = await fixture(t, true);
  await page.evaluate(() => {window.holdCapacity=true;});
  await page.locator('[data-mlv-tomorrow]').click();await page.locator('#all').check();
  await page.locator('[data-mlv-vehicle]').selectOption('v1');
  await page.waitForFunction(() => window.resolveCapacity);
  await page.locator('[data-mlv-vehicle]').selectOption('v2');
  await page.evaluate(() => window.resolveCapacity(window.capacityResult));
  assert.match(await page.locator('[data-mlv-capacity]').innerText(), /30 \/ 20 cajas/);
});

test('wave creation still succeeds without a vehicle', async t => {
  const page = await fixture(t, true);
  await page.locator('[data-mlv-tomorrow]').click(); await page.locator('#all').check();
  await page.locator('#create').click();
  await page.waitForFunction(() => !document.querySelector('[data-mlv-plan-save]').disabled);
  await page.locator('[data-mlv-plan-driver]').selectOption('d1');
  await page.locator('[data-mlv-plan-save]').click();
  await page.waitForFunction(() => window.resumed);
  const message = await page.evaluate(() => window.messages.find(message => message.type === 'MLV_PLAN_WAVE'));
  assert.equal(message.vehicleId,null);
});
