'use strict';
/* QAVENO — currency dataset tests (Part 10 / Part 20 scenarios 21-25).
   Asserts every part-10 currency (code, symbol, AR name, EN name) exists in
   src/renderer/shared/currencies.js and that the dataset is well-formed.
   USD/EUR are included so the owner can switch display currency to them.
   ILS (Israeli Shekel) must NOT be selectable: the dataset, the admin
   settings UI, and the rest of the source must not hard-code it. */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'currencies.js');

const globalWindow = {};
global.window = globalWindow;

const code = fs.readFileSync(file, 'utf8');
eval(code);

const CURRENCIES = globalWindow.CURRENCIES;
const currencyByCode = globalWindow.currencyByCode;

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  PASS', label); }
  else { failed++; console.error('  FAIL', label); }
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|html)$/.test(name)) out.push(full);
  }
  return out;
}

function assertEntry(spec) {
  const c = CURRENCIES.find(x => x.code === spec.code);
  ok(!!c, `${spec.code} present`);
  if (!c) return;
  ok(c.symbol === spec.symbol, `${spec.code} symbol '${spec.symbol}'`);
  ok(c.nameAr === spec.nameAr, `${spec.code} Arabic name '${spec.nameAr}'`);
  ok(c.nameEn === spec.nameEn, `${spec.code} English name '${spec.nameEn}'`);
  ok(typeof c.country === 'string' && c.country.length > 0, `${spec.code} country label present`);
}

/* Exact spec from PART 10 */
const required = [
  { code: 'EGP', symbol: 'ج.م', nameAr: 'جنيه مصري', nameEn: 'Egyptian Pound' },
  { code: 'SAR', symbol: 'ر.س', nameAr: 'ريال سعودي', nameEn: 'Saudi Riyal' },
  { code: 'AED', symbol: 'د.إ', nameAr: 'درهم إماراتي', nameEn: 'UAE Dirham' },
  { code: 'KWD', symbol: 'د.ك', nameAr: 'دينار كويتي', nameEn: 'Kuwaiti Dinar' },
  { code: 'QAR', symbol: 'ر.ق', nameAr: 'ريال قطري', nameEn: 'Qatari Riyal' },
  { code: 'BHD', symbol: 'د.ب', nameAr: 'دينار بحريني', nameEn: 'Bahraini Dinar' },
  { code: 'OMR', symbol: 'ر.ع', nameAr: 'ريال عماني', nameEn: 'Omani Rial' },
  { code: 'JOD', symbol: 'د.أ', nameAr: 'دينار أردني', nameEn: 'Jordanian Dinar' },
  { code: 'IQD', symbol: 'د.ع', nameAr: 'دينار عراقي', nameEn: 'Iraqi Dinar' },
  { code: 'SDG', symbol: 'ج.س', nameAr: 'جنيه سوداني', nameEn: 'Sudanese Pound' },
  { code: 'YER', symbol: 'ر.ي', nameAr: 'ريال يمني', nameEn: 'Yemeni Rial' },
  { code: 'SYP', symbol: 'ل.س', nameAr: 'ليرة سورية', nameEn: 'Syrian Pound' },
  { code: 'LBP', symbol: 'ل.ل', nameAr: 'ليرة لبنانية', nameEn: 'Lebanese Pound' },
  { code: 'DZD', symbol: 'دج', nameAr: 'دينار جزائري', nameEn: 'Algerian Dinar' },
  { code: 'MAD', symbol: 'د.م', nameAr: 'درهم مغربي', nameEn: 'Moroccan Dirham' },
  { code: 'TND', symbol: 'د.ت', nameAr: 'دينار تونسي', nameEn: 'Tunisian Dinar' },
  { code: 'LYD', symbol: 'د.ل', nameAr: 'دينار ليبي', nameEn: 'Libyan Dinar' },
  { code: 'MRU', symbol: 'أ.م', nameAr: 'أوقية موريتانية', nameEn: 'Mauritanian Ouguiya' },
  { code: 'SOS', symbol: 'ش.ص', nameAr: 'شلن صومالي', nameEn: 'Somali Shilling' },
  { code: 'DJF', symbol: 'ف.ج', nameAr: 'فرنك جيبوتي', nameEn: 'Djiboutian Franc' },
  { code: 'KMF', symbol: 'ف.ق', nameAr: 'فرنك قمري', nameEn: 'Comorian Franc' },
  { code: 'USD', symbol: '$', nameAr: 'دولار أمريكي', nameEn: 'US Dollar' },
  { code: 'EUR', symbol: '€', nameAr: 'يورو', nameEn: 'Euro' }
];

