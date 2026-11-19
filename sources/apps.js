// Running Mac apps: windowed apps, menu bar apps (Bartender, Raycast...) and background
// agents, each with every process it's responsible for.
//
// `lsappinfo list` (checked live, macOS 27) prints one block per app:
//    4) "Google Chrome" ASN:0x0-0x10010: (in front)
//       bundleID="com.google.Chrome"
//       bundle path="/Applications/Google Chrome.app"
//       executable path=".../MacOS/Google Chrome"
//       pid = 703 token=[...] type="Foreground" flavor=3 Version="8037.93" ... Arch=ARM64
//       coalition: 766  { 1059 1476 ... }      <- helpers, XPC services, what it launched
//       launch time =  2026/10/02 03:57:09 ( ... )
// type: Foreground (Dock icon), UIElement (menu bar or agent), BackgroundOnly.
// Quit is the Apple Event an app gets from the Dock, so it can ask to save; macOS asks
// once per app whether DevDock may send it. Force quit is SIGKILL.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KIND = { Foreground: 'app', UIElement: 'menu', BackgroundOnly: 'background' };
const ICON_DIR = path.join(os.tmpdir(), 'devdock-icons');

function parse(out) {
  const apps = [];
  for (const block of out.split(/\n(?=\s*\d+\) ")/)) {
    const name = block.match(/^\s*\d+\) "(.*)" ASN:/)?.[1];
    const pid = block.match(/\bpid = (\d+)/)?.[1];
    const type = block.match(/\btype="(\w+)"/)?.[1];
    if (!name || !pid || !KIND[type]) continue;
    const q = k => block.match(new RegExp(`${k}="([^"]*)"`))?.[1] || null;
    const launch = block.match(/launch time =\s+(\d{4})\/(\d\d)\/(\d\d) ([\d:]+)/);
    apps.push({
      name, pid, kind: KIND[type],
      bundleId: q('bundleID'), path: q('bundle path'), exec: q('executable path'),
      build: q('Version'), arch: block.match(/Arch=(\S+)/)?.[1] || null,
      front: /ASN:\S+ \(in front\)/.test(block),
      launchedAt: launch ? new Date(`${launch[1]}-${launch[2]}-${launch[3]}T${launch[4]}`).getTime() : null,
      coalition: (block.match(/coalition: \d+\s+\{([\d\s]+)\}/)?.[1] || '').trim().split(/\s+/).filter(Boolean),
    });
  }
  return apps;
}

