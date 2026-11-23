#!/usr/bin/env node
// Signs agent releases with DevDock's Ed25519 release key, in OpenSSH's signature format,
// so any server checks it with stock `ssh-keygen -Y verify`: no extra tools to install.
//
//   node agent/release-sign.js keygen          create the key (once; back it up, keep it off GitHub)
//   node agent/release-sign.js pub             the lines to embed: install-agent.sh and -X main.updateKey
//   node agent/release-sign.js sign <file>     writes <file>.sig (SSHSIG, for install-agent.sh)
//   node agent/release-sign.js raw <file>      writes <file>.sig (base64 Ed25519, for the agent's self-update)
//
// Key: $DEVDOCK_RELEASE_KEY or ~/.config/devdock/release-key.pem
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');

const KEY = process.env.DEVDOCK_RELEASE_KEY || path.join(os.homedir(), '.config/devdock/release-key.pem');
const NS = 'devdock-release';
const str = b => { b = Buffer.from(b); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };
const raw = pub => pub.export({ format: 'der', type: 'spki' }).subarray(-32);
const sshPub = pub => Buffer.concat([str('ssh-ed25519'), str(raw(pub))]);

function sign(priv, data) {
  const pub = crypto.createPublicKey(priv);
  const toSign = Buffer.concat([Buffer.from('SSHSIG'), str(NS), str(''), str('sha512'), str(crypto.createHash('sha512').update(data).digest())]);
  const sig = Buffer.concat([Buffer.from('SSHSIG'), Buffer.from([0, 0, 0, 1]), str(sshPub(pub)), str(NS), str(''), str('sha512'),
    str(Buffer.concat([str('ssh-ed25519'), str(crypto.sign(null, toSign, priv))]))]);
  return `-----BEGIN SSH SIGNATURE-----\n${sig.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END SSH SIGNATURE-----\n`;
}

const load = () => crypto.createPrivateKey(fs.readFileSync(KEY));
const [cmd, file] = process.argv.slice(2);
if (cmd === 'keygen') {
  if (fs.existsSync(KEY)) throw new Error(`${KEY} exists: refusing to replace the release key`);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(KEY), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  console.log(`Created ${KEY}. Back it up somewhere offline.`);
} else if (cmd === 'pub') {
  const pub = crypto.createPublicKey(load());
  console.log(`install-agent.sh:  ssh-ed25519 ${sshPub(pub).toString('base64')}`);
  console.log(`-X main.updateKey=${raw(pub).toString('base64')}`);
} else if (cmd === 'sign' && file) {
  fs.writeFileSync(file + '.sig', sign(load(), fs.readFileSync(file)));
  console.log(`Signed ${file}.sig`);
} else if (cmd === 'raw' && file) {
  fs.writeFileSync(file + '.sig', crypto.sign(null, fs.readFileSync(file), load()).toString('base64') + '\n');
  console.log(`Signed ${file}.sig`);
} else {
  console.error('usage: release-sign.js keygen | pub | sign <file> | raw <file>');
  process.exit(1);
}
