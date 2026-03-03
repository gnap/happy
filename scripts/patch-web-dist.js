#!/usr/bin/env node
/**
 * Patches dist/index.html after expo export to inject polyfills
 * that must run before any JS bundle loads.
 *
 * Run: node scripts/patch-web-dist.js
 */
const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');

const polyfill = `<script>
/* Polyfill: WebKit2GTK (Linux/Tauri) does not implement screen.orientation */
if (typeof screen !== 'undefined' && !screen.orientation) {
  Object.defineProperty(screen, 'orientation', {
    value: {
      type: 'portrait-primary',
      angle: 0,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; },
      onchange: null,
      lock: function() { return Promise.resolve(); },
      unlock: function() {},
    },
    writable: true,
    configurable: true,
  });
}
</script>`;

if (html.includes('screen.orientation')) {
  console.log('patch-web-dist: polyfill already present, skipping.');
  process.exit(0);
}

// Inject as the very first child of <head>
html = html.replace('<head>', '<head>\n  ' + polyfill);
fs.writeFileSync(indexPath, html, 'utf8');
console.log('patch-web-dist: injected screen.orientation polyfill into dist/index.html');
