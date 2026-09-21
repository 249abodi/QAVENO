'use strict';

/* QAVENO — Currency dataset.
   Each entry: ISO 4217 code, display symbol, country (short AR/EN), and
   currency name in Arabic + English. Used by the admin settings to let the
   owner pick a real currency instead of typing an arbitrary symbol.
   Covers the Arab League states plus common international display
   currencies (USD, EUR). The Israeli Shekel is intentionally excluded from
   the selectable set. */

const CURRENCIES = [
  { code: 'SAR', symbol: 'ر.س', country: 'السعودية', countryEn: 'Saudi Arabia', nameAr: 'ريال سعودي', nameEn: 'Saudi Riyal' },
  { code: 'AED', symbol: 'د.إ', country: 'الإمارات', countryEn: 'UAE', nameAr: 'درهم إماراتي', nameEn: 'UAE Dirham' },
  { code: 'EGP', symbol: 'ج.م', country: 'مصر', countryEn: 'Egypt', nameAr: 'جنيه مصري', nameEn: 'Egyptian Pound' },
  { code: 'KWD', symbol: 'د.ك', country: 'الكويت', countryEn: 'Kuwait', nameAr: 'دينار كويتي', nameEn: 'Kuwaiti Dinar' },
  { code: 'QAR', symbol: 'ر.ق', country: 'قطر', countryEn: 'Qatar', nameAr: 'ريال قطري', nameEn: 'Qatari Riyal' },
  { code: 'BHD', symbol: 'د.ب', country: 'البحرين', countryEn: 'Bahrain', nameAr: 'دينار بحريني', nameEn: 'Bahraini Dinar' },
  { code: 'OMR', symbol: 'ر.ع', country: 'عُمان', countryEn: 'Oman', nameAr: 'ريال عماني', nameEn: 'Omani Rial' },
  { code: 'JOD', symbol: 'د.أ', country: 'الأردن', countryEn: 'Jordan', nameAr: 'دينار أردني', nameEn: 'Jordanian Dinar' },
  { code: 'IQD', symbol: 'د.ع', country: 'العراق', countryEn: 'Iraq', nameAr: 'دينار عراقي', nameEn: 'Iraqi Dinar' },
  { code: 'LBP', symbol: 'ل.ل', country: 'لبنان', countryEn: 'Lebanon', nameAr: 'ليرة لبنانية', nameEn: 'Lebanese Pound' },
  { code: 'SYP', symbol: 'ل.س', country: 'سوريا', countryEn: 'Syria', nameAr: 'ليرة سورية', nameEn: 'Syrian Pound' },
  { code: 'YER', symbol: 'ر.ي', country: 'اليمن', countryEn: 'Yemen', nameAr: 'ريال يمني', nameEn: 'Yemeni Rial' },
  { code: 'LYD', symbol: 'د.ل', country: 'ليبيا', countryEn: 'Libya', nameAr: 'دينار ليبي', nameEn: 'Libyan Dinar' },
  { code: 'TND', symbol: 'د.ت', country: 'تونس', countryEn: 'Tunisia', nameAr: 'دينار تونسي', nameEn: 'Tunisian Dinar' },
  { code: 'DZD', symbol: 'دج', country: 'الجزائر', countryEn: 'Algeria', nameAr: 'دينار جزائري', nameEn: 'Algerian Dinar' },
  { code: 'MAD', symbol: 'د.م', country: 'المغرب', countryEn: 'Morocco', nameAr: 'درهم مغربي', nameEn: 'Moroccan Dirham' },
  { code: 'MRU', symbol: 'أ.م', country: 'موريتانيا', countryEn: 'Mauritania', nameAr: 'أوقية موريتانية', nameEn: 'Mauritanian Ouguiya' },
  { code: 'SDG', symbol: 'ج.س', country: 'السودان', countryEn: 'Sudan', nameAr: 'جنيه سوداني', nameEn: 'Sudanese Pound' },
  { code: 'SOS', symbol: 'ش.ص', country: 'الصومال', countryEn: 'Somalia', nameAr: 'شلن صومالي', nameEn: 'Somali Shilling' },
  { code: 'DJF', symbol: 'ف.ج', country: 'جيبوتي', countryEn: 'Djibouti', nameAr: 'فرنك جيبوتي', nameEn: 'Djiboutian Franc' },
  { code: 'KMF', symbol: 'ف.ق', country: 'جزر القمر', countryEn: 'Comoros', nameAr: 'فرنك قمري', nameEn: 'Comorian Franc' },
  { code: 'USD', symbol: '$', country: 'الولايات المتحدة', countryEn: 'United States', nameAr: 'دولار أمريكي', nameEn: 'US Dollar' },
  { code: 'EUR', symbol: '€', country: 'أوروبا', countryEn: 'Europe', nameAr: 'يورو', nameEn: 'Euro' }
];

function currencyByCode(code) {
  return CURRENCIES.find(c => c.code === (code || '').toUpperCase()) || null;
}

window.CURRENCIES = CURRENCIES;
window.currencyByCode = currencyByCode;