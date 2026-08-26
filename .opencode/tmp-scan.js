const fs = require('fs');
const s = fs.readFileSync('src/renderer/cashier/index.html', 'utf8');
s.split('\n').forEach((l, i) => {
  if (/topbar|store|chip|user|brand/i.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 130));
});
console.log('---- admin header ----');
const a = fs.readFileSync('src/renderer/admin/index.html', 'utf8').split('\n');
a.slice(0, 19).forEach((l, i) => console.log((i + 1) + ': ' + l));
