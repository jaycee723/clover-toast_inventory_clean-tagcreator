import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumericPrice,
  analyzeCategoryPriceAnomalies,
  getPriceAnomalySummary
} from '../src/review.js';

test('parseNumericPrice handles currency formatting, commas, and invalid values safely', () => {
  assert.equal(parseNumericPrice('$24.99'), 24.99);
  assert.equal(parseNumericPrice('1,299.50'), 1299.5);
  assert.equal(parseNumericPrice(18.5), 18.5);
  assert.equal(parseNumericPrice(''), null);
  assert.equal(parseNumericPrice('N/A'), null);
  assert.equal(parseNumericPrice(null), null);
});

test('analyzeCategoryPriceAnomalies flags unusually high price typos without falsely flagging normal peers', () => {
  const rows = [
    { id: 'r1', category: 'Spirits', price: '24.99' },
    { id: 'r2', category: 'Spirits', price: '27.99' },
    { id: 'r3', category: 'Spirits', price: '29.99' },
    { id: 'r4', category: 'Spirits', price: '26.49' },
    // Decimal-shift spreadsheet typo ($299.99 instead of $29.99)
    { id: 'r5', category: 'Spirits', price: '299.99' }
  ];

  const anomalies = analyzeCategoryPriceAnomalies(rows);
  assert.equal(anomalies.size, 1);
  assert.ok(anomalies.has('r5'));
  assert.equal(anomalies.get('r5').status, 'high');
  assert.equal(anomalies.get('r5').category, 'Spirits');
  assert.ok(anomalies.get('r5').categoryAverage > 0);
  // Original price must never be mutated
  assert.equal(rows[4].price, '299.99');
});

test('analyzeCategoryPriceAnomalies flags unusually low price typos compared to category average', () => {
  const rows = [
    { id: 'b1', category: 'Beer', price: '16.99' },
    { id: 'b2', category: 'Beer', price: '18.99' },
    { id: 'b3', category: 'Beer', price: '17.49' },
    // Decimal-shift typo ($1.79 instead of $17.99)
    { id: 'b4', category: 'Beer', price: '1.79' }
  ];

  const anomalies = analyzeCategoryPriceAnomalies(rows);
  assert.equal(anomalies.size, 1);
  assert.ok(anomalies.has('b4'));
  assert.equal(anomalies.get('b4').status, 'low');
  assert.match(anomalies.get('b4').message, /unusually low/i);
});

test('analyzeCategoryPriceAnomalies skips categories with fewer than 3 priced items and ignores zero/missing prices', () => {
  const rows = [
    { id: 'w1', category: 'Rare Wine', price: '20.00' },
    { id: 'w2', category: 'Rare Wine', price: '250.00' },
    { id: 'w3', category: 'Rare Wine', price: '0.00' }
  ];

  const anomalies = analyzeCategoryPriceAnomalies(rows);
  assert.equal(anomalies.size, 0);
});

test('analyzeCategoryPriceAnomalies groups categories case-insensitively and summarizes counts accurately', () => {
  const rows = [
    { id: 's1', category: 'Snacks', price: '$2.49' },
    { id: 's2', category: 'snacks', price: '$2.99' },
    { id: 's3', category: 'SNACKS', price: '$1.99' },
    { id: 's4', category: 'Snacks', price: '$24.99' },
    { id: 'l1', category: 'Liquor', price: '35.00' },
    { id: 'l2', category: 'Liquor', price: '38.00' },
    { id: 'l3', category: 'Liquor', price: '36.00' },
    { id: 'l4', category: 'Liquor', price: '3.50' }
  ];

  const anomalies = analyzeCategoryPriceAnomalies(rows);
  const summary = getPriceAnomalySummary(anomalies);
  assert.equal(summary.total, 2);
  assert.equal(summary.highCount, 1);
  assert.equal(summary.lowCount, 1);
  assert.equal(anomalies.get('s4').status, 'high');
  assert.equal(anomalies.get('l4').status, 'low');
});
