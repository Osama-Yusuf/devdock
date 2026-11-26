// Writes the data behind the machine icon picker into public/vendor/ (generated, not committed),
// gzipped: the server sends it as is with Content-Encoding: gzip, so the app ships 1/3 of the bytes.
//   icons.json.gz  [slug, title, hex, svg path, aka] for every Simple Icons brand (CC0)
//   emoji.json.gz  [emoji, name, group] in Unicode order
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const out = path.join(__dirname, '..', 'public', 'vendor');
const nm = path.join(__dirname, '..', 'node_modules'), si = path.join(nm, 'simple-icons');
const icons = JSON.parse(fs.readFileSync(path.join(si, 'data', 'simple-icons.json'), 'utf8')).map(i => {
  const svg = fs.readFileSync(path.join(si, 'icons', `${i.slug}.svg`), 'utf8');
  return [i.slug, i.title, i.hex, svg.match(/ d="([^"]+)"/)[1], (i.aliases?.aka || []).join(' ')];
});
const emoji = Object.entries(JSON.parse(fs.readFileSync(path.join(nm, 'unicode-emoji-json', 'data-by-emoji.json'), 'utf8'))).map(([e, d]) => [e, d.name, d.group]);
fs.mkdirSync(out, { recursive: true });
const gz = (name, data) => {
  fs.rmSync(path.join(out, name), { force: true }); // the old uncompressed copy
  fs.writeFileSync(path.join(out, `${name}.gz`), zlib.gzipSync(JSON.stringify(data), { level: 9 }));
};
gz('icons.json', icons);
gz('emoji.json', emoji);
console.log(`pickers: ${icons.length} icons, ${emoji.length} emoji`);