module.exports = function apps(ctx) {
  let last = [];
  const plist = new Map(); // bundle path -> { version, icon, electron }

  // What doesn't change while an app runs: read once per bundle
  async function bundleInfo(p) {
    if (!p?.endsWith('.app')) return {};
    if (plist.has(p)) return plist.get(p);
    const r = await ctx.run('plutil', ['-convert', 'json', '-o', '-', path.join(p, 'Contents/Info.plist')]);
    let d = {};
    try { d = JSON.parse(r.stdout); } catch {}
    const iconName = d.CFBundleIconFile && d.CFBundleIconFile.replace(/(\.icns)?$/, '.icns');
    const icon = iconName && path.join(p, 'Contents/Resources', iconName);
    const info = {
      version: d.CFBundleShortVersionString || null,
      icon: icon && fs.existsSync(icon) ? icon : null,
      electron: fs.existsSync(path.join(p, 'Contents/Frameworks/Electron Framework.framework')),
    };
    plist.set(p, info);
    return info;
  }

  async function scan() {
    if (ctx.DEMO) return { apps: [] };
    const r = await ctx.run('lsappinfo', ['list']);
    const procs = ctx.procs();
    const ports = ctx.ports();
    const home = os.homedir();
    const listed = parse(r.stdout).filter(a => procs[a.pid]);
    // a helper app inside another app's bundle (Google Chrome Helper) belongs to that app
    const parent = a => a.path && listed.find(b => b !== a && b.path && a.path.startsWith(b.path + '/'));
    last = await Promise.all(listed.filter(a => !parent(a)).map(async a => {
      const info = await bundleInfo(a.path);
      // its own processes live inside its bundle; the rest of the coalition it launched (a terminal's shells)
      const helpers = listed.filter(h => parent(h) === a).flatMap(h => [h.pid, ...h.coalition]);
      const pids = [...new Set([a.pid, ...a.coalition, ...helpers])].filter(pid => procs[pid]);
      const own = new Set(pids.filter(pid => pid === a.pid || (a.path && procs[pid].comm.startsWith(a.path))));
      const sum = k => [...own].reduce((n, pid) => n + (procs[pid][k] || 0), 0);
      const { coalition, exec, ...pub } = a;
      return {
        ...pub,
        version: info.version || a.build, electron: !!info.electron, hasIcon: !!info.icon,
        system: !a.path || /^\/(System|usr|Library\/Apple)\//.test(a.path) || a.path.startsWith('/Library/') && a.bundleId?.startsWith('com.apple.'),
        user: a.path?.startsWith(home) || false,
        cpu: sum('cpu'), memMB: sum('rssMB'),
        processes: pids.map(pid => ({
          pid, name: path.basename(procs[pid].comm), own: own.has(pid),
          cpu: procs[pid].cpu, memMB: procs[pid].rssMB, startedAt: procs[pid].startedAt,
        })).sort((x, y) => (y.pid === a.pid) - (x.pid === a.pid) || y.own - x.own || y.memMB - x.memMB),
        ports: [...new Set(ports.filter(p => own.has(String(p.pid))).map(p => p.port))].sort((x, y) => x - y),
      };
    }));
    return { apps: last };
  }

  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  // only apps and pids from the latest scan, and never DevDock itself
  const ME = new Set([String(process.pid), String(process.ppid)]);
  // the list may be older than what was clicked: rescan once before saying it's gone
  async function fresh(test) { if (!test()) await scan(); return test(); }
  async function app(pid) {
    const a = await fresh(() => last.find(x => x.pid === String(pid)));
    if (!a) throw bad('That app is gone', 404);
    return a;
  }
  async function proc(pid) {
    pid = String(pid);
    if (ME.has(pid)) throw bad("That's DevDock itself");
    if (!await fresh(() => last.some(a => a.processes.some(p => p.pid === pid)))) throw bad('That process is gone', 404);
    return +pid;
  }
  const signal = (pid, sig) => { try { process.kill(pid, sig); return true; } catch (e) { if (e.code === 'ESRCH') return true; throw bad(e.code === 'EPERM' ? "macOS won't let DevDock stop that process" : e.message); } };
  const appleQuit = a => ctx.run('osascript', ['-e', 'on run argv', '-e', 'tell application id (item 1 of argv) to quit', '-e', 'end run', a.bundleId], { timeout: 8000 });
  const gone = pid => { try { process.kill(+pid, 0); return false; } catch { return true; } };

  async function quit(a) {
    if (ME.has(a.pid)) throw bad("That's DevDock itself");
    if (!a.bundleId) return signal(+a.pid, 'SIGTERM');
    const r = await appleQuit(a);
    if (r.code === 0) return true;
    // -1743: the user said no to DevDock controlling it; -128: it asked to save and was cancelled
    if (/-1743/.test(r.stderr)) throw bad(`DevDock isn't allowed to control ${a.name}. Allow it in System Settings > Privacy & Security > Automation, or force quit.`, 403);
    if (/-128/.test(r.stderr)) throw bad(`${a.name} didn't quit`, 409);
    return signal(+a.pid, 'SIGTERM'); // no scripting support: the same as `kill`
  }

  return {
    id: 'apps',
    intervalMs: 3000,
    scan,
    // PNG of an app's icon, for <img>: converted once with sips and kept in tmp
    async icon(pid) {
      const a = last.find(x => x.pid === String(pid));
      const src = a && plist.get(a.path)?.icon;
      if (!src) return null;
      const out = path.join(ICON_DIR, crypto.createHash('sha1').update(src).digest('hex').slice(0, 16) + '.png');
      if (!fs.existsSync(out)) {
        fs.mkdirSync(ICON_DIR, { recursive: true });
        const r = await ctx.run('sips', ['-s', 'format', 'png', '-Z', '64', src, '--out', out]);
        if (r.code !== 0) return null;
      }
      return out;
    },
    actions: {
      async quit({ pid }) { await quit((await app(pid))); return {}; },
      async forceQuit({ pid }) {
        const a = (await app(pid));
        if (ME.has(a.pid)) throw bad("That's DevDock itself");
        a.processes.filter(p => p.own).forEach(p => signal(+p.pid, 'SIGKILL'));
        return {};
      },
      async kill({ pid, force }) { signal(await proc(pid), force ? 'SIGKILL' : 'SIGTERM'); return {}; },
      async show({ pid }) { const a = (await app(pid)); await ctx.run('open', a.bundleId ? ['-b', a.bundleId] : [a.path]); return {}; },
      async reveal({ pid }) { const a = (await app(pid)); if (a.path) await ctx.run('open', ['-R', a.path]); return {}; },
      // quit, wait for it to go, open it again
      async restart({ pid }) {
        const a = (await app(pid));
        await quit(a);
        for (let i = 0; i < 40 && !gone(a.pid); i++) await new Promise(r => setTimeout(r, 250));
        if (!gone(a.pid)) throw bad(`${a.name} is still running`, 409);
        await ctx.run('open', a.bundleId ? ['-b', a.bundleId] : [a.path]);
        return {};
      },
    },
  };
};

module.exports.parse = parse;

if (require.main === module) {
  const assert = require('assert');
  const sample = ` 4) "Google Chrome" ASN:0x0-0x10010: (in front) \n    bundleID="com.google.Chrome"\n    bundle path="/Applications/Google Chrome.app"\n    executable path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n    pid = 703 token=[sess=1] type="Foreground" flavor=3 Version="8037.93" fileType="APPL" Arch=ARM64 \n    coalition: 766  { 1059 1476 }\n    launch time =  2026/10/02 03:57:09 ( 48 days ago )\n 5) "universalaccessd" ASN:0x0-0xb00b: \n    bundleID=[ NULL ] \n    pid = 668 token=[x] type="BackgroundOnly" flavor=3 Version=[ NULL ]  Arch=ARM64 \n 6) "Weird" ASN:0x0-0x1: \n    pid = 9 type="Unknown"`;
  const [c, u, ...rest] = parse(sample);
  assert.strictEqual(rest.length, 0);
  assert.deepStrictEqual([c.name, c.pid, c.kind, c.bundleId, c.front, c.arch, c.coalition], ['Google Chrome', '703', 'app', 'com.google.Chrome', true, 'ARM64', ['1059', '1476']]);
  assert.strictEqual(new Date(c.launchedAt).getFullYear(), 2026);
  assert.deepStrictEqual([u.kind, u.bundleId, u.front, u.coalition], ['background', null, false, []]);
  console.log('apps self-check ok');
}
