'use strict';
/* QAVENO — currency dataset tests (Part 10 / Part 20 scenarios 21-25).
   Asserts every part-10 currency (code, symbol, AR name, EN name) exists in
   src/renderer/shared/currencies.js and that the dataset is well-formed. */

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
  { code: 'ILS', symbol: '₪', nameAr: 'شيكل إسرائيلي جديد', nameEn: 'New Israeli Shekel' },
  { code: 'DZD', symbol: 'دج', nameAr: 'دينار جزائري', nameEn: 'Algerian Dinar' },
  { code: 'MAD', symbol: 'د.م', nameAr: 'درهم مغربي', nameEn: 'Moroccan Dirham' },
  { code: 'TND', symbol: 'د.ت', nameAr: 'دينار تونسي', nameEn: 'Tunisian Dinar' },
  { code: 'LYD', symbol: 'د.ل', nameAr: 'دينار ليبي', nameEn: 'Libyan Dinar' },
  { code: 'MRU', symbol: 'أ.م', nameAr: 'أوقية موريتانية', nameEn: 'Mauritanian Ouguiya' },
  { code: 'SOS', symbol: 'ش.ص', nameAr: 'شلن صومالي', nameEn: 'Somali Shilling' },
  { code: 'DJF', symbol: 'ف.ج', nameAr: 'فرنك جيبوتي', nameEn: 'Djiboutian Franc' },
  { code: 'KMF', symbol: 'ف.ق', nameAr: 'فرنك قمري', nameEn: 'Comorian Franc' }
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

console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
process.exit(failed ? 1 : 0);