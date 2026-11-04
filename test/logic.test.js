import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiresFor, groupSizes, assignRoles, makeScores, setupFor, cleanName } from '../server/game.js';

test('hiring limit scales as max(1, floor(E/5)) — spec examples', () => {
  assert.equal(hiresFor(9 - 3), 1);
  assert.equal(hiresFor(15 - 3), 2);
  assert.equal(hiresFor(18 - 3), 3);
  assert.equal(hiresFor(24 - 3), 4);
  assert.equal(hiresFor(3), 1); // 6 players: minimum of 1
  assert.equal(hiresFor(4), 1);
});

test('groups are as even as possible (14 employees -> 5, 5, 4)', () => {
  assert.deepEqual(groupSizes(14), [5, 5, 4]);
  assert.deepEqual(groupSizes(12), [4, 4, 4]);
  assert.deepEqual(groupSizes(13), [5, 4, 4]);
  assert.deepEqual(groupSizes(3), [1, 1, 1]);
});

test('setup needs at least 6 players', () => {
  assert.equal(setupFor(5).ready, false);
  assert.equal(setupFor(5).needed, 1);
  assert.equal(setupFor(6).ready, true);
});

test('role assignment for every attendance count from 6 to 60', () => {
  for (let n = 6; n <= 60; n++) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const { employers, employees, hires } = assignRoles(ids);
    const E = n - 3;
    assert.equal(employers.length, 3);
    assert.deepEqual(employers.map((e) => e.label).sort(), ['A', 'B', 'C']);
    assert.equal(employees.length, E);
    assert.equal(hires, Math.max(1, Math.floor(E / 5)));
    // every id used exactly once
    assert.equal(new Set([...employers, ...employees].map((x) => x.id)).size, n);
    // labels E1..En
    assert.deepEqual(employees.map((e) => e.label).sort(), Array.from({ length: E }, (_, i) => `E${i + 1}`).sort());
    // groups even
    const sizes = ['A', 'B', 'C'].map((g) => employees.filter((e) => e.group === g).length).sort((a, b) => b - a);
    assert.deepEqual(sizes, groupSizes(E));
    // each group large enough for the referral requirement
    assert.ok(sizes[2] >= hires, `group of ${sizes[2]} cannot give ${hires} referrals`);
    // each employer has enough hireable candidates in total
    assert.ok(E - sizes[0] >= hires);
    for (const e of employees) assert.ok(Number.isInteger(e.score) && e.score >= 1 && e.score <= 10);
  }
});

test('scores are spread across 1–10 and roughly balanced between groups', () => {
  for (let trial = 0; trial < 200; trial++) {
    const ids = Array.from({ length: 24 }, (_, i) => `p${i}`); // 21 employees, groups of 7
    const { employees } = assignRoles(ids);
    const sums = ['A', 'B', 'C'].map((g) => employees.filter((e) => e.group === g).reduce((s, e) => s + e.score, 0));
    assert.ok(Math.max(...sums) - Math.min(...sums) <= 8, `unbalanced group sums ${sums}`);
    const distinct = new Set(employees.map((e) => e.score));
    assert.ok(distinct.size >= 8, 'scores should span most of the range');
  }
  const s = makeScores(10);
  assert.equal(s.length, 10);
});

test('no predictable employee-ID-to-score or ID-to-group mapping', () => {
  const scoresForE1 = new Set();
  const groupsForE1 = new Set();
  const employerIds = new Set();
  for (let trial = 0; trial < 300; trial++) {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const { employees, employers } = assignRoles(ids);
    const e1 = employees.find((e) => e.label === 'E1');
    scoresForE1.add(e1.score);
    groupsForE1.add(e1.group);
    employerIds.add(employers.find((e) => e.label === 'A').id);
  }
  assert.ok(scoresForE1.size >= 6, `E1 scores too predictable: ${[...scoresForE1]}`);
  assert.equal(groupsForE1.size, 3);
  assert.ok(employerIds.size >= 8, 'employer selection should be random');
});

test('names are cleaned and length-limited', () => {
  assert.equal(cleanName('  Jordan   Lee '), 'Jordan Lee');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('x'.repeat(21)), null);
  assert.equal(cleanName('Ana\u0000‮'), 'Ana');
  assert.equal(cleanName(42), null);
});
