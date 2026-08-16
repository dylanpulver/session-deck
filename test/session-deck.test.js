'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBoard,
  parseSeen,
  freshness,
  ageLabel,
  repoName,
  decorate,
  parseArgs,
  renderTable,
  DEFAULT_BOARD,
  DEFAULT_PORT,
} = require('../bin/session-deck.js');

const ROW = (over = {}) =>
  JSON.stringify({
    sid: 'aaaa1111-2222-3333-4444-555566667777',
    cwd: '/home/dev/atlas-api',
    cfg: '.claude',
    seen: '2026-08-16 12:00',
    doing: 'sweeping flaky tests',
    ...over,
  });

test('parseBoard: parses valid JSONL rows', () => {
  const rows = parseBoard(ROW() + '\n' + ROW({ sid: 'bbbb', cwd: '/home/dev/docs-site' }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sid, 'aaaa1111-2222-3333-4444-555566667777');
  assert.equal(rows[1].cwd, '/home/dev/docs-site');
  assert.equal(rows[0].doing, 'sweeping flaky tests');
});

test('parseBoard: skips malformed lines and keeps the good ones', () => {
  const text = [
    ROW(),
    '{"sid":"torn-write","cwd":"/x"', // truncated JSON — torn concurrent write
    'not json at all',
    '',
    '   ',
    ROW({ sid: 'cccc' }),
  ].join('\n');
  const rows = parseBoard(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.sid).sort(), ['aaaa1111-2222-3333-4444-555566667777', 'cccc']);
});

test('parseBoard: skips rows without a usable sid; tolerates non-object lines', () => {
  const text = ['{"cwd":"/x"}', '{"sid":""}', '{"sid":42}', '[1,2]', 'null', '"str"', ROW()].join('\n');
  assert.equal(parseBoard(text).length, 1);
});

test('parseBoard: normalizes missing optional fields to empty strings', () => {
  const rows = parseBoard('{"sid":"only-sid"}');
  assert.deepEqual(rows[0], { sid: 'only-sid', cwd: '', cfg: '', seen: '', doing: '' });
});

test('parseBoard: empty / nullish input gives empty board', () => {
  assert.deepEqual(parseBoard(''), []);
  assert.deepEqual(parseBoard(null), []);
  assert.deepEqual(parseBoard(undefined), []);
});

test('parseSeen: parses the board timestamp format as local time', () => {
  const ms = parseSeen('2026-08-16 12:34');
  assert.equal(ms, new Date(2026, 7, 16, 12, 34).getTime());
});

test('parseSeen: rejects garbage', () => {
  assert.equal(parseSeen(''), null);
  assert.equal(parseSeen('yesterday'), null);
  assert.equal(parseSeen('2026-08-16'), null);
  assert.equal(parseSeen('2026-99-99 99:99'), null);
  assert.equal(parseSeen(undefined), null);
});

test('freshness: green under 2 minutes', () => {
  assert.equal(freshness(0), 'live');
  assert.equal(freshness(60), 'live');
  assert.equal(freshness(119), 'live');
});

test('freshness: amber from 2 to 10 minutes', () => {
  assert.equal(freshness(120), 'idle');
  assert.equal(freshness(300), 'idle');
  assert.equal(freshness(599), 'idle');
});

test('freshness: gray at 10 minutes and beyond, and for unknown ages', () => {
  assert.equal(freshness(600), 'stale');
  assert.equal(freshness(86400), 'stale');
  assert.equal(freshness(null), 'stale');
  assert.equal(freshness(NaN), 'stale');
  assert.equal(freshness(-5), 'stale');
});

test('ageLabel: humanizes seconds', () => {
  assert.equal(ageLabel(4), '4s ago');
  assert.equal(ageLabel(59), '59s ago');
  assert.equal(ageLabel(60), '1m ago');
  assert.equal(ageLabel(3599), '59m ago');
  assert.equal(ageLabel(7200), '2h ago');
  assert.equal(ageLabel(200000), '2d ago');
  assert.equal(ageLabel(null), 'unknown');
});

test('repoName: basename of cwd, trailing slashes and empties handled', () => {
  assert.equal(repoName('/home/dev/atlas-api'), 'atlas-api');
  assert.equal(repoName('/home/dev/atlas-api/'), 'atlas-api');
  assert.equal(repoName(''), '(unknown)');
  assert.equal(repoName(undefined), '(unknown)');
});

test('decorate: computes age + state and sorts freshest first', () => {
  const now = new Date(2026, 7, 16, 12, 10).getTime();
  const rows = parseBoard(
    [
      ROW({ sid: 'old', seen: '2026-08-16 11:00' }),
      ROW({ sid: 'fresh', seen: '2026-08-16 12:09' }),
      ROW({ sid: 'warm', seen: '2026-08-16 12:05' }),
      ROW({ sid: 'unknown-seen', seen: 'garbage' }),
    ].join('\n')
  );
  const d = decorate(rows, now);
  assert.deepEqual(d.map((r) => r.sid), ['fresh', 'warm', 'old', 'unknown-seen']);
  assert.equal(d[0].state, 'live');
  assert.equal(d[1].state, 'idle');
  assert.equal(d[2].state, 'stale');
  assert.equal(d[3].state, 'stale');
  assert.equal(d[3].age, null);
});

test('parseArgs: defaults and overrides', () => {
  const def = parseArgs([]);
  assert.equal(def.board, DEFAULT_BOARD);
  assert.equal(def.port, DEFAULT_PORT);
  assert.equal(def.once, false);

  const set = parseArgs(['--board', '/tmp/b.jsonl', '--port', '5000', '--once']);
  assert.equal(set.board, '/tmp/b.jsonl');
  assert.equal(set.port, 5000);
  assert.equal(set.once, true);

  assert.equal(parseArgs(['--port', 'nope']).port, DEFAULT_PORT);
});

test('renderTable: renders rows and an empty-board message', () => {
  const now = new Date(2026, 7, 16, 12, 10).getTime();
  const rows = parseBoard(ROW({ seen: '2026-08-16 12:09' }));
  const out = renderTable(rows, now, false);
  assert.match(out, /atlas-api/);
  assert.match(out, /sweeping flaky tests/);
  assert.match(out, /1m ago/);
  assert.match(out, /1 session · 1 live/);
  assert.match(renderTable([], now, false), /board is empty/);
});
