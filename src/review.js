import { analyzeBarcode } from './barcode.js';
import { normalizeName, applyApprovedAliases } from './normalization.js';
import { evaluateCategory } from './categories.js';
import { chooseReference, detectDuplicates } from './matching.js';
export const DECISION_FIELDS = ['name', 'barcode', 'category'];

export function buildRows(records, { index = new Map(), canonical = [], aliases = [] } = {}) {
  const rows = records.map((rec, i) => {
    const barcode = analyzeBarcode(rec.barcode);
    const cats = String(rec.category ?? '');
    const current = String(rec.name ?? '').trim();
    const row = {
      id: `r${i + 1}`,
      original_name: rec.name ?? '',
      current_name: current,
      barcode,
      category: cats,
      existingCategories: cats.split(',').map((s) => s.trim()).filter(Boolean),
      price: rec.price ?? '',
      cost: rec.cost ?? '',
      brand: rec.brand ?? '',
      unit: rec.unit ?? '',
      supplier: rec.supplier ?? '',
      supplierItemId: rec.supplierItemId ?? '',
      description: rec.description ?? '',
      record: rec,
      decisions: { name: 'pending', barcode: 'pending', category: 'pending' }
    };
    row.reference = chooseReference(row, index);
    const norm = applyApprovedAliases(normalizeName(current), aliases);
    row.proposed_name = row.reference.status === 'matched' && row.reference.proposedName ? row.reference.proposedName : (norm.value !== current ? norm.value : '');
    row.name_source = row.reference.status === 'matched' ? row.reference.provenance : (row.proposed_name ? 'formatting rules' : '');
    const cat = evaluateCategory(current, cats, canonical);
    row.proposed_category = cat.suggestion || '';
    row.category_conflicts = cat.conflicts;
    return row;
  });
  const dups = detectDuplicates(rows);
  for (const r of rows) r.duplicate = !!(r.barcode.canonicalKey && dups.get(r.barcode.canonicalKey) > 1);
  return rows;
}
export function setDecision(rows, id, field, value) {
  if (!DECISION_FIELDS.includes(field) || !['pending', 'accept', 'reject'].includes(value)) throw new Error('Invalid decision');
  const row = rows.find((r) => r.id === id); if (!row) throw new Error('Unknown row');
  row.decisions[field] = value; return row;
}
export function applyOffSuggestions(rows) {
  for (const r of rows) {
    if (r.off_suggestion && !r.proposed_name && r.off_agrees) { r.proposed_name = r.off_suggestion; r.name_source = 'open_food_facts (crowd-sourced, unverified)'; }
  }
}
export function issues(r) {
  const f = [];
  if (r.barcode.review) f.push(`barcode: ${r.barcode.reason}`);
  if (r.reference.status === 'contradiction' || r.reference.status === 'conflicting-references') f.push(`reference ${r.reference.status}: ${r.reference.contradictions.join('|')}`);
  if (r.category_conflicts.length) f.push(`category conflict: ${r.category_conflicts.join('|')}`);
  if (r.duplicate) f.push('duplicate barcode');
  if (r.off?.status && r.off.status !== 'found') f.push(`OFF ${r.off.status}`);
  if (r.off_suggestion && !r.off_agrees) f.push(`OFF name differs: ${r.off_suggestion}`);
  return f;
}
export function finalValues(r) {
  return {
    name: r.decisions.name === 'accept' && r.proposed_name ? r.proposed_name : r.current_name,
    category: r.decisions.category === 'accept' && r.proposed_category ? r.proposed_category : r.category
  };
}
// Strict: every proposal decided, barcode explicitly accepted, no unresolved contradictions.
export function isApproved(r) {
  if (r.decisions.barcode !== 'accept') return false;
  if (r.proposed_name && r.decisions.name === 'pending') return false;
  if (r.proposed_category && r.decisions.category === 'pending') return false;
  if (r.reference.status === 'conflicting-references') return false;
  if (r.reference.status === 'contradiction' && r.decisions.name === 'pending') return false;
  return true;
}
export const approvedRows = (rows) => rows.filter(isApproved);
export function acceptCleanBarcodes(rows) {
  let n = 0;
  for (const r of rows) if (r.decisions.barcode === 'pending' && r.barcode.structurallyValid && !r.barcode.review && !r.duplicate && r.reference.status !== 'contradiction' && r.reference.status !== 'conflicting-references') { r.decisions.barcode = 'accept'; n++; }
  return n;
}
export function summarize(rows) {
  return { total: rows.length, approved: approvedRows(rows).length, needsReview: rows.filter((r) => issues(r).length).length, contradictions: rows.filter((r) => r.reference.status === 'contradiction').length, duplicates: rows.filter((r) => r.duplicate).length, invalidBarcodes: rows.filter((r) => ['invalid', 'missing'].includes(r.barcode.status)).length };
}
export const exportHeader = ['id', 'original_name', 'final_name', 'proposed_name', 'name_source', 'name_decision', 'original_barcode', 'canonical_lookup_key', 'barcode_type', 'barcode_status', 'barcode_reason', 'barcode_decision', 'existing_category', 'proposed_category', 'final_category', 'category_decision', 'reference_status', 'issues', 'price', 'cost'];
export function exportRows(rows) {
  return rows.map((r) => { const f = finalValues(r); return [r.id, r.original_name, f.name, r.proposed_name, r.name_source, r.decisions.name, r.barcode.original, r.barcode.canonicalKey ?? '', r.barcode.type, r.barcode.status, r.barcode.reason, r.decisions.barcode, r.category, r.proposed_category, f.category, r.decisions.category, r.reference.status, issues(r).join('; '), r.price, r.cost]; });
}
export function saveSession(rows) { return JSON.stringify({ version: 1, decisions: Object.fromEntries(rows.map((r) => [r.id, r.decisions])) }); }
export function loadSession(rows, json) {
  const s = JSON.parse(json); if (s.version !== 1) throw new Error('Unsupported session');
  for (const r of rows) if (s.decisions[r.id]) Object.assign(r.decisions, s.decisions[r.id]);
}