console.log('Currency dataset:');
for (const spec of required) assertEntry(spec);

ok(Array.isArray(CURRENCIES) && CURRENCIES.length >= required.length, 'dataset contains all ' + required.length + ' required currencies');
ok(CURRENCIES.every(c => /^[A-Z]{3}$/.test(c.code)), 'all codes are valid ISO 4217 (3 uppercase letters)');
ok(CURRENCIES.every(c => typeof c.symbol === 'string'), 'all symbols are strings');
ok(CURRENCIES.every(c => typeof c.nameAr === 'string' && c.nameAr.length > 0), 'all entries have Arabic names');
ok(CURRENCIES.every(c => typeof c.nameEn === 'string' && c.nameEn.length > 0), 'all entries have English names');
ok(CURRENCIES.every(c => typeof c.country === 'string' && c.country.length > 0), 'all entries have country');

ok(!!currencyByCode('EGP') && currencyByCode('egp').code === 'EGP', 'currencyByCode is case-insensitive');
ok(currencyByCode('XXX') === null, 'currencyByCode returns null for unknown codes');

console.log('\nILS / ₪ removal:');
ok(!CURRENCIES.some(c => c.code === 'ILS'), 'ILS code not selectable in dataset');
ok(!CURRENCIES.some(c => c.symbol === '₪'), '₪ symbol not used in dataset');
ok(currencyByCode('ILS') === null, 'currencyByCode("ILS") returns null');

const srcDir = path.join(__dirname, '..', 'src');
const srcFiles = walk(srcDir, []);
ok(srcFiles.length > 0, `scanned ${srcFiles.length} renderer/main source files`);
let illegal = null;
for (const f of srcFiles) {
  const content = fs.readFileSync(f, 'utf8');
  if (/ILS|\u20AA|\u0634\u064A\u0643\u0644/.test(content)) { illegal = f; break; }
}
ok(illegal === null, 'no ILS/₪/شيكل hard-coded anywhere under src/');

console.log('\nSettings flow (currency selectable, persisted, legacy-safe):');
const os = require('node:os');
const db = require('../src/main/db');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-curr-test-'));
db.init(path.join(tmpDir, 'test.db'));

let s = db.getSettings();
ok(s.currency === 'ر.س' && s.currency_code === 'SAR', 'default settings seeded with SAR');

/* Emulate the admin settings submit: it writes symbol + ISO code. */
db.setSetting('currency', 'ج.م');
db.setSetting('currency_code', 'EGP');
s = db.getSettings();
ok(s.currency === 'ج.م' && s.currency_code === 'EGP', 'currency change persisted in DB (symbol + code)');
ok(CURRENCIES.some(c => c.code === s.currency_code && c.symbol === s.currency), 'stored currency maps to a selectable dataset entry');

/* Legacy ILS rows must not be destroyed — only no longer offered as new option. */
db.setSetting('currency_code', 'ILS');
s = db.getSettings();
ok(s.currency_code === 'ILS', 'legacy ILS value preserved (historical records untouched)');
ok(!CURRENCIES.some(c => c.code === 'ILS'), 'ILS not offered as an option despite legacy value');
/* Mirror admin currentCurrencyCode(): unknown stored code is bypassed and
   falls back to a valid dataset entry (by symbol, then SAR) — never ILS. */
const fallback = () => {
  if (s.currency_code && CURRENCIES.some(c => c.code === s.currency_code)) return s.currency_code;
  const bySymbol = CURRENCIES.find(c => c.symbol === s.currency);
  return bySymbol ? bySymbol.code : 'SAR';
};
ok(fallback() === 'EGP' && CURRENCIES.some(c => c.code === fallback() && c.code !== 'ILS'),
  'legacy ILS currency_code bypassed — falls back to a valid selectable currency');
db.setSetting('currency_code', 'KWD');
s = db.getSettings();
ok(s.currency_code === 'KWD', 'owner can re-select a valid currency after legacy ILS');

db.close();
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch { /* best-effort cleanup on Windows */ }

console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
process.exit(failed ? 1 : 0);