import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows } from '../src/review.js';
import {
  buildCustomerPriceListItems,
  generateCustomerPriceListPdf
} from '../src/price_list_pdf.js';

function makeCatalogRows() {
  return buildRows([
    { name: "Tito's Handmade Vodka 750ml", barcode: '619947000020', category: 'LIQUOR/SPIRITS', price: '24.99', cost: '16.00', supplier: 'Southern Glazers' },
    { name: 'Corona Extra 12oz 6-Pack', barcode: '080660956053', category: 'BEER', price: '11.99', cost: '8.25', supplier: 'Constellation' },
    { name: 'Barefoot Pinot Grigio 750ml', barcode: '085000016145', category: 'WINE', price: '8.49', cost: '5.10', supplier: 'Gallo' },
    { name: 'Blue Moon Belgian White 12oz 6-Pack', barcode: '071990316006', category: 'BEER', price: '12.49', cost: '8.50', supplier: 'Molson Coors' }
  ]);
}

test('buildCustomerPriceListItems includes only name, category, and price and excludes barcode/SKU/cost', () => {
  const rows = makeCatalogRows();
  const items = buildCustomerPriceListItems(rows);

  assert.equal(items.length, 4);
  // Sorted alphabetically by Category (BEER, LIQUOR/SPIRITS, WINE) then Item Name
  assert.equal(items[0].category, 'BEER');
  assert.equal(items[0].name, 'Blue Moon Belgian White 12oz 6-Pack');
  assert.equal(items[0].formattedPrice, '$12.49');

  assert.equal(items[1].category, 'BEER');
  assert.equal(items[1].name, 'Corona Extra 12oz 6-Pack');

  // Verify strictly customer-safe keys only (no barcode, sku, cost, supplier)
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ['category', 'formattedPrice', 'name', 'price']);
    assert.equal('barcode' in item, false);
    assert.equal('sku' in item, false);
    assert.equal('cost' in item, false);
    assert.equal('supplier' in item, false);
  }
});

test('buildCustomerPriceListItems supports single-category filtering', () => {
  const rows = makeCatalogRows();
  const beerOnly = buildCustomerPriceListItems(rows, { categoryFilter: 'BEER' });
  assert.equal(beerOnly.length, 2);
  assert.ok(beerOnly.every((i) => i.category === 'BEER'));
});

test('generateCustomerPriceListPdf generates multi-page PDF without barcodes or SKUs', () => {
  const rows = makeCatalogRows();
  const doc = generateCustomerPriceListPdf(rows, {
    storeName: '777 Liquor Store',
    title: 'Customer Price List',
    groupByCategory: true
  });

  assert.equal(doc.getNumberOfPages(), 1);
  const rawPdf = doc.output('datauristring');
  assert.ok(rawPdf.startsWith('data:application/pdf'));

  // Inspect uncompressed internal page stream to confirm items appear and barcodes do NOT
  const pageStream = doc.internal.pages[1].join('\n');
  assert.ok(pageStream.includes('Corona Extra 12oz 6-Pack'));
  assert.ok(pageStream.includes('$11.99'));
  assert.ok(pageStream.includes('BEER'));
  assert.equal(pageStream.includes('080660956053'), false);
  assert.equal(pageStream.includes('619947000020'), false);
  assert.equal(pageStream.includes('085000016145'), false);

  // Verify multi-page pagination with 60 items
  const manyRows = buildRows(
    Array.from({ length: 60 }, (_, idx) => ({
      name: `Craft Beverage Item ${idx + 1} 12oz`,
      barcode: `0123456789${String(idx).padStart(2, '0')}`,
      category: idx % 2 === 0 ? 'BEER' : 'WINE',
      price: (9.99 + idx * 0.25).toFixed(2)
    }))
  );
  const multiDoc = generateCustomerPriceListPdf(manyRows, { groupByCategory: true });
  assert.ok(multiDoc.getNumberOfPages() >= 2);
});