/**
 * Evaluates row edit certainty. Flagged if the edit logic is uncertain,
 * ambiguous, has check digit anomalies, reference contradictions, or duplicate barcodes.
 */
export function computeRowCertainty(r) {
  const reasons = [];
  let isUncertain = false;

  if (r.barcode?.review || ['invalid', 'missing'].includes(r.barcode?.status)) {
    isUncertain = true;
    reasons.push(r.barcode?.reason || 'Barcode issue requires review');
  }

  if (r.duplicate) {
    isUncertain = true;
    reasons.push('Duplicate barcode across inventory');
  }

  if (r.reference?.status === 'contradiction' || r.reference?.status === 'conflicting-references') {
    isUncertain = true;
    reasons.push(`Reference contradiction: ${r.reference.contradictions?.join(', ') || ''}`);
  }

  if (r.category_conflicts && r.category_conflicts.length > 0) {
    isUncertain = true;
    reasons.push(`Category conflict: ${r.category_conflicts.join(', ')}`);
  }

  if (!r.price || r.price === '0' || r.price === '0.00') {
    reasons.push('Price is 0 or missing');
  }

  const iss = issues(r);
  if (iss.length > 0) {
    for (const item of iss) {
      if (!reasons.includes(item)) reasons.push(item);
    }
    isUncertain = true;
  }

  return {
    certainty: isUncertain ? 'review' : 'high',
    flagged: isUncertain,
    reasons: reasons.length ? reasons : ['Verified formatting and valid barcode identity']
  };
}

/**
 * Updates a specific field on a row and tracks modifications.
 */
export function updateRowValue(rows, id, field, value) {
  const row = rows.find((r) => r.id === id);
  if (!row) return null;

  if (!row._originalSnapshot) {
    row._originalSnapshot = {
      current_name: row.current_name,
      category: row.category,
      barcodeOriginal: row.barcode?.original,
      price: row.price
    };
  }

  if (field === 'name' || field === 'current_name') {
    row.current_name = String(value ?? '').trim();
    row.proposed_name = '';
    row.name_source = 'manual edit';
    row.decisions.name = 'accept';
  } else if (field === 'category') {
    row.category = String(value ?? '').trim();
    row.proposed_category = '';
    row.decisions.category = 'accept';
  } else if (field === 'barcode') {
    row.barcode = analyzeBarcode(String(value ?? '').trim());
    row.decisions.barcode = 'accept';
  } else if (field === 'price') {
    row.price = String(value ?? '').trim();
  }

  row.manuallyEdited = true;
  return row;
}

