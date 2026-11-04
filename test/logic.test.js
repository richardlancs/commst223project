import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles, makeScores, setupFor, cleanName, employerLabel, candidateNames, BANK_PER_PLAYER, HIRES, MIN_PLAYERS } from '../server/game.js';

test('employer labels run A…Z, then AA, AB…', () => {
  assert.equal(employerLabel(0), 'A');
  assert.equal(employerLabel(25), 'Z');
  assert.equal(employerLabel(26), 'AA');
  assert.equal(employerLabel(27), 'AB');
  assert.equal(employerLabel(51), 'AZ');
  assert.equal(employerLabel(52), 'BA');
  assert.equal(employerLabel(701), 'ZZ');
  assert.equal(employerLabel(702), 'AAA');
});

test('setup: every player is an employer; bank is 4 per player; 2 hires each', () => {
  assert.equal(MIN_PLAYERS, 3);
  assert.deepEqual(setupFor(2), { players: 2, ready: false, needed: 1 });
  assert.deepEqual(setupFor(10), { players: 10, ready: true, employers: 10, bank: 40, groupSize: 4, hires: 2 });
});

test('role assignment for every attendance count from 3 to 80', () => {
  for (let n = 3; n <= 80; n++) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const { employers, candidates, hires } = assignRoles(ids);
    assert.equal(hires, HIRES);
    assert.equal(employers.length, n);
    assert.equal(new Set(employers.map((e) => e.id)).size, n);
    assert.equal(new Set(employers.map((e) => e.label)).size, n);
    assert.equal(candidates.length, n * BANK_PER_PLAYER);
    assert.deepEqual(candidates.map((c) => c.label).sort(), Array.from({ length: n * 4 }, (_, i) => `E${i + 1}`).sort());
    assert.equal(new Set(candidates.map((c) => c.name)).size, candidates.length, 'candidate names are unique');
    for (const e of employers) assert.equal(candidates.filter((c) => c.group === e.label).length, BANK_PER_PLAYER);
    for (const c of candidates) assert.ok(Number.isInteger(c.score) && c.score >= 1 && c.score <= 10);
    // every employer has enough hireable candidates outside their own group
    assert.ok(candidates.length - BANK_PER_PLAYER >= HIRES);
  }
});

test('scores are spread across 1–10 and roughly balanced between groups', () => {
  for (let trial = 0; trial < 200; trial++) {
    const { employers, candidates } = assignRoles(Array.from({ length: 8 }, (_, i) => `p${i}`));
    const sums = employers.map((e) => candidates.filter((c) => c.group === e.label).reduce((s, c) => s + c.score, 0));
    assert.ok(Math.max(...sums) - Math.min(...sums) <= 8, `unbalanced group sums ${sums}`);
    assert.ok(new Set(candidates.map((c) => c.score)).size >= 8, 'scores should span most of the range');
  }
  assert.equal(makeScores(10).length, 10);
});

test('no predictable mapping from candidate ID to score or group, or from join order to label', () => {
  const scoresForE1 = new Set();
  const groupsForE1 = new Set();
  const firstJoinerLabels = new Set();
  for (let trial = 0; trial < 300; trial++) {
    const { employers, candidates } = assignRoles(['p0', 'p1', 'p2', 'p3']);
    const e1 = candidates.find((c) => c.label === 'E1');
    scoresForE1.add(e1.score);
    groupsForE1.add(e1.group);
    firstJoinerLabels.add(employers.find((e) => e.id === 'p0').label);
  }
  assert.ok(scoresForE1.size >= 6, `E1 scores too predictable: ${[...scoresForE1]}`);
  assert.equal(groupsForE1.size, 4);
  assert.equal(firstJoinerLabels.size, 4);
});

test('candidate names and player names', () => {
  assert.equal(new Set(candidateNames(320)).size, 320);
  assert.equal(cleanName('  Jordan   Lee '), 'Jordan Lee');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('x'.repeat(21)), null);
  assert.equal(cleanName('Ana\u0000‮'), 'Ana');
  assert.equal(cleanName(42), null);
});
