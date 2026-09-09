'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const html = readFileSync(join(__dirname, '..', 'website', 'index.html'), 'utf8');

let pass = 0;
let fail = 0;

function assert(label, ok) {
  if (ok) { pass++; }
  else { fail++; console.error('FAIL: ' + label); }
}

// ── URL safety ──
assert('no v1.0.6 references', !html.includes('v1.0.6'));
assert('no QAVENO-Setup-1.0.0.exe references', !html.includes('QAVENO-Setup-1.0.0.exe'));
assert('no v1.1.0 references', !html.includes('v1.1.0'));
assert('v1.1.1 download URL present', html.includes('releases/download/V.1.1.1/QAVENO-Setup-1.1.1.exe'));

// ── Structure ──
assert('has skip-link', html.includes('skip-link'));
assert('has <main id="main">', html.includes('<main id="main">'));
assert('has hero section', html.includes('class="hero"'));
assert('has features section', html.includes('id="features"'));
assert('has pricing section', html.includes('id="pricing"'));
assert('has download section', html.includes('id="download"'));
assert('has footer', html.includes('<footer'));
assert('has sticky header', html.includes('site-header'));
assert('has nav toggle', html.includes('nav-toggle'));

// ── Accessibility ──
assert('lang attribute present', html.includes('lang="en"'));
assert('dir attribute present', html.includes('dir="ltr"'));
assert('skip-link target #main', html.includes('href="#main"'));
assert('aria-expanded on toggle', html.includes('aria-expanded'));
assert('aria-label on toggle', html.includes('aria-label="Toggle navigation"'));
assert('prefers-reduced-motion guard', html.includes('prefers-reduced-motion'));
assert('focus-visible styles', html.includes(':focus-visible'));
assert('role=img on donut', html.includes('role="img"'));

// ── Content ──
assert('has WhatsApp contact link', html.includes('wa.me/60175816193'));
assert('has Arabic trial text', html.includes('تحميل QAVENO'));
assert('has copyright 2026', html.includes('© 2026'));
assert('has Inter font', html.includes('Inter'));
assert('no external images (no <img src)', !html.match(/<img\s+[^>]*src="/));
assert('no broken assets/logo.png ref', !html.includes('assets/logo.png'));

// ── Navigation links ──
assert('nav links to #features', html.includes('href="#features"'));
assert('nav links to #pricing', html.includes('href="#pricing"'));
assert('nav links to #download', html.includes('href="#download"'));

// ── Pricing tiers ──
assert('has Free Demo tier', html.includes('Free Demo'));
assert('has Basic tier', html.includes('>Basic<'));
assert('has Pro tier', html.includes('>Pro<'));
assert('has Enterprise tier', html.includes('>Enterprise<'));

// ── Brand identity (QAVENO) ──
assert('uses QAVENO marque brand colors', html.includes('#3F51E8') && html.includes('#111C4E'));
assert('theme-color is QAVENO navy', html.includes('content="#111c4e"'));
assert('svg favicon declared', html.includes('rel="icon" type="image/svg+xml" href="icon.svg"'));
assert('favicon.ico declared', html.includes('href="favicon.ico"'));
assert('apple-touch-icon declared', html.includes('apple-touch-icon'));
assert('og:image present', html.includes('og:image'));
assert('no legacy violet hues remain', !html.includes('#8b5cf6') && !html.includes('#4c1d95') && !html.includes('violet-500'));
assert('no legacy indigo mark #4f46e5 remains', !html.includes('#4f46e5'));
assert('footer has Resources column', html.includes('Resources'));

console.log('\nWebsite QA: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
