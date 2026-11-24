import { jsPDF } from 'jspdf';
import { formatTagPrice } from './avery_labels.js';

/**
 * Customer-Facing Price List PDF Generator
 * Produces a clean, simplified price sheet containing ONLY:
 *   - Item Name
 *   - Category
 *   - Price
 * Strictly excludes barcode, SKU, UPC, cost, supplier, and internal POS fields.
 */

/**
 * Resolves customer-safe rows containing only name, category, and price.
 *
 * @param {Array<Object>} rows
 * @param {Object} [options]
 * @param {string} [options.categoryFilter='all']
 * @returns {Array<{ name: string, category: string, price: string, formattedPrice: string }>}
 */
export function buildCustomerPriceListItems(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const categoryFilter = String(options.categoryFilter || 'all').trim();
  const filterLower = categoryFilter.toLowerCase();

  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const resolvedName = String(
      row.decisions?.name === 'accept' && row.proposed_name
        ? row.proposed_name
        : row.current_name || row.name || row.original_name || ''
    ).trim();
    if (!resolvedName) continue;

    const resolvedCategory = String(
      row.decisions?.category === 'accept' && row.proposed_category
        ? row.proposed_category
        : row.category || ''
    ).trim() || 'Uncategorized';

    if (filterLower !== 'all' && resolvedCategory.toLowerCase() !== filterLower) {
      continue;
    }

    const rawPrice = row.price ?? '';
    const formattedPrice = formatTagPrice(rawPrice);

    // Explicitly include ONLY customer-facing fields (no barcode, no SKU, no cost)
    items.push({
      name: resolvedName,
      category: resolvedCategory,
      price: String(rawPrice),
      formattedPrice
    });
  }

  items.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category, undefined, { sensitivity: 'base' });
    if (catCmp !== 0) return catCmp;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return items;
}

/**
 * Generates a customer-friendly US Letter PDF Price List containing ONLY
 * Item Name, Category, and Price (no barcodes or SKUs).
 *
 * @param {Array<Object>} rows
 * @param {Object} [options]
 * @param {string} [options.storeName='777 Liquor Store']
 * @param {string} [options.title='Customer Price List']
 * @param {boolean} [options.groupByCategory=true]
 * @param {string} [options.categoryFilter='all']
 * @returns {jsPDF}
 */
