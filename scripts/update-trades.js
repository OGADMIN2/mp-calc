'use strict';
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

// ── Spreadsheet IDs ─────────────────────────────────────────────────────────
const IDS = {
  phoenix: '1Sh8OmggqTAqsOnz67iICNqBB2t_9LpVs4wmnthK2tF4',
  dd:      '1d7NiRDbQ6nQ6KUashZ26U7fxQvH60Enok9OaCU8sKaQ',
  mp:      '1H3nAFD5XNrrBvI4YhaFnSFyCRd7CtzDDDhEIMGRwTfg'
};

const HTML_DIR = path.join(__dirname, '..');
const MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Shared helpers ──────────────────────────────────────────────────────────
function parseMMDDYYYY(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m.map(Number);
  return { year: y, label: MONTHS[mo - 1] + ' ' + d };
}

function num(val, fallback = 0) {
  const n = parseFloat(String(val || '').replace(/[$,%\s]/g, ''));
  return isNaN(n) ? fallback : n;
}

// Replace a const ARRAY = [...]; block inside an HTML string.
function replaceArray(html, varName, entriesStr) {
  const re = new RegExp(`(const ${varName} = \\[)[\\s\\S]*?\\];`);
  if (!re.test(html)) throw new Error(`"${varName}" array not found in HTML`);
  return html.replace(re, `$1\n${entriesStr}\n];`);
}

// ── PHOENIX parser ──────────────────────────────────────────────────────────
//
// Column indices (0-based):
//   0  : Date          MM/DD/YYYY
//  13  : Debit to Open (lotto cost per share → margin = debit × 100)
//  14  : Gap at Open?  "Yes" → lotto trade
//  18  : Margin $      (for regular trades)
//  -4  : Total profit 70%  (= P/L in dollars, always 4th from the end)
//  -1  : ROI%          (last column — used only to validate row is complete)
function parsePhoenix(rows) {
  const trades = [];
  for (const row of rows) {
    const d = parseMMDDYYYY(row[0]);
    if (!d) continue;

    const gapCol = (row[14] || '').trim().toLowerCase();
    if (gapCol !== 'yes' && gapCol !== 'no' && gapCol !== '') continue; // not a trade row

    const lotto  = gapCol === 'yes';
    const debit  = num(row[13]);
    const margin = lotto
      ? Math.round(debit * 100)
      : Math.round(num((row[18] || '').replace(/[^0-9.]/g, '')));

    const roiRaw = (row[row.length - 1] || '').trim();
    if (!roiRaw || roiRaw.includes('DIV') || roiRaw.includes('#')) continue;

    const pl = Math.round(num(row[row.length - 4]));
    if (!margin || pl === 0) continue;

    trades.push({ year: d.year, date: d.label, pl, lotto, margin });
  }
  return trades;
}

function phxEntry(t) {
  const lottoStr = t.lotto ? 'true ' : 'false';
  const plPad    = String(t.pl).padStart(5);
  const mgPad    = String(t.margin).padStart(6);
  return `  {year:${t.year},date:"${t.date.padEnd(6)}",pl:${plPad},  lotto:${lottoStr},margin:${mgPad}}`;
}

// ── DOUBLE DIP parser ───────────────────────────────────────────────────────
//
// Column indices (0-based) — adjust if your sheet layout differs:
//   0  : Open Date     MM/DD/YYYY
//   2  : Call or Put   "Call" / "Put"
//   7  : Rqd Mrgn/Spread  (margin in dollars)
//  14  : Actual P/L    (dollar amount, may have $ sign)
//  15  : % P/L         (roi as a percentage number, e.g. 6.45)
const DD_COL = { date: 0, type: 2, margin: 7, pl: 14, roi: 15 };

function parseDD(rows) {
  const trades = [];
  for (const row of rows) {
    const d = parseMMDDYYYY(row[DD_COL.date]);
    if (!d) continue;

    const type   = (row[DD_COL.type] || '').trim();
    const margin = Math.round(num(row[DD_COL.margin]));
    const pl     = num(row[DD_COL.pl]);
    const roi    = num(row[DD_COL.roi]);

    if (!margin || roi === 0) continue;

    const result = pl >= 0 ? 'Win' : 'Loss';
    trades.push({ year: d.year, date: d.label, type, result, roi: +roi.toFixed(2), margin });
  }
  return trades;
}

