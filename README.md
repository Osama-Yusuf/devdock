# DevDock

A sleek, real-time dashboard to monitor, manage, and control all dev processes listening on TCP ports.

![Dashboard](https://img.shields.io/badge/dashboard-live-22c55e) ![Node](https://img.shields.io/badge/node-%3E%3D18-blue) ![License](https://img.shields.io/badge/license-MIT-purple)

## Features

- **Multi-runtime detection** — Node.js, Python, Ruby, Java, Go, PHP, Rust, .NET, Docker, Nginx, Apache, PostgreSQL, MySQL, Redis, MongoDB
- **Health checks** — Green/yellow/red status dots showing if each port actually responds
- **Settings page** — Toggle runtimes on/off, configure refresh interval, grouping depth, notifications
- **Port history** — Browse previously discovered ports at `/history`, start stopped servers, remove entries
- **Favorites** — Pin important ports to the top of the table
- **Dark/light theme** — Toggle with persistence
- **Process grouping** — Group ports by parent project directory with configurable depth
- **Desktop notifications** — Get notified when ports come up or go down
- **Export** — Copy port list as Markdown, JSON, or CSV
- **Keyboard shortcuts** — `/` search, `R` refresh, `S` settings, `G` group, `E` export, `T` theme
- **CPU/Memory usage** — Live CPU% and RSS memory per process with inline usage bars
- **Quick actions** — Restart (SIGHUP) or kill any process from the dropdown menu
- **Clickable everything** — Port opens browser, PID copies to clipboard, Path opens terminal

## Quick Start

```bash
git clone https://github.com/Osama-Yusuf/devdock.git
cd devdock
npm install
npm start
```

Open [http://localhost:4003](http://localhost:4003)

## Pages

| Route | Description |
|-------|-------------|
| `/` | Main dashboard — live view of all listening ports |
| `/history` | Port history — all previously discovered processes |

## Settings

Settings persist to `devdock-settings.json` (gitignored). Configurable via the gear icon or `S` key:

- **Runtime toggles** — Enable/disable detection per runtime
- **Refresh interval** — 2s, 5s, 10s, 30s, or 1m
- **Grouping depth** — How many path segments to trim for project grouping
- **Show unrecognized processes** — Catch-all for unknown runtimes
- **Desktop notifications** — Browser notifications on port up/down
- **History** — Toggle history tracking, clear all records

## Tech Stack

- **Backend** — Node.js + Express
- **Frontend** — Vanilla HTML/CSS/JS (no build step, no frameworks)
- **Port detection** — `lsof` (macOS/Linux)
- **Health checks** — HTTP GET to each port
- **Terminal integration** — Opens Terminal.app via AppleScript (macOS)

## Requirements

- Node.js >= 18
- macOS or Linux (uses `lsof`)
