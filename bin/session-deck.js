#!/usr/bin/env node
'use strict';

// session-deck — mission control for parallel Claude Code sessions.
//
// Serves a live local dashboard for the session presence board maintained by
// the agent-ops `board-register.sh` hook: one JSONL row per live session,
//   {"sid":"...","cwd":"...","cfg":"...","seen":"YYYY-MM-DD HH:MM","doing":"..."}
//
// Zero dependencies. Node's stdlib only.
//
//   session-deck                          serve on http://localhost:4680
//   session-deck --board <path>           point at a different board file
//   session-deck --port <n>               serve on another port
//   session-deck --once                   print the board as a table and exit

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Board parsing
// ---------------------------------------------------------------------------

/**
 * Parse the JSONL board text into rows. Malformed lines and rows without a
 * usable `sid` are skipped — the board is written by concurrent shell hooks,
 * so torn or partial lines are a fact of life, not an error.
 */
function parseBoard(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // torn write, half a row — skip
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (typeof row.sid !== 'string' || row.sid === '') continue;
    rows.push({
      sid: row.sid,
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      cfg: typeof row.cfg === 'string' ? row.cfg : '',
      seen: typeof row.seen === 'string' ? row.seen : '',
      doing: typeof row.doing === 'string' ? row.doing : '',
    });
  }
  return rows;
}

/** Parse a board timestamp ("YYYY-MM-DD HH:MM", local time) to epoch ms, or null. */
function parseSeen(seen) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(seen || '').trim());
  if (!m) return null;
  const [, y, mo, day, h, min] = m.map(Number);
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || min > 59) return null;
  const d = new Date(y, mo - 1, day, h, min);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Age in seconds -> freshness bucket: live (<2min), idle (<10min), stale. */
function freshness(ageSeconds) {
  if (ageSeconds == null || ageSeconds < 0 || Number.isNaN(ageSeconds)) return 'stale';
  if (ageSeconds < 120) return 'live';
  if (ageSeconds < 600) return 'idle';
  return 'stale';
}

