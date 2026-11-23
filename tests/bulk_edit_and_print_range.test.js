import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, bulkUpdateRows, revertRowEdit } from '../src/review.js';
import {
  AVERY_TEMPLATES,
  DEFAULT_AVERY_THEME,
  resolveAveryPrintPages,
  generateAveryPdf
} from '../src/avery_labels.js';
import {
  isPrivateOrReservedIp,
  validatePublicImageUrl,
  normalizeAllowedImageMime
} from '../src/url_safety.js';

function makeSampleRows() {
  return buildRows([
    { name: 'Corona Extra 12oz 6-Pack', barcode: '080660956053', category: 'Beer', price: '12.99' },
    { name: 'Heineken 12oz 6-Pack', barcode: '072890000163', category: 'Beer', price: '13.50' },
    { name: "Tito's Handmade Vodka 750ml", barcode: '619947000020', category: 'Spirits', price: '24.00' },
    { name: "Jack Daniel's 750ml", barcode: '082184090466', category: 'Spirits', price: '29.99' }
  ]);
}

test('bulkUpdateRows assigns a single category to selected rows and preserves revert snapshots', () => {
  const rows = makeSampleRows();
  const res = bulkUpdateRows(rows, new Set([rows[0].id, rows[1].id]), { category: 'BEER' });

  assert.equal(res.updatedCount, 2);
  assert.equal(rows[0].category, 'BEER');
  assert.equal(rows[1].category, 'BEER');
  assert.equal(rows[2].category, 'Spirits');
  assert.equal(rows[0].manuallyEdited, true);

  // Revert restores original Clover category
  revertRowEdit(rows, rows[0].id);
  assert.equal(rows[0].category, 'Beer');
});

test('bulkUpdateRows supports exact price, +/- dollar, +/- percent adjustments and clamps at 0', () => {
  const rows = makeSampleRows();

  // Set exact price
  bulkUpdateRows(rows, [rows[0].id, rows[1].id], {
    priceAdjustment: { mode: 'set', value: 14.99 }
  });
  assert.equal(rows[0].price, '14.99');
  assert.equal(rows[1].price, '14.99');
  assert.equal(rows[2].price, '24.00');

  // Increase by $2.00
  bulkUpdateRows(rows, [rows[2].id], {
    priceAdjustment: { mode: 'add_dollar', value: 2 }
  });
  assert.equal(rows[2].price, '26.00');

  // Decrease by $100 -> clamped to 0.00
  bulkUpdateRows(rows, [rows[2].id], {
    priceAdjustment: { mode: 'sub_dollar', value: 100 }
  });
  assert.equal(rows[2].price, '0.00');

  // Revert restores $24.00 then apply +10%
  revertRowEdit(rows, rows[2].id);
  assert.equal(rows[2].price, '24.00');

  bulkUpdateRows(rows, [rows[2].id], {
    priceAdjustment: { mode: 'add_percent', value: 10 }
  });
  assert.equal(rows[2].price, '26.40');

  // Apply -25% on $26.40 -> $19.80
  bulkUpdateRows(rows, [rows[2].id], {
    priceAdjustment: { mode: 'sub_percent', value: 25 }
  });
  assert.equal(rows[2].price, '19.80');
});

test('resolveAveryPrintPages resolves all, current, numeric range, and custom range text', () => {
  assert.deepEqual(resolveAveryPrintPages(4, { mode: 'all' }), {
    pages: [1, 2, 3, 4],
    valid: true,
    error: ''
  });

  assert.deepEqual(resolveAveryPrintPages(4, { mode: 'current', currentPage: 3 }), {
    pages: [3],
    valid: true,
    error: ''
  });

  // Clamps out-of-range currentPage safely
  assert.deepEqual(resolveAveryPrintPages(4, { mode: 'current', currentPage: 99 }), {
    pages: [4],
    valid: true,
    error: ''
  });

  assert.deepEqual(resolveAveryPrintPages(5, { mode: 'range', rangeStart: 2, rangeEnd: 4 }), {
    pages: [2, 3, 4],
    valid: true,
    error: ''
  });

  assert.deepEqual(resolveAveryPrintPages(6, { mode: 'range', rangeText: '4, 1-2, 6' }), {
    pages: [1, 2, 4, 6],
    valid: true,
    error: ''
  });

  // Rejects inverted or out-of-bounds ranges
  const inverted = resolveAveryPrintPages(5, { mode: 'range', rangeStart: 4, rangeEnd: 2 });
  assert.equal(inverted.valid, false);

  const outOfBounds = resolveAveryPrintPages(3, { mode: 'range', rangeText: '1-5' });
  assert.equal(outOfBounds.valid, false);

  const empty = resolveAveryPrintPages(0, { mode: 'all' });
  assert.equal(empty.valid, false);
});