function ddEntry(t) {
  return `  {year:${t.year},date:"${t.date.padEnd(6)}", type:"${t.type}",result:"${t.result}",roi:${t.roi.toFixed(2)}, margin:${t.margin}}`;
}

// ── MARKET POWER parser ─────────────────────────────────────────────────────
// Scans the first 5 rows for a header to discover column positions dynamically,
// then falls back to defaults (0,1,2,3) if no header is found.
function parseMP(rows, year) {
  // Discover columns from header
  let colNum = 0, colDate = 1, colResult = 2, colRoi = 3;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i];
    let foundHeader = false;
    for (let j = 0; j < row.length; j++) {
      const h = (row[j] || '').toString().toLowerCase().trim();
      if (h === '#' || h === 'no.' || h === 'trade #' || h === 'trade#') { colNum = j; foundHeader = true; }
      else if (h.includes('date')) colDate = j;
      else if (h.includes('result') || h === 'win/loss' || h === 'outcome') colResult = j;
      else if (h.includes('roi') || h === '% return' || h === 'return %') colRoi = j;
    }
    if (foundHeader) break;
  }

  const trades = [];
  for (const row of rows) {
    const tradeNum = parseInt(row[colNum]);
    if (!tradeNum || tradeNum <= 0) continue;

    const dateStr = (row[colDate] || '').trim();
    if (!dateStr) continue;

    const result = (row[colResult] || '').trim();
    const roi    = num(row[colRoi]);
    if (!result || roi === 0) continue;

    trades.push({ year, date: dateStr, result, roi: +roi.toFixed(2) });
  }
  return trades;
}

function mpEntry(t) {
  return `  {year:${t.year},date:"${t.date.padEnd(6)}",result:"${t.result}",roi:${t.roi.toFixed(2)}}`;
}

// ── Google Sheets helper ────────────────────────────────────────────────────
async function getAllRows(sheets, spreadsheetId, rangeSpec) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const allRows = [];
  for (const sheet of meta.data.sheets) {
    const title = sheet.properties.title;
    const range = `'${title}'!${rangeSpec}`;
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      allRows.push({ title, rows: res.data.values || [] });
    } catch (e) {
      console.warn(`  ⚠  Could not read tab "${title}": ${e.message}`);
    }
  }
  return allRows;
}

