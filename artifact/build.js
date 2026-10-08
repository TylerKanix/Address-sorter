// Builds the single-file Claude artifact version of Address Sorter.
// Usage: node artifact/build.js [output.html]
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modules = [
  'assets/js/address.js',
  'assets/js/geo.js',
  'assets/js/optimizer.js',
  'assets/js/planner.js',
  'assets/js/sample.js',
  'artifact/app.js',
];

const scripts = modules
  .map((file) => {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    if (/<\/script/i.test(code)) throw new Error(file + ' contains "</script"');
    return '<script>\n' + code + '</script>';
  })
  .join('\n');

const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const out = template.replace('<!-- MODULES -->', () => scripts);
const target = process.argv[2] || path.join(root, 'artifact', 'address-sorter.html');
fs.writeFileSync(target, out);
console.log('Wrote ' + target + ' (' + Math.round(out.length / 1024) + ' KB)');
