const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('large WMS tables enrich every SO in batches without caching the tail as missing', async () => {
  const sizes = [];
  const context = {
    chrome:{storage:{local:{get:async () => ({apiBase:'https://example.test',apiKey:'test-only'})}},runtime:{onMessage:{addListener() {}}}},
    fetch:async (_url, options) => {
      const numbers = JSON.parse(options.body).sales_order_numbers;
      sizes.push(numbers.length);
      return {ok:true,status:200,json:async () => ({sales_orders:Object.fromEntries(numbers.map(so => [so,{sales_order_number:so}]))})};
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../background.js'),'utf8') + '\nglobalThis.enrichForTest = handleEnrich;', context);
  const numbers = Array.from({length:650},(_value,index) => `SO-${index+1}`);
  const result = await context.enrichForTest(numbers);
  assert.equal(Object.keys(result.salesOrders).length,650);
  assert.deepEqual(sizes,[300,300,50]);
  const cached = await context.enrichForTest(numbers);
  assert.equal(Object.keys(cached.salesOrders).length,650);
  assert.equal(sizes.length,3);
});

function exportFixture({ status = 200, mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', apiKey = 'test-only', downloadError = false } = {}) {
  const fetches = [], downloads = [];
  let listener;
  const context = {
    Uint8Array, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    chrome: {
      storage: { local: { get: async () => ({ apiBase: 'https://example.test', apiKey }) } },
      downloads: { download: async options => { if (downloadError) throw new Error('Download denied'); downloads.push(options); return 42; } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return {
        ok: status === 200, status,
        headers: new Headers({ 'Content-Type': mime, 'Content-Disposition': 'attachment; filename="OLA-1.xlsx"' }),
        arrayBuffer: async () => Uint8Array.from([80, 75, 3, 4, 255]).buffer,
        json: async () => ({ error: 'Export rejected' }),
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'), context);
  return { fetches, downloads, send: message => new Promise(resolve => listener(message, {}, resolve)) };
}

test('Excel downloads use authenticated POST and Chrome-owned binary downloads without exposing credentials', async () => {
  const fixture = exportFixture();
  const result = await fixture.send({ type: 'MLV_EXPORT_OLA', olaId: 'ola-1', report: 'frozen' });
  assert.equal(result.ok, true);
  assert.equal(result.downloadId, 42);
  assert.equal(fixture.fetches[0].url, 'https://example.test/api/sales-order-planning/export-xlsx');
  assert.equal(fixture.fetches[0].options.headers.Authorization, 'Bearer test-only');
  assert.deepEqual(JSON.parse(fixture.fetches[0].options.body), { ola_ids: ['ola-1'], report: 'frozen' });
  assert.equal(fixture.downloads[0].filename, 'OLA-1.xlsx');
  assert.deepEqual([...Buffer.from(fixture.downloads[0].url.split(',')[1], 'base64')], [80, 75, 3, 4, 255]);
  assert.equal(JSON.stringify(result).includes('test-only'), false);
});

test('failed auth, HTML redirects, invalid requests and download errors cannot report a successful Excel', async () => {
  for (const options of [{ status: 401 }, { status: 403 }, { status: 500 }, { mime: 'text/html' }, { apiKey: '' }, { downloadError: true }]) {
    const fixture = exportFixture(options);
    const result = await fixture.send({ type: 'MLV_EXPORT_OLA', olaId: 'ola-1', report: 'routes' });
    assert.equal(result.ok, false);
    assert.equal(fixture.downloads.length, 0);
  }
  const fixture = exportFixture();
  assert.equal((await fixture.send({ type: 'MLV_EXPORT_OLA', report: 'routes' })).ok, false);
  assert.equal(fixture.fetches.length, 0);
});