/**
 * Applies a bulk category assignment and/or price adjustment to multiple selected rows.
 * Preserves each row's _originalSnapshot via updateRowValue so Revert / Revert All
 * cleanly restores the original imported spreadsheet values.
 *
 * @param {Array<Object>} rows
 * @param {Set<string>|Array<string>} selectedIds
 * @param {Object} updates
 * @param {string} [updates.category]
 * @param {{ mode: 'set'|'add_dollar'|'sub_dollar'|'add_percent'|'sub_percent', value: number }} [updates.priceAdjustment]
 * @returns {{ updatedCount: number, updatedIds: string[] }}
 */
export function bulkUpdateRows(rows, selectedIds, updates = {}) {
  if (!Array.isArray(rows) || !selectedIds) {
    return { updatedCount: 0, updatedIds: [] };
  }
  const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (idSet.size === 0) {
    return { updatedCount: 0, updatedIds: [] };
  }

  const hasCategory = typeof updates.category === 'string' && updates.category.trim().length > 0;
  const trimmedCategory = hasCategory ? updates.category.trim() : '';

  const adj = updates.priceAdjustment;
  const validModes = new Set(['set', 'add_dollar', 'sub_dollar', 'add_percent', 'sub_percent']);
  const hasPriceAdj =
    adj &&
    typeof adj === 'object' &&
    validModes.has(adj.mode) &&
    Number.isFinite(Number(adj.value));
  const adjValue = hasPriceAdj ? Number(adj.value) : 0;

  if (!hasCategory && !hasPriceAdj) {
    return { updatedCount: 0, updatedIds: [] };
  }

  const updatedIds = [];
  for (const row of rows) {
    if (!idSet.has(row.id)) continue;

    if (hasCategory) {
      updateRowValue(rows, row.id, 'category', trimmedCategory);
    }

    if (hasPriceAdj) {
      const currentPrice = parseNumericPrice(row.price) ?? 0;
      let nextPrice = currentPrice;

      if (adj.mode === 'set') {
        nextPrice = adjValue;
      } else if (adj.mode === 'add_dollar') {
        nextPrice = currentPrice + adjValue;
      } else if (adj.mode === 'sub_dollar') {
        nextPrice = currentPrice - adjValue;
      } else if (adj.mode === 'add_percent') {
        nextPrice = currentPrice * (1 + adjValue / 100);
      } else if (adj.mode === 'sub_percent') {
        nextPrice = currentPrice * (1 - adjValue / 100);
      }

      if (!Number.isFinite(nextPrice) || nextPrice < 0) {
        nextPrice = 0;
      }

      const formatted = (Math.round(nextPrice * 100) / 100).toFixed(2);
      updateRowValue(rows, row.id, 'price', formatted);
    }

    updatedIds.push(row.id);
  }

  return { updatedCount: updatedIds.length, updatedIds };
}

/**
 * Reverts a row's edits back to its initial Clover loaded values.
 */
export function revertRowEdit(rows, id) {
  const row = rows.find((r) => r.id === id);
  if (!row) return null;

  if (row._originalSnapshot) {
    row.current_name = row._originalSnapshot.current_name;
    row.category = row._originalSnapshot.category;
    if (row._originalSnapshot.barcodeOriginal !== undefined) {
      row.barcode = analyzeBarcode(row._originalSnapshot.barcodeOriginal);
    }
    if (row._originalSnapshot.price !== undefined) {
      row.price = row._originalSnapshot.price;
    }
  } else {
    row.current_name = row.original_name;
  }

  row.proposed_name = '';
  row.proposed_category = '';
  row.decisions.name = 'pending';
  row.decisions.category = 'pending';
  row.decisions.barcode = 'pending';
  row.manuallyEdited = false;
  return row;
}

/**
 * Reverts all edits across all rows back to original values.
 */
export function revertAllEdits(rows) {
  let count = 0;
  for (const r of rows) {
    revertRowEdit(rows, r.id);
    count++;
  }
  return count;
}

/**
 * 1-Click auto-approves all rows that have high certainty (no review flags).
 */
export function autoApproveHighCertainty(rows) {
  let approvedCount = 0;
  for (const r of rows) {
    const { certainty } = computeRowCertainty(r);
    if (certainty === 'high') {
      if (r.decisions.barcode === 'pending') {
        r.decisions.barcode = 'accept';
      }
      if (r.proposed_name && r.decisions.name === 'pending') {
        r.decisions.name = 'accept';
      }
      if (r.proposed_category && r.decisions.category === 'pending') {
        r.decisions.category = 'accept';
      }
      approvedCount++;
    }
  }
  return approvedCount;
}

/**
 * Safely parses a retail price string or number into a finite numeric value.
 * Returns null if missing or non-numeric.
 */
