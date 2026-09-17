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
