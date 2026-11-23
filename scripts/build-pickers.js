// Writes the data behind the machine icon picker into public/vendor/ (generated, not committed):
//   icons.json  [slug, title, hex, svg path, aka] for every Simple Icons brand (CC0)
//   emoji.json  [emoji, name, group] in Unicode order
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'public', 'vendor');
const nm = path.join(__dirname, '..', 'node_modules'), si = path.join(nm, 'simple-icons');
const icons = JSON.parse(fs.readFileSync(path.join(si, 'data', 'simple-icons.json'), 'utf8')).map(i => {
  const svg = fs.readFileSync(path.join(si, 'icons', `${i.slug}.svg`), 'utf8');
  return [i.slug, i.title, i.hex, svg.match(/ d="([^"]+)"/)[1], (i.aliases?.aka || []).join(' ')];
});
const emoji = Object.entries(JSON.parse(fs.readFileSync(path.join(nm, 'unicode-emoji-json', 'data-by-emoji.json'), 'utf8'))).map(([e, d]) => [e, d.name, d.group]);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icons.json'), JSON.stringify(icons));
fs.writeFileSync(path.join(out, 'emoji.json'), JSON.stringify(emoji));
console.log(`pickers: ${icons.length} icons, ${emoji.length} emoji`);
