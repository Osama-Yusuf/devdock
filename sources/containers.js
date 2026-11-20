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

  async function scan() {
    if (ctx.DEMO) return require('../demo').demoContainers();
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
      k8s: k8sOf(c.Labels),
      ports: [...new Set((c.Ports || []).map(p => p.PublicPort).filter(Boolean))].sort((a, b) => a - b),
      volumes: (c.Mounts || []).filter(m => m.Type === 'volume').map(m => m.Name),
    })));
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
      containers, images, volumes, buildCache,
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

  return {
    id: 'containers',
    intervalMs: 5000,
    scan,
    last: () => last,
    snapshot,
    actions: {
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