export function parseNumericPrice(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * Computes median of a sorted ascending numeric array.
 */
function computeMedian(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Analyzes rows grouped by assigned category and flags items whose price is
 * unusually high or unusually low compared to their category peers/average.
 * Strictly read-only: NEVER mutates row prices.
 *
 * @param {Array<Object>} rows
 * @param {Object} [options]
 * @returns {Map<string, Object>} Map of row.id -> anomaly metadata
 */
export function analyzeCategoryPriceAnomalies(rows, options = {}) {
  const {
    minCategorySize = 3,
    highMultiplier = 2.2,
    extremeHighMultiplier = 3.0,
    minHighDiff = 5.0,
    lowMultiplier = 0.4,
    extremeLowMultiplier = 0.25,
    minLowDiff = 3.0
  } = options;

  const anomalies = new Map();
  if (!Array.isArray(rows) || rows.length === 0) return anomalies;

  // Group positive-priced rows by normalized assigned category
  const byCategory = new Map();
  for (const r of rows) {
    const rawCat = String(
      (r.decisions?.category === 'accept' && r.proposed_category) ? r.proposed_category : (r.category || '')
    ).trim();
    if (!rawCat) continue;
    const key = rawCat.toLowerCase();
    const price = parseNumericPrice(r.price);
    if (price === null || price <= 0) continue;

    if (!byCategory.has(key)) {
      byCategory.set(key, { label: rawCat, entries: [] });
    }
    byCategory.get(key).entries.push({ row: r, price });
  }

  for (const group of byCategory.values()) {
    const { label, entries } = group;
    if (entries.length < minCategorySize) continue;

    const prices = entries.map((e) => e.price);
    const sum = prices.reduce((acc, p) => acc + p, 0);
    const categoryAverage = sum / prices.length;
    const sorted = [...prices].sort((a, b) => a - b);
    const baseline = computeMedian(sorted);
    if (baseline <= 0) continue;

    // Also compute robust category average excluding extreme outliers for clearer reference
    const variance = prices.reduce((acc, p) => acc + Math.pow(p - categoryAverage, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);

    for (const { row, price } of entries) {
      const ratioToBaseline = price / baseline;
      const diffFromBaseline = price - baseline;
      const percentDiffFromAvg = categoryAverage > 0
        ? Math.round(((price - categoryAverage) / categoryAverage) * 100)
        : 0;
      const percentDiffFromBaseline = Math.round(((price - baseline) / baseline) * 100);

      const isHigh =
        (ratioToBaseline >= highMultiplier && diffFromBaseline >= minHighDiff) ||
        ratioToBaseline >= extremeHighMultiplier ||
        (entries.length >= 4 && stdDev > 0 && price > categoryAverage + 2 * stdDev && ratioToBaseline >= 1.8);

      const isLow =
        (ratioToBaseline <= lowMultiplier && -diffFromBaseline >= minLowDiff) ||
        ratioToBaseline <= extremeLowMultiplier ||
        (entries.length >= 4 && stdDev > 0 && price < categoryAverage - 2 * stdDev && ratioToBaseline <= 0.5);

      if (isHigh || isLow) {
        const status = isHigh ? 'high' : 'low';
        const directionText = isHigh ? 'above' : 'below';
        const displayPct = Math.abs(percentDiffFromBaseline);
        anomalies.set(row.id, {
          status,
          price,
          category: label,
          categoryAverage: Number(categoryAverage.toFixed(2)),
          categoryMedian: Number(baseline.toFixed(2)),
          categoryCount: entries.length,
          ratio: Number(ratioToBaseline.toFixed(2)),
          percentDiff: percentDiffFromAvg,
          percentDiffFromBaseline,
          message: `Price $${price.toFixed(2)} is unusually ${status} (${displayPct}% ${directionText} typical ${label} price; cat. avg $${categoryAverage.toFixed(2)})`
        });
      }
    }
  }

  return anomalies;
}

/**
 * Summarizes detected price anomalies for banner/filter badges.
 */
export function getPriceAnomalySummary(anomalyMap) {
  let highCount = 0;
  let lowCount = 0;
  if (anomalyMap && typeof anomalyMap.values === 'function') {
    for (const item of anomalyMap.values()) {
      if (item.status === 'high') highCount++;
      else if (item.status === 'low') lowCount++;
    }
  }
  return {
    total: highCount + lowCount,
    highCount,
    lowCount
  };
}