/** Human "Xs/Xm/Xh ago" label for an age in seconds. */
function ageLabel(ageSeconds) {
  if (ageSeconds == null || Number.isNaN(ageSeconds)) return 'unknown';
  const s = Math.max(0, Math.floor(ageSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Repo display name: basename of the session's cwd. */
function repoName(cwd) {
  const clean = String(cwd || '').replace(/\/+$/, '');
  if (!clean) return '(unknown)';
  return path.basename(clean) || '(unknown)';
}

/** Rows -> rows decorated with age/freshness, sorted freshest-first. */
function decorate(rows, nowMs) {
  return rows
    .map((row) => {
      const seenMs = parseSeen(row.seen);
      const age = seenMs == null ? null : (nowMs - seenMs) / 1000;
      return { ...row, repo: repoName(row.cwd), age, state: freshness(age) };
    })
    .sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_BOARD = path.join(os.homedir(), '.claude-sessions', 'board.jsonl');
const DEFAULT_PORT = 4680;

function parseArgs(argv) {
  const opts = { board: DEFAULT_BOARD, port: DEFAULT_PORT, once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--board') opts.board = argv[++i];
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--once') opts.once = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  if (!opts.board) opts.board = DEFAULT_BOARD;
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) opts.port = DEFAULT_PORT;
  return opts;
}

const MISSING_BOARD_HINT = (board) => `
No board file at ${board}

The board is written by the agent-ops session hook. To set it up:

  1. Clone https://github.com/dylanpulver/agent-ops
  2. Install hooks/board-register.sh into your Claude Code hooks
     (see patterns/01-session-board.md for the walkthrough)
  3. Start a Claude Code session — a row appears on the board

Or point session-deck somewhere else:  session-deck --board <path>
`;

function readBoard(boardPath) {
  try {
    return { text: fs.readFileSync(boardPath, 'utf8'), missing: false };
  } catch (err) {
    if (err.code === 'ENOENT') return { text: '', missing: true };
    return { text: '', missing: true, error: String(err.message || err) };
  }
}

// ---------------------------------------------------------------------------
// --once: plain table to stdout
// ---------------------------------------------------------------------------

function renderTable(rows, nowMs, useColor) {
  const c = useColor
    ? { live: '\x1b[32m', idle: '\x1b[33m', stale: '\x1b[90m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
    : { live: '', idle: '', stale: '', dim: '', bold: '', reset: '' };
  const decorated = decorate(rows, nowMs);
  if (decorated.length === 0) return `${c.dim}(board is empty — no live sessions)${c.reset}\n`;

  const data = decorated.map((r) => ({
    state: r.state,
    dot: '●',
    repo: r.repo,
    cfg: r.cfg || '?',
    seen: ageLabel(r.age),
    doing: r.doing.length > 56 ? r.doing.slice(0, 55) + '…' : r.doing || '—',
  }));
  const w = {
    repo: Math.max(4, ...data.map((d) => d.repo.length)),
    cfg: Math.max(3, ...data.map((d) => d.cfg.length)),
    seen: Math.max(4, ...data.map((d) => d.seen.length)),
  };
  const lines = [];
  lines.push(
    `${c.bold}  ${'REPO'.padEnd(w.repo)}  ${'CFG'.padEnd(w.cfg)}  ${'SEEN'.padEnd(w.seen)}  DOING${c.reset}`
  );
  for (const d of data) {
    lines.push(
      `${c[d.state]}${d.dot}${c.reset} ${d.repo.padEnd(w.repo)}  ${c.dim}${d.cfg.padEnd(w.cfg)}${c.reset}  ${c[d.state]}${d.seen.padEnd(w.seen)}${c.reset}  ${d.doing}`
    );
  }
  const live = data.filter((d) => d.state === 'live').length;
  lines.push(`${c.dim}${data.length} session${data.length === 1 ? '' : 's'} · ${live} live${c.reset}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// HTML page (fully self-contained, inlined below)
// ---------------------------------------------------------------------------

function pageHtml(boardPath) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>session-deck</title>
<style>
  :root {
    --bg: #07090d;
    --panel: #0d1117;
    --panel-2: #10161f;
    --border: #1c2532;
    --border-soft: #151d29;
    --text: #cdd7e4;
    --text-dim: #5d6b7e;
    --text-faint: #3a4656;
    --live: #34d17b;
    --idle: #e2b93b;
    --stale: #55606e;
    --accent: #55b8ff;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    background:
      radial-gradient(1100px 500px at 70% -10%, rgba(85,184,255,.06), transparent 60%),
      radial-gradient(900px 500px at 10% 110%, rgba(52,209,123,.04), transparent 60%),
      var(--bg);
    color: var(--text);
    font-family: var(--mono);
    font-size: 14px;
    line-height: 1.5;
    padding: 28px 32px 48px;
  }
  header {
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding-bottom: 18px; margin-bottom: 24px;
    border-bottom: 1px solid var(--border);
  }
  .brand { font-size: 17px; font-weight: 700; letter-spacing: .16em; }
  .brand .dim { color: var(--text-dim); font-weight: 400; }
  .tagline { color: var(--text-dim); font-size: 12.5px; }
  .spacer { flex: 1; }
  .count {
    display: inline-flex; align-items: center; gap: 8px;
    border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 12px; font-size: 12.5px; color: var(--text-dim);
    background: var(--panel);
  }
  .count b { color: var(--text); font-weight: 600; }
  .pulse {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--live); box-shadow: 0 0 0 0 rgba(52,209,123,.5);
    animation: pulse 2.4s infinite;
  }
  .pulse.off { background: var(--stale); animation: none; box-shadow: none; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(52,209,123,.45); }
    70% { box-shadow: 0 0 0 7px rgba(52,209,123,0); }
    100% { box-shadow: 0 0 0 0 rgba(52,209,123,0); }
  }
  .boardpath { color: var(--text-faint); font-size: 11.5px; }
  .group { margin-bottom: 26px; }
  .group-head {
    display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px;
  }
  .group-head .name { color: var(--accent); font-weight: 600; font-size: 13.5px; letter-spacing: .04em; }
  .group-head .n { color: var(--text-faint); font-size: 11.5px; }
  .group-head .rule { flex: 1; border-top: 1px dashed var(--border-soft); transform: translateY(-4px); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
  .card {
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--border); border-left: 3px solid var(--stale);
    border-radius: 8px; padding: 12px 14px 13px;
    transition: border-color .3s ease, box-shadow .3s ease;
  }
  .card.live { border-left-color: var(--live); }
  .card.idle { border-left-color: var(--idle); }
  .card.flash { animation: flash 1.1s ease-out; }
  @keyframes flash {
    0% { box-shadow: 0 0 0 1px var(--accent), 0 0 22px rgba(85,184,255,.25); }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
  .card .row1 { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .badge {
    font-size: 10.5px; letter-spacing: .06em; padding: 2px 8px;
    border-radius: 4px; border: 1px solid var(--border);
    color: var(--text-dim); background: rgba(255,255,255,.02);
  }
  .badge.hue0 { color: #7fd4ff; border-color: #1d3a4d; }
  .badge.hue1 { color: #b9a7ff; border-color: #33305a; }
  .badge.hue2 { color: #7fe0b2; border-color: #1e4034; }
  .badge.hue3 { color: #ffb480; border-color: #4d331d; }
  .sid { color: var(--text-faint); font-size: 10.5px; }
  .row1 .spacer { flex: 1; }
  .ago { font-size: 11.5px; display: inline-flex; align-items: center; gap: 6px; }
  .ago .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--stale); }
  .card.live .ago { color: var(--live); } .card.live .ago .dot { background: var(--live); }
  .card.idle .ago { color: var(--idle); } .card.idle .ago .dot { background: var(--idle); }
  .card.stale .ago { color: var(--stale); }
  .doing {
    color: var(--text); font-size: 13px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; min-height: 2.6em;
  }
  .doing.none { color: var(--text-faint); font-style: italic; }
  .empty {
    max-width: 560px; margin: 12vh auto 0; text-align: left;
    border: 1px solid var(--border); border-radius: 10px;
    background: var(--panel); padding: 28px 32px;
  }
  .empty h2 { font-size: 15px; margin-bottom: 12px; letter-spacing: .08em; }
  .empty p { color: var(--text-dim); font-size: 13px; margin-bottom: 10px; }
  .empty code { color: var(--accent); background: rgba(85,184,255,.07); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .empty a { color: var(--accent); }
  footer { margin-top: 34px; color: var(--text-faint); font-size: 11px; }
  footer a { color: var(--text-dim); }
</style>
</head>
<body>
<header>
  <span class="brand">SESSION<span class="dim">/</span>DECK</span>
  <span class="tagline">mission control for parallel Claude Code sessions</span>
  <span class="spacer"></span>
  <span class="count"><span class="pulse" id="pulse"></span><b id="n-live">0</b>&nbsp;live&nbsp;<span id="n-total">/ 0 on board</span></span>
</header>
<main id="main"></main>
<footer>
  board: <span class="boardpath">${escapeHtml(tildify(boardPath))}</span> ·
  hook: <a href="https://github.com/dylanpulver/agent-ops" target="_blank" rel="noreferrer">agent-ops</a>
</footer>
<script>
  const $main = document.getElementById('main');
  let rows = [];
  let prev = new Map(); // sid -> JSON string, for change detection

  function freshness(age) {
    if (age == null || age < 0 || Number.isNaN(age)) return 'stale';
    if (age < 120) return 'live';
    if (age < 600) return 'idle';
    return 'stale';
  }
  function ageLabel(age) {
    if (age == null || Number.isNaN(age)) return 'unknown';
    const s = Math.max(0, Math.floor(age));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function hueClass(cfg) {
    let h = 0;
    for (const ch of String(cfg)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return 'hue' + (h % 4);
  }
  function ageOf(row, nowMs) {
    return row.seenMs == null ? null : (nowMs - row.seenMs) / 1000;
  }

  function render() {
    const nowMs = Date.now();
    if (rows.length === 0) {
      $main.innerHTML =
        '<div class="empty">' +
        '<h2>NO SESSIONS ON THE BOARD</h2>' +
        '<p>' + (window.__missing
          ? 'The board file does not exist yet.'
          : 'The board file exists but has no live rows.') + '</p>' +
        '<p>The board is a presence file every Claude Code session self-registers to ' +
        'via a <code>SessionStart</code> / <code>UserPromptSubmit</code> / <code>SessionEnd</code> hook — ' +
        'one JSONL row per live session, pruned automatically after 24h.</p>' +
        '<p>Install the hook from <a href="https://github.com/dylanpulver/agent-ops" target="_blank" rel="noreferrer">agent-ops</a> ' +
        '(pattern 01, <code>hooks/board-register.sh</code>), start a session, and it appears here.</p>' +
        '</div>';
      updateHeader(nowMs);
      return;
    }
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.repo)) groups.set(row.repo, []);
      groups.get(row.repo).push(row);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
      const min = (g) => Math.min(...g.map((r) => ageOf(r, nowMs) ?? Infinity));
      return min(a[1]) - min(b[1]);
    });
    let html = '';
    for (const [repo, members] of ordered) {
      members.sort((a, b) => (ageOf(a, nowMs) ?? Infinity) - (ageOf(b, nowMs) ?? Infinity));
      html += '<section class="group"><div class="group-head">' +
        '<span class="name">' + esc(repo) + '</span>' +
        '<span class="n">' + members.length + ' session' + (members.length === 1 ? '' : 's') + '</span>' +
        '<span class="rule"></span></div><div class="cards">';
      for (const row of members) {
        const age = ageOf(row, nowMs);
        const state = freshness(age);
        const key = JSON.stringify([row.cfg, row.cwd, row.seen, row.doing]);
        const changed = prev.size > 0 && prev.get(row.sid) !== key;
        html += '<article class="card ' + state + (changed ? ' flash' : '') + '" data-sid="' + esc(row.sid) + '">' +
          '<div class="row1">' +
          '<span class="badge ' + hueClass(row.cfg) + '">' + esc(row.cfg || '?') + '</span>' +
          '<span class="sid">' + esc(row.sid.slice(0, 8)) + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="ago"><span class="dot"></span><span class="t">' + esc(ageLabel(age)) + '</span></span>' +
          '</div>' +
          '<div class="doing' + (row.doing ? '' : ' none') + '">' + esc(row.doing || '(no intent yet)') + '</div>' +
          '</article>';
      }
      html += '</div></section>';
    }
    $main.innerHTML = html;
    prev = new Map(rows.map((r) => [r.sid, JSON.stringify([r.cfg, r.cwd, r.seen, r.doing])]));
    updateHeader(nowMs);
  }

  function updateHeader(nowMs) {
    const live = rows.filter((r) => freshness(ageOf(r, nowMs)) === 'live').length;
    document.getElementById('n-live').textContent = live;
    document.getElementById('n-total').textContent = '/ ' + rows.length + ' on board';
    document.getElementById('pulse').className = 'pulse' + (live > 0 ? '' : ' off');
    document.title = 'session-deck · ' + live + ' live';
  }

  // Per-second tick: refresh ages and freshness classes in place (no rerender,
  // so the flash animation isn't clobbered).
  setInterval(() => {
    const nowMs = Date.now();
    for (const row of rows) {
      const el = document.querySelector('.card[data-sid="' + CSS.escape(row.sid) + '"]');
      if (!el) continue;
      const age = ageOf(row, nowMs);
      const state = freshness(age);
      el.classList.remove('live', 'idle', 'stale');
      el.classList.add(state);
      const t = el.querySelector('.ago .t');
      if (t) t.textContent = ageLabel(age);
    }
    updateHeader(nowMs);
  }, 1000);

  const es = new EventSource('/events');
  es.addEventListener('board', (ev) => {
    const payload = JSON.parse(ev.data);
    window.__missing = payload.missing;
    // Server sends seen as text + parsed epoch ms; ages are computed client-side.
    rows = payload.rows;
    render();
  });
  es.onerror = () => { document.getElementById('pulse').className = 'pulse off'; };
</script>
</body>
</html>`;
}

/** Shorten the home dir to ~ for display. */
function tildify(p) {
  const home = os.homedir();
  return home && String(p).startsWith(home) ? '~' + String(p).slice(home.length) : String(p);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------------------------------------------------------------------------
// Server: static page + SSE stream of board updates
// ---------------------------------------------------------------------------

function boardPayload(boardPath) {
  const { text, missing } = readBoard(boardPath);
  const rows = parseBoard(text).map((row) => ({
    ...row,
    repo: repoName(row.cwd),
    seenMs: parseSeen(row.seen),
  }));
  return { missing, rows };
}

function serve(opts) {
  const boardPath = path.resolve(opts.board);
  const clients = new Set();

  const broadcast = () => {
    if (clients.size === 0) return;
    const data = `event: board\ndata: ${JSON.stringify(boardPayload(boardPath))}\n\n`;
    for (const res of clients) res.write(data);
  };

  // Watch by path (robust across atomic rename + missing file), plus a
  // directory watcher for snappier updates when the dir exists.
  fs.watchFile(boardPath, { interval: 1000 }, broadcast);
  try {
    let timer = null;
    fs.watch(path.dirname(boardPath), (_event, filename) => {
      if (filename && filename !== path.basename(boardPath)) return;
      clearTimeout(timer);
      timer = setTimeout(broadcast, 120);
    });
  } catch {
    /* directory may not exist yet; watchFile covers it */
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml(boardPath));
    } else if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: board\ndata: ${JSON.stringify(boardPayload(boardPath))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (url === '/api/board') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(boardPayload(boardPath)));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
    }
  });

  server.listen(opts.port, '127.0.0.1', () => {
    const { missing } = readBoard(boardPath);
    console.log(`session-deck ▸ http://localhost:${server.address().port}`);
    console.log(`board: ${tildify(boardPath)}`);
    if (missing) console.log(MISSING_BOARD_HINT(boardPath));
  });
  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const HELP = `session-deck — mission control for parallel Claude Code sessions

Usage:
  session-deck [options]

Options:
  --board <path>   board file (default: ~/.claude-sessions/board.jsonl)
  --port <n>       port to serve on (default: ${DEFAULT_PORT})
  --once           print the board as a table to stdout and exit
  -h, --help       show this help
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.once) {
    const boardPath = path.resolve(opts.board);
    const { text, missing } = readBoard(boardPath);
    if (missing) {
      process.stdout.write(MISSING_BOARD_HINT(boardPath));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(renderTable(parseBoard(text), Date.now(), process.stdout.isTTY));
    return;
  }
  serve(opts);
}

if (require.main === module) main();

module.exports = { parseBoard, parseSeen, freshness, ageLabel, repoName, decorate, parseArgs, renderTable, DEFAULT_BOARD, DEFAULT_PORT };