// ── Sort helper ─────────────────────────────────────────────────────────────
function sortByDate(trades) {
  return trades.slice().sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    const da = new Date(`${a.date} ${a.year}`);
    const db = new Date(`${b.date} ${b.year}`);
    return da - db;
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!key) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set');

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(key),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── 1. Phoenix ─────────────────────────────────────────────────────────
  console.log('\n📋 Reading Phoenix spreadsheet…');
  const phxSheets = await getAllRows(sheets, IDS.phoenix, 'A:AZ');
  let phxTrades = [];
  for (const { title, rows } of phxSheets) {
    const parsed = parsePhoenix(rows);
    if (parsed.length) console.log(`   Tab "${title}": ${parsed.length} trades`);
    phxTrades = phxTrades.concat(parsed);
  }
  phxTrades = sortByDate(phxTrades).filter(t => t.year >= 2026);
  console.log(`   ✅ Phoenix total: ${phxTrades.length} trades (2026+)`);

  // ── 2. Double Dip ──────────────────────────────────────────────────────
  console.log('\n📋 Reading Double Dip spreadsheet…');
  const ddSheets = await getAllRows(sheets, IDS.dd, 'A:T');
  let ddTrades = [];
  for (const { title, rows } of ddSheets) {
    const parsed = parseDD(rows);
    if (parsed.length) console.log(`   Tab "${title}": ${parsed.length} trades`);
    ddTrades = ddTrades.concat(parsed);
  }
  ddTrades = sortByDate(ddTrades).filter(t => t.year >= 2026);
  console.log(`   ✅ Double Dip total: ${ddTrades.length} trades (2026+)`);

  // ── 3. Market Power ────────────────────────────────────────────────────
  console.log('\n📋 Reading Market Power spreadsheet…');
  const mpSheets = await getAllRows(sheets, IDS.mp, 'A:Z');
  let mpTrades = [];
  for (const { title, rows } of mpSheets) {
    const year = parseInt(title);
    if (!year || year < 2020 || year > 2099) {
      console.log(`   Skipping tab "${title}" (not a year tab)`);
      continue;
    }
    const parsed = parseMP(rows, year);
    if (parsed.length) console.log(`   Tab "${title}": ${parsed.length} trades`);
    mpTrades = mpTrades.concat(parsed);
  }
  mpTrades = sortByDate(mpTrades);
  console.log(`   ✅ Market Power total: ${mpTrades.length} trades`);

  // ── 4. Update HTML files ────────────────────────────────────────────────
  console.log('\n✏️  Updating HTML calculators…');

  // phoenix-calculator.html  →  TRADES array: {year, date, pl, lotto, margin}
  const phxFile  = path.join(HTML_DIR, 'phoenix-calculator.html');
  let phxHtml    = fs.readFileSync(phxFile, 'utf8');
  phxHtml        = replaceArray(phxHtml, 'TRADES', phxTrades.map(phxEntry).join(',\n'));
  fs.writeFileSync(phxFile, phxHtml);
  console.log(`   phoenix-calculator.html updated (${phxTrades.length} trades)`);

  // double-dip-calculator.html  →  TRADES array: {year, date, type, result, roi, margin}
  const ddFile   = path.join(HTML_DIR, 'double-dip-calculator.html');
  let ddHtml     = fs.readFileSync(ddFile, 'utf8');
  ddHtml         = replaceArray(ddHtml, 'TRADES', ddTrades.map(ddEntry).join(',\n'));
  fs.writeFileSync(ddFile, ddHtml);
  console.log(`   double-dip-calculator.html updated (${ddTrades.length} trades)`);

  // market-power-calculator.html  →  TRADES array: {year, date, result, roi}
  const mpFile   = path.join(HTML_DIR, 'market-power-calculator.html');
  let mpHtml     = fs.readFileSync(mpFile, 'utf8');
  mpHtml         = replaceArray(mpHtml, 'TRADES', mpTrades.map(mpEntry).join(',\n'));
  fs.writeFileSync(mpFile, mpHtml);
  console.log(`   market-power-calculator.html updated (${mpTrades.length} trades)`);

  // portfolio-calculator.html  →  PH, DD, MP arrays (each is a subset of fields)
  const pfFile   = path.join(HTML_DIR, 'portfolio-calculator.html');
  let pfHtml     = fs.readFileSync(pfFile, 'utf8');

  // Portfolio PH: {year, date, pl, margin}  (no lotto field)
  const pfPhxStr = phxTrades.map(t =>
    `  {year:${t.year},date:"${t.date.padEnd(6)}",pl:${String(t.pl).padStart(5)},  margin:${String(t.margin).padStart(6)}}`
  ).join(',\n');
  pfHtml = replaceArray(pfHtml, 'PH', pfPhxStr);

  // Portfolio DD: {year, date, roi, margin}
  const pfDdStr  = ddTrades.map(t =>
    `  {year:${t.year},date:"${t.date.padEnd(6)}",roi:${t.roi.toFixed(2)}, margin:${t.margin}}`
  ).join(',\n');
  pfHtml = replaceArray(pfHtml, 'DD', pfDdStr);

  // Portfolio MP: {year, date, roi}
  const pfMpStr  = mpTrades.map(t =>
    `  {year:${t.year},date:"${t.date.padEnd(6)}", roi:${t.roi.toFixed(2)}}`
  ).join(',\n');
  pfHtml = replaceArray(pfHtml, 'MP', pfMpStr);

  fs.writeFileSync(pfFile, pfHtml);
  console.log(`   portfolio-calculator.html updated`);

  console.log('\n🎉 All calculators updated successfully!\n');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message || err);
  process.exit(1);
});
