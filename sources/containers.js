// Docker containers, images, volumes and build cache, read from the Engine API over
// its unix socket (exact bytes and timestamps; the CLI prints "33.4MB").
//
// Facts this relies on (Engine API v1.47 spec, checked against OrbStack's daemon):
//   GET /system/df          Images[], Containers[], Volumes[] (UsageData.RefCount/Size), BuildCache[]
//   GET /containers/{id}/json  State.StartedAt / State.FinishedAt
//   Deleting anything still in use is refused by Docker itself with 409.
//   Kubernetes on Docker (OrbStack, Docker Desktop, kind's nodes aside) labels each container
//   io.kubernetes.pod.name/.namespace/.container.name; docker.type is "podsandbox" for
//   the pause container that holds a pod's network.
// Docker has no "last used" for images or volumes: it's the latest time a container
// using them stopped, and "running" when one of them is up right now.
const fs = require('fs');
const os = require('os');
const http = require('http');

const path = require('path');
// Compose files you pointed DevDock at after a stack's folder moved: stack name -> file
const LOCATED = path.join(process.env.DEVDOCK_DATA || path.join(os.homedir(), 'Library/Application Support/DevDock'), 'compose-files.json');
const located = () => { try { return JSON.parse(fs.readFileSync(LOCATED, 'utf8')); } catch { return {}; } };
const PINNED_API = 1.47; // stable /system/df shape; older daemons get their own version
const SOCKETS = [
  '~/.orbstack/run/docker.sock', '~/.docker/run/docker.sock', '/var/run/docker.sock',
  '~/.colima/default/docker.sock', '~/.rd/docker.sock',
].map(p => p.replace(/^~/, os.homedir()));

function k8sOf(labels = {}) {
  const pod = labels['io.kubernetes.pod.name'];
  return pod ? {
    pod,
    namespace: labels['io.kubernetes.pod.namespace'] || null,
    container: labels['io.kubernetes.container.name'] || null,
    sandbox: labels['io.kubernetes.docker.type'] === 'podsandbox',
  } : null;
}

