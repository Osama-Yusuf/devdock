const express = require('express');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = 4003; // dashboard port

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Helper: get ports used by Node processes via lsof (macOS/Linux)
function getNodePorts() {
  return new Promise((resolve, reject) => {
    const cmd = 'lsof -iTCP -sTCP:LISTEN -P -n';

    exec(cmd, async (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);

      const lines = stdout.trim().split('\n');
      const results = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        const command = parts[0];
        const pid = parts[1];
        const user = parts[2];

        if (command !== 'node') continue;

        // find host:port token (*:3000, 127.0.0.1:5173, [::1]:3000, etc.)
        const addr = parts.find(p => p.includes(':')) || '';

        let port = null;
        if (addr) {
          // take the part after the LAST colon -> handles IPv6 like [::1]:3000
          const lastColon = addr.lastIndexOf(':');
          if (lastColon !== -1) {
            const candidate = addr.slice(lastColon + 1); // e.g. "3000"
            if (/^\d+$/.test(candidate)) {
              port = parseInt(candidate, 10);
            }
          }
        }

        // Get process working directory (project path)
        const cwdPath = await new Promise(resolve2 => {
          // -a -d cwd = only cwd entry, -F n = just "n<path>" lines
          exec(`lsof -p ${pid} -a -d cwd -Fn`, (err2, out2) => {
            if (err2 || !out2) return resolve2(null);

            const lineWithPath = out2
              .split('\n')
              .find(l => l.startsWith('n/')); // n + absolute path

            resolve2(lineWithPath ? lineWithPath.substring(1) : null);
          });
        });

        results.push({
          command,
          pid,
          user,
          port,
          scriptPath: cwdPath, // this is the PATH column in your UI
          label: guessLabel(port)
        });
      }

      resolve(results);
    });
  });
}

// Try to "label" some common dev ports
function guessLabel(port) {
  if (!port) return null;
  if (port === 3000) return 'React / Next dev';
  if (port === 5173) return 'Vite dev';
  if (port === 4200) return 'Angular dev';
  if (port === 8080) return 'Generic dev server';
  if (port === 9229) return 'Node inspector/debug';
  return null;
}

// API endpoint
app.get('/api/ports', async (req, res) => {
  try {
    const ports = await getNodePorts();
    res.json({
      timestamp: new Date().toISOString(),
      count: ports.length,
      ports
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Kill endpoint
app.post('/api/kill/:pid', (req, res) => {
  const pid = req.params.pid;
  
  if (!pid || !/^\d+$/.test(pid)) {
    return res.status(400).json({ error: 'Invalid PID' });
  }

  exec(`kill ${pid}`, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ 
        error: `Failed to kill PID ${pid}`, 
        details: stderr || err.message 
      });
    }
    res.json({ success: true, pid, message: `Process ${pid} killed` });
  });
});

// Start dashboard server
app.listen(PORT, () => {
  console.log(`🚀 Node Ports Dashboard running at http://localhost:${PORT}`);
});