export function generateCustomerPriceListPdf(rows, options = {}) {
  const {
    storeName = '777 Liquor Store',
    title = 'Customer Price List',
    groupByCategory = true,
    categoryFilter = 'all'
  } = options;

  const items = buildCustomerPriceListItems(rows, { categoryFilter });

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'letter'
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // 612pt
  const pageHeight = doc.internal.pageSize.getHeight(); // 792pt
  const marginX = 42;
  const contentW = pageWidth - marginX * 2;
  const footerY = pageHeight - 28;
  const maxBodyY = pageHeight - 52;

  const colNameX = marginX + 8;
  const colNameW = 285;
  const colCategoryX = marginX + 305;
  const colCategoryW = 140;
  const colPriceRightX = pageWidth - marginX - 8;

  const dateLabel = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const drawPageHeader = (isFirstPage) => {
    let cursorY = 38;
    if (isFirstPage) {
      // Branded top banner
      doc.setFillColor(15, 23, 42);
      doc.roundedRect(marginX, cursorY, contentW, 58, 6, 6, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(17);
      doc.setTextColor(255, 255, 255);
      doc.text(String(storeName || '777 Liquor Store').slice(0, 60), marginX + 16, cursorY + 25);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(203, 213, 225);
      const filterText = categoryFilter && categoryFilter !== 'all' ? ` • ${categoryFilter}` : '';
      doc.text(`${title}${filterText}`, marginX + 16, cursorY + 44);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(148, 163, 184);
      doc.text(dateLabel, pageWidth - marginX - 16, cursorY + 25, { align: 'right' });
      doc.text(
        `${items.length} ${items.length === 1 ? 'Item' : 'Items'}`,
        pageWidth - marginX - 16,
        cursorY + 44,
        { align: 'right' }
      );

      cursorY += 74;
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text(`${storeName} — ${title}`, marginX, cursorY + 6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text(dateLabel, pageWidth - marginX, cursorY + 6, { align: 'right' });
      cursorY += 22;
    }

    // Table column header bar (Item Name | Category | Price)
    doc.setFillColor(241, 245, 249);
    doc.rect(marginX, cursorY, contentW, 22, 'F');
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.75);
    doc.line(marginX, cursorY + 22, pageWidth - marginX, cursorY + 22);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(30, 41, 59);
    doc.text('ITEM NAME', colNameX, cursorY + 14.5);
    doc.text('CATEGORY', colCategoryX, cursorY + 14.5);
    doc.text('PRICE', colPriceRightX, cursorY + 14.5, { align: 'right' });

    return cursorY + 26;
  };

  let y = drawPageHeader(true);

  if (items.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(11);
    doc.setTextColor(100, 116, 139);
    doc.text('No items available for this price list.', marginX + 8, y + 18);
  } else {
    let lastCategory = '';
    let rowStripe = 0;

    for (const item of items) {
      if (groupByCategory && item.category !== lastCategory) {
        if (y + 38 > maxBodyY) {
          doc.addPage('letter', 'portrait');
          y = drawPageHeader(false);
        }
        // Category section bar
        doc.setFillColor(226, 232, 240);
        doc.rect(marginX, y, contentW, 19, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(15, 23, 42);
        doc.text(item.category.toUpperCase().slice(0, 48), colNameX, y + 13);
        y += 21;
        lastCategory = item.category;
        rowStripe = 0;
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      const nameLines = doc.splitTextToSize(item.name, colNameW).slice(0, 2);
      const catLines = doc.splitTextToSize(item.category, colCategoryW).slice(0, 2);
      const lineCount = Math.max(nameLines.length, catLines.length, 1);
      const rowHeight = lineCount === 1 ? 20 : 30;

      if (y + rowHeight > maxBodyY) {
        doc.addPage('letter', 'portrait');
        y = drawPageHeader(false);
        rowStripe = 0;
      }

      if (rowStripe % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(marginX, y, contentW, rowHeight, 'F');
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(nameLines, colNameX, y + 13);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.8);
      doc.setTextColor(71, 85, 105);
      doc.text(catLines, colCategoryX, y + 13);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(15, 23, 42);
      doc.text(item.formattedPrice, colPriceRightX, y + 13, { align: 'right' });

      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.5);
      doc.line(marginX, y + rowHeight, pageWidth - marginX, y + rowHeight);

      y += rowHeight;
      rowStripe++;
    }
  }

  // Page numbers on all pages
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.5);
    doc.line(marginX, footerY - 12, pageWidth - marginX, footerY - 12);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`${storeName} — Prices subject to change`, marginX, footerY);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - marginX, footerY, { align: 'right' });
  }

  return doc;
}

/**
 * Downloads the simplified Customer Price List PDF.
 *
 * @param {Array<Object>} rows
 * @param {Object} [options]
 * @param {string} [filename]
 * @returns {string}
 */
export function saveCustomerPriceListPdf(rows, options = {}, filename) {
  const doc = generateCustomerPriceListPdf(rows, options);
  const dateStr = new Date().toISOString().slice(0, 10);
  const finalName = filename || `customer_price_list_${dateStr}.pdf`;
  doc.save(finalName);
  return finalName;
}

/**
 * Generates an application/pdf Blob and object URL for in-app preview.
 *
 * @param {Array<Object>} rows
 * @param {Object} [options]
 * @returns {{ blob: Blob, url: string }}
 */
export function getCustomerPriceListPdfBlobUrl(rows, options = {}) {
  const doc = generateCustomerPriceListPdf(rows, options);
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  return { blob, url };
}