test('generateAveryPdf respects selectedPages and expanded logo customization theme options', () => {
  const template = AVERY_TEMPLATES.find((t) => t.id === '5163'); // 10 labels per sheet
  const items = Array.from({ length: 25 }, (_, i) => ({
    id: `item_${i + 1}`,
    name: `Corona Extra 12oz Pack ${i + 1}`,
    price: '12.99',
    barcode: `0806609560${String(i).padStart(2, '0')}`,
    category: 'BEER',
    brand: 'Corona',
    size: '12oz'
  }));

  // 25 items on 10-per-sheet template = 3 sheets total
  const fullDoc = generateAveryPdf(items, template);
  assert.equal(fullDoc.getNumberOfPages(), 3);

  // Selected current sheet only (sheet 2) -> 1 page in PDF
  const singlePageDoc = generateAveryPdf(items, template, {
    selectedPages: [2],
    theme: {
      ...DEFAULT_AVERY_THEME,
      logoPlacement: 'watermark',
      logoSizePct: 125,
      logoOpacity: 0.25,
      logoShape: 'rounded',
      logoBgStyle: 'white-badge'
    }
  });
  assert.equal(singlePageDoc.getNumberOfPages(), 1);

  // Selected range (sheets 1 and 3) -> 2 pages in PDF
  const rangeDoc = generateAveryPdf(items, template, {
    selectedPages: [1, 3]
  });
  assert.equal(rangeDoc.getNumberOfPages(), 2);
});

test('SSRF URL and IP safety validators block private/internal targets and non-raster MIMEs', () => {
  assert.equal(validatePublicImageUrl('https://upload.wikimedia.org/wikipedia/commons/test.png').ok, true);

  // Block non-HTTPS, credentials, custom ports, localhost, private/metadata IPs
  assert.equal(validatePublicImageUrl('http://upload.wikimedia.org/logo.png').ok, false);
  assert.equal(validatePublicImageUrl('file:///etc/passwd').ok, false);
  assert.equal(validatePublicImageUrl('https://user:pass@example.com/logo.png').ok, false);
  assert.equal(validatePublicImageUrl('https://example.com:8443/logo.png').ok, false);
  assert.equal(validatePublicImageUrl('https://localhost/logo.png').ok, false);
  assert.equal(validatePublicImageUrl('https://metadata.google.internal/computeMetadata/v1/').ok, false);
  assert.equal(validatePublicImageUrl('https://169.254.169.254/latest/meta-data/').ok, false);
  assert.equal(validatePublicImageUrl('https://127.0.0.1/logo.png').ok, false);
  assert.equal(validatePublicImageUrl('https://10.0.0.1/logo.png').ok, false);
  assert.equal(validatePublicImageUrl('https://192.168.1.50/logo.png').ok, false);

  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('10.20.30.40'), true);
  assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
  assert.equal(isPrivateOrReservedIp('192.168.0.1'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('fc00::1'), true);
  assert.equal(isPrivateOrReservedIp('fe80::1'), true);
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);

  // MIME checks
  assert.equal(normalizeAllowedImageMime('image/png; charset=utf-8'), 'image/png');
  assert.equal(normalizeAllowedImageMime('image/jpg'), 'image/jpeg');
  assert.equal(normalizeAllowedImageMime('image/webp'), 'image/webp');
  assert.equal(normalizeAllowedImageMime('image/svg+xml'), null);
  assert.equal(normalizeAllowedImageMime('text/html'), null);
});