module.exports = function containers(ctx) {
  let socketPath = null;
  let apiPrefix = null;
  let last = null; // latest scan; actions only accept ids from it
  const inspectCache = new Map(); // container id -> { state, startedAt, finishedAt }
  const usage = new Map();        // running container id -> [{ t, cpu, mem, rx, tx }], last 15 min

  // DOCKER_HOST, then the active docker context, then the usual sockets.
  // ponytail: unix sockets only; a tcp:// DOCKER_HOST reports Docker as unavailable.
  async function connect() {
    if (socketPath && fs.existsSync(socketPath)) return true;
    socketPath = apiPrefix = null;
    let host = process.env.DOCKER_HOST || '';
    const docker = ctx.findBin('docker');
    if (!host && docker) host = (await ctx.run(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
    const candidates = [host.startsWith('unix://') ? host.slice(7) : null, ...SOCKETS].filter(Boolean);
    socketPath = candidates.find(p => fs.existsSync(p)) || null;
    if (!socketPath) return false;
    const v = await request('GET', '/version');
    if (v.status !== 200) { socketPath = null; return false; }
    apiPrefix = `/v${Math.min(PINNED_API, parseFloat(v.body.ApiVersion) || PINNED_API).toFixed(2)}`;
    return true;
  }

  function request(method, urlPath, { timeout = 30000 } = {}) {
    return new Promise(resolve => {
      const req = http.request({ socketPath, method, path: urlPath, timeout }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => raw += c);
        res.on('end', () => {
          let body = raw;
          try { body = raw ? JSON.parse(raw) : null; } catch {}
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('timeout', () => req.destroy(new Error('Docker did not answer in time')));
      req.on('error', e => resolve({ status: 0, body: { message: e.message } }));
      req.end();
    });
  }
  const api = (method, p, opts) => request(method, apiPrefix + p, opts);

  // 2xx (and 304 "already stopped/started") is success; anything else is Docker's message
  async function call(method, p, opts) {
    const r = await api(method, p, opts);
    if (r.status >= 200 && r.status < 300 || r.status === 304) return r.body;
    throw Object.assign(new Error(r.body?.message || `Docker answered ${r.status}`), { status: r.status === 409 ? 409 : 500 });
  }

  // When a stopped container last ran; null while running (see `running`)
  async function lastRun(c) {
    if (c.State === 'running') return null;
    let info = inspectCache.get(c.Id);
    if (!info || info.state !== c.State) {
      const r = await api('GET', `/containers/${c.Id}/json`);
      const s = r.body?.State || {};
      const t = x => (x && !x.startsWith('0001-') ? Date.parse(x) : null); // zero time = never ran
      info = { state: c.State, startedAt: t(s.StartedAt), finishedAt: t(s.FinishedAt) };
      inspectCache.set(c.Id, info);
    }
    return info.finishedAt || info.startedAt || null;
  }

  // One-shot stats (no 1s wait for Docker's own second sample): CPU and network are rates,
  // so each comes from this reading and the one before it, kept here.
  const raw = new Map(); // id -> previous reading
  async function sample(c, now) {
    const s = (await api('GET', `/containers/${c.id}/stats?stream=false&one-shot=true`, { timeout: 4000 })).body;
    if (!s?.cpu_stats) return null;
    const net = Object.values(s.networks || {}).reduce((n, x) => ({ rx: n.rx + x.rx_bytes, tx: n.tx + x.tx_bytes }), { rx: 0, tx: 0 });
    const cur = { t: now, cpu: s.cpu_stats.cpu_usage?.total_usage || 0, sys: s.cpu_stats.system_cpu_usage || 0, ...net };
    const prev = raw.get(c.id);
    raw.set(c.id, cur);
    // same as `docker stats`: page cache isn't the container's memory
    const mem = Math.max(0, (s.memory_stats?.usage || 0) - (s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.total_inactive_file ?? 0)) / 1048576;
    if (!prev || cur.sys <= prev.sys) return null; // first reading: no rate yet
    const secs = (now - prev.t) / 1000 || 1;
    return {
      cpu: (cur.cpu - prev.cpu) / (cur.sys - prev.sys) * (s.cpu_stats.online_cpus || 1) * 100,
      mem, limit: (s.memory_stats?.limit || 0) / 1048576,
      rx: Math.max(0, cur.rx - prev.rx) / secs, tx: Math.max(0, cur.tx - prev.tx) / secs,
    };
  }
  // 30 points per series for sparklines
  const series = (list, f) => {
    const step = Math.max(1, Math.floor(list.length / 30));
    return list.filter((_, i) => i % step === 0 || i === list.length - 1).map(x => Math.round(x[f] * 10) / 10);
  };
  async function stats(containers) {
    const now = Date.now();
    const running = containers.filter(c => c.state === 'running' && !c.k8s?.sandbox);
    await Promise.all(running.map(async c => {
      const u = await sample(c, now).catch(() => null);
      if (!u) return;
      const list = usage.get(c.id) || [];
      list.push({ t: now, ...u });
      while (now - list[0].t > 15 * 60000) list.shift();
      usage.set(c.id, list);
      c.stats = { cpu: u.cpu, mem: u.mem, limit: u.limit, rx: u.rx, tx: u.tx,
        cpuSpark: series(list, 'cpu'), memSpark: series(list, 'mem'), rxSpark: series(list, 'rx'), txSpark: series(list, 'tx') };
    }));
    const live = new Set(running.map(c => c.id));
    for (const id of usage.keys()) if (!live.has(id)) { usage.delete(id); raw.delete(id); }
  }

  // Compose projects as stacks: their services, where the compose file lives, what they use
  function stacksOf(containers) {
    const by = new Map();
    for (const c of containers) if (c.project && !c.k8s) (by.get(c.project) || by.set(c.project, []).get(c.project)).push(c);
    return [...by].map(([name, list]) => {
      const files = [...new Set(list.flatMap(c => c.composeFiles || []))];
      const live = list.filter(c => c.state === 'running');
      let dir = list.find(c => c.composeDir)?.composeDir || null, filesFound = files.filter(f => ctx.DEMO || fs.existsSync(f));
      const moved = !filesFound.length && located()[name];
      if (moved && fs.existsSync(moved)) { filesFound = [moved]; dir = path.dirname(moved); }
      return {
        name, dir, files, filesFound, located: !!moved,
        services: list.map(c => ({ id: c.id, name: c.service || c.name, state: c.state, status: c.status, image: c.image })).sort((a, b) => a.name.localeCompare(b.name)),
        running: live.length, total: list.length,
        ports: [...new Set(list.flatMap(c => c.ports))].sort((a, b) => a - b),
        cpu: live.reduce((n, c) => n + (c.stats?.cpu || 0), 0), mem: live.reduce((n, c) => n + (c.stats?.mem || 0), 0),
        lastUsed: list.reduce((m, c) => Math.max(m, c.lastUsed || 0), 0) || null,
      };
    }).sort((a, b) => (b.running > 0) - (a.running > 0) || a.name.localeCompare(b.name));
  }

  async function scan() {
    if (ctx.DEMO) { last = require('../demo').demoContainers(); last.stacks = stacksOf(last.containers); return last; }
    if (!await connect()) return { available: false, reason: "Docker isn't running" };
    const df = await api('GET', '/system/df');
    if (df.status !== 200) { socketPath = null; return { available: false, reason: df.body?.message || "Docker isn't answering" }; }
    const d = df.body;

    const containers = await Promise.all((d.Containers || []).map(async c => ({
      id: c.Id,
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
      image: c.Image,
      imageId: c.ImageID,
      state: c.State,
      status: c.Status,
      createdAt: c.Created * 1000,
      lastUsed: await lastRun(c),
      size: c.SizeRw || 0,
      project: c.Labels?.['com.docker.compose.project'] || null,
      service: c.Labels?.['com.docker.compose.service'] || null,
      composeDir: c.Labels?.['com.docker.compose.project.working_dir'] || null,
      composeFiles: (c.Labels?.['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean),
      k8s: k8sOf(c.Labels),
      ports: [...new Set((c.Ports || []).map(p => p.PublicPort).filter(Boolean))].sort((a, b) => a - b),
      volumes: (c.Mounts || []).filter(m => m.Type === 'volume').map(m => m.Name),
    })));
    await stats(containers);
    const ids = new Set(containers.map(c => c.id));
    for (const id of inspectCache.keys()) if (!ids.has(id)) inspectCache.delete(id);

    const latest = list => list.reduce((max, c) => Math.max(max, c.lastUsed || 0), 0) || null;
    const anyRunning = list => list.some(c => c.state === 'running');
    const images = (d.Images || []).map(i => {
      const users = containers.filter(c => c.imageId === i.Id);
      return {
        id: i.Id,
        tags: (i.RepoTags || []).filter(t => t !== '<none>:<none>'),
        size: i.Size,
        unique: i.SharedSize >= 0 ? i.Size - i.SharedSize : i.Size, // freed if removed alone
        createdAt: i.Created * 1000,
        containers: users.length,
        running: anyRunning(users),
        lastUsed: latest(users),
      };
    });
    const volumes = (d.Volumes || []).map(v => {
      const users = containers.filter(c => c.volumes.includes(v.Name));
      return {
        name: v.Name,
        size: v.UsageData?.Size ?? -1, // -1: Docker didn't measure it
        containers: v.UsageData?.RefCount ?? users.length,
        createdAt: Date.parse(v.CreatedAt) || null,
        running: anyRunning(users),
        lastUsed: latest(users),
        anonymous: /^[0-9a-f]{64}$/.test(v.Name), // created by a container, no name given
        project: v.Labels?.['com.docker.compose.project'] || null,
      };
    });
    const cache = d.BuildCache || [];
    const sum = (list, f) => list.reduce((n, x) => n + Math.max(0, f(x) || 0), 0);
    const buildCache = {
      count: cache.length,
      size: sum(cache, c => c.Size),
      reclaimable: sum(cache.filter(c => !c.InUse), c => c.Size),
      lastUsed: cache.reduce((max, c) => Math.max(max, Date.parse(c.LastUsedAt) || 0), 0) || null,
    };
    // What each prune would remove, so the confirmation can say exactly that
    const stopped = containers.filter(c => c.state !== 'running' && c.state !== 'paused' && c.state !== 'restarting');
    const unusedImages = images.filter(i => !i.containers);
    const dangling = unusedImages.filter(i => !i.tags.length); // untagged, what `docker image prune` takes
    const unusedVolumes = volumes.filter(v => !v.containers);
    last = {
      available: true,
      // kubectl context of the cluster these k8s containers belong to, so commands never hit
      // whatever context is current. ponytail: OrbStack and Docker Desktop only, by socket path.
      k8sContext: socketPath.includes('/.orbstack/') ? 'orbstack' : socketPath.includes('/.docker/') ? 'docker-desktop' : null,
      containers, images, volumes, buildCache, stacks: stacksOf(containers),
      reclaimable: {
        containers: { count: stopped.length, size: sum(stopped, c => c.size) },
        // ponytail: layers shared only between unused images are counted once per image
        images: { count: unusedImages.length, size: sum(unusedImages, i => i.unique) },
        dangling: { count: dangling.length, size: sum(dangling, i => i.unique) },
        volumes: { count: unusedVolumes.length, size: sum(unusedVolumes, v => v.size) },
        build: { count: cache.filter(c => !c.InUse).length, size: buildCache.reclaimable },
      },
    };
    return last;
  }

  // Only ids Docker reported; the list may be stale if nobody was watching, so rescan once
  async function known(kind, key, value) {
    const has = () => last?.[kind]?.some(x => x[key] === value);
    if (!has()) await scan();
    if (!has()) throw Object.assign(new Error('It is gone already'), { status: 404 });
    return encodeURIComponent(value);
  }
  // The kubelet owns these: a stop or remove is undone in seconds, or breaks the pod
  async function notK8s(id) {
    const encoded = await known('containers', 'id', id);
    if (last.containers.find(c => c.id === id).k8s) throw Object.assign(new Error('Kubernetes manages this container; change it with kubectl'), { status: 400 });
    return encoded;
  }
  const filters = f => `filters=${encodeURIComponent(JSON.stringify(f))}`;
  const PRUNES = {
    containers: o => call('POST', '/containers/prune', o),                                  // stopped containers
    images: o => call('POST', `/images/prune?${filters({ dangling: ['false'] })}`, o),       // every image no container uses
    dangling: o => call('POST', '/images/prune', o),                                        // untagged ones only
    build: o => call('POST', '/build/prune?all=true', o),
    volumes: o => call('POST', `/volumes/prune?${filters({ all: ['true'] })}`, o),          // named ones too, not just anonymous
  };

  // State and recent logs of one container, as text for an agent's prompt
  async function snapshot(id) {
    await known('containers', 'id', id);
    const s = (await api('GET', `/containers/${encodeURIComponent(id)}/json`)).body?.State || {};
    const state = [`state: ${s.Status}`, s.ExitCode && `exit code: ${s.ExitCode}`, s.OOMKilled && 'OOM killed: yes',
      s.Error && `error: ${s.Error}`, s.Health && `health: ${s.Health.Status}`, s.Restarting && 'restarting: yes'].filter(Boolean).join('\n');
    // the CLI demuxes the log stream; -H pins it to the daemon this source reads
    const docker = ctx.findBin('docker');
    const logs = docker ? await ctx.run(docker, ['-H', `unix://${socketPath}`, 'logs', '--tail', '30', '--timestamps', id]) : null;
    const text = logs && (logs.stdout + logs.stderr).trim().split('\n').map(l => l.length > 300 ? l.slice(0, 300) + '…' : l).join('\n');
    return `${state}${text ? `\nRecent logs:\n${text}` : ''}`;
  }

  // `docker compose` for one stack. -p alone is enough to start, stop, restart or take down
  // what's running; pulling and recreating needs the compose files it was started from.
  const docker = () => ctx.findBin('docker') || (() => { throw Object.assign(new Error("The docker command isn't installed"), { status: 400 }); })();
  async function stack(name) {
    if (!last?.stacks?.some(s => s.name === name)) await scan();
    const s = last?.stacks?.find(x => x.name === name);
    if (!s) throw Object.assign(new Error('That stack is gone'), { status: 404 });
    return s;
  }
  const compose = (s, withFiles) => ['-H', `unix://${socketPath}`, 'compose', '-p', s.name,
    ...(withFiles ? ['--project-directory', s.dir, ...s.filesFound.flatMap(f => ['-f', f])] : [])];
  // Kubernetes containers: kubectl exec, pinned to the cluster these came from, never the current context
  const K8S_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
  async function k8sExec(id, cmd, tty) {
    await known('containers', 'id', id);
    const c = last.containers.find(x => x.id === id), k = c.k8s;
    if (!k || !last.k8sContext) throw Object.assign(new Error("Can't tell which cluster this container is in"), { status: 400 });
    if (![k.pod, k.namespace, k.container].every(v => K8S_NAME.test(v || ''))) throw Object.assign(new Error('Unexpected pod name'), { status: 400 });
    const kubectl = ctx.findBin('kubectl');
    if (!kubectl) throw Object.assign(new Error("The kubectl command isn't installed"), { status: 400 });
    return { file: kubectl, args: ['--context', last.k8sContext, '-n', k.namespace, 'exec', ...(tty ? ['-it'] : []), k.pod, '-c', k.container, '--', 'sh', '-c', cmd] };
  }
  const SHELL = 'command -v bash >/dev/null 2>&1 && exec bash || exec sh';

  async function running(id) {
    await notK8s(id);
    const c = last.containers.find(x => x.id === id);
    if (c.state !== 'running') throw Object.assign(new Error(`${c.name} isn't running`), { status: 400 });
    return c;
  }

  // Commands that run inside DevDock's terminal, so you watch them happen
  async function terminal(p) {
    if (ctx.DEMO) return null;
    if (p.kind === 'shell' && last?.containers?.find(x => x.id === p.id)?.k8s) return k8sExec(p.id, SHELL, true);
    if (p.kind === 'shell') {
      const c = await running(p.id);
      // bash if the image has it, else sh; values ride as argv, never inside the script
      return { file: docker(), args: ['-H', `unix://${socketPath}`, 'exec', '-it', c.id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'] };
    }
    if (p.kind === 'update') {
      const s = await stack(p.stack);
      if (!s.filesFound.length) throw Object.assign(new Error(`Can't find ${s.name}'s compose file`), { status: 400 });
      const args = compose(s, true);
      return { file: '/bin/sh', cwd: s.dir, args: ['-c', '"$0" "$@" pull && "$0" "$@" up -d && echo && echo "Updated. Close with ⌘."', docker(), ...args] };
    }
    return null;
  }

  return {
    id: 'containers',
    terminal,
    intervalMs: 5000,
    scan,
    last: () => last,
    snapshot,
    actions: {
      // compose up/down/start/stop for a whole stack; down keeps volumes
      async stack({ stack: name, op }) {
        if (!['start', 'stop', 'restart', 'down'].includes(op)) throw Object.assign(new Error('Unknown stack action'), { status: 400 });
        if (ctx.DEMO) return {};
        const s = await stack(name);
        const r = await ctx.run(docker(), [...compose(s, false), op], { timeout: 180000 });
        if (r.code) throw Object.assign(new Error((r.stderr || r.stdout).trim().split('\n').pop() || `docker compose ${op} failed`), { status: 500 });
        return {};
      },
      // The stack's folder moved: pick its compose file in the Finder, remembered from then on
      async locateCompose({ stack: name }) {
        const s = await stack(name);
        const r = await ctx.run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'POSIX path of (choose file with prompt ("Find the compose file for " & item 1 of argv))', '-e', 'end run', s.name], { timeout: 300000 });
        const file = r.stdout.trim();
        if (r.code || !file) return { cancelled: true };
        if (!/\.ya?ml$/i.test(file)) throw Object.assign(new Error('Pick the compose .yaml or .yml file'), { status: 400 });
        const all = located();
        all[s.name] = file;
        fs.mkdirSync(path.dirname(LOCATED), { recursive: true });
        fs.writeFileSync(LOCATED, JSON.stringify(all, null, 2), { mode: 0o600 });
        await scan();
        return { file };
      },
      // can we open a shell? distroless and scratch images have none
      async canShell({ id }) {
        if (ctx.DEMO) return { ok: true };
        if (last?.containers?.find(x => x.id === id)?.k8s) { const k = await k8sExec(id, 'exit 0', false); return { ok: (await ctx.run(k.file, k.args, { timeout: 10000 })).code === 0 }; }
        const c = await running(id);
        const r = await ctx.run(docker(), ['-H', `unix://${socketPath}`, 'exec', c.id, 'sh', '-c', 'exit 0'], { timeout: 8000 });
        return { ok: r.code === 0 };
      },
      start: async ({ id }) => (await call('POST', `/containers/${await notK8s(id)}/start`), {}),
      stop: async ({ id }) => (await call('POST', `/containers/${await notK8s(id)}/stop`, { timeout: 60000 }), {}),
      // no force: Docker refuses running containers and images or volumes still in use
      removeContainer: async ({ id }) => (await call('DELETE', `/containers/${await notK8s(id)}`), {}),
      removeImage: async ({ id }) => (await call('DELETE', `/images/${await known('images', 'id', id)}`), {}),
      removeVolume: async ({ name }) => (await call('DELETE', `/volumes/${await known('volumes', 'name', name)}`), {}),
      // kinds run in this order: removing stopped containers first frees their images
      async prune({ kinds }) {
        const order = ['containers', 'dangling', 'images', 'build', 'volumes'].filter(k => kinds?.includes(k));
        if (!order.length) throw Object.assign(new Error('Nothing to clean'), { status: 400 });
        let reclaimed = 0;
        for (const k of order) reclaimed += (await PRUNES[k]({ timeout: 300000 }))?.SpaceReclaimed || 0;
        return { reclaimed };
      },
    },
  };
};
