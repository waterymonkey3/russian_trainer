// 运行： node tools/logic.test.mjs
import assert from 'node:assert/strict';
import {
  MASTER_BASE, PER_PAGE, applyReciteResult, autoQueue, daysBetween, generateSlot,
  isMatch, markGroupAppeared, needFor, newEntry, normalize, remainingNeed, todayISO,
} from '../web/logic.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + name + '\n       ' + err.message);
  }
}

console.log('输入比对（宽松规则）');
test('忽略大小写、首尾空格与重音符号', () => {
  assert.equal(normalize('  Хорошо́!  '), 'хорошо');
  assert.ok(isMatch('Привет', 'привет'));
  assert.ok(isMatch('хорошо', 'хорошо́'));
});
test('ё 与 е 等价', () => {
  assert.ok(isMatch('еще', 'ещё'));
  assert.ok(isMatch('ЕЖ', 'ёж'));
});
test('忽略标点但不忽略连字符', () => {
  assert.ok(isMatch('что-то', 'что-то,'));
  assert.ok(!isMatch('чтото', 'что-то'));
});
test('空输入永远不算对', () => {
  assert.ok(!isMatch('', 'я'));
  assert.ok(!isMatch('   ', 'я'));
});

console.log('掌握状态机');
test('连续正确 3 次进入已掌握，并清零错误次数', () => {
  const entry = newEntry();
  assert.equal(needFor(entry), MASTER_BASE);
  assert.equal(applyReciteResult(entry, true, '2026-09-01'), 'correct');
  assert.equal(applyReciteResult(entry, true, '2026-09-02'), 'correct');
  assert.equal(applyReciteResult(entry, true, '2026-09-03'), 'mastered');
  assert.equal(entry.mastered, true);
  assert.equal(entry.errors, 0);
  assert.equal(entry.masteredAt, '2026-09-03');
  assert.equal(entry.lastCorrectAt, '2026-09-03');
});
test('错一次：正确次数清零、门槛 +1', () => {
  const entry = newEntry();
  applyReciteResult(entry, true, '2026-09-01');
  applyReciteResult(entry, true, '2026-09-01');
  assert.equal(applyReciteResult(entry, false, '2026-09-02'), 'wrong');
  assert.equal(entry.correct, 0);
  assert.equal(entry.errors, 1);
  assert.equal(needFor(entry), 4);
  assert.equal(remainingNeed(entry), 4);
  for (let i = 0; i < 3; i += 1) assert.equal(applyReciteResult(entry, true, '2026-09-03'), 'correct');
  assert.equal(applyReciteResult(entry, true, '2026-09-03'), 'mastered');
});
test('复习写对一次：保持已掌握、天数重新计时', () => {
  const entry = newEntry();
  entry.mastered = true;
  entry.queued = true;
  entry.queueReason = 'auto';
  entry.lastCorrectAt = '2026-08-01';
  assert.equal(applyReciteResult(entry, true, '2026-09-16'), 'review-pass');
  assert.equal(entry.mastered, true);
  assert.equal(entry.queued, false);
  assert.equal(entry.lastCorrectAt, '2026-09-16');
});
test('复习写错：移出已掌握、错误次数 +1、正确次数清零', () => {
  const entry = newEntry();
  entry.mastered = true;
  entry.queued = true;
  entry.masteredAt = '2026-08-01';
  assert.equal(applyReciteResult(entry, false, '2026-09-16'), 'demoted');
  assert.equal(entry.mastered, false);
  assert.equal(entry.queued, false);
  assert.equal(entry.errors, 1);
  assert.equal(entry.correct, 0);
  assert.equal(needFor(entry), 4);
});

console.log('自动纳入复习');
test('超过阈值天数才纳入，关闭开关则不纳入', () => {
  const old = newEntry();
  old.mastered = true;
  old.lastCorrectAt = '2026-08-16';
  const recent = newEntry();
  recent.mastered = true;
  recent.lastCorrectAt = '2026-09-10';
  const settings = { autoReviewEnabled: true, autoReviewDays: 30 };
  assert.equal(daysBetween('2026-08-16', '2026-09-16'), 31);
  assert.equal(autoQueue([old, recent], settings, '2026-09-16'), 1);
  assert.equal(old.queued, true);
  assert.equal(old.queueReason, 'auto');
  assert.equal(recent.queued, false);
  assert.equal(autoQueue([old], { autoReviewEnabled: false }, '2026-09-16'), 0);
});
test('todayISO 输出本地日期', () => {
  assert.equal(todayISO(new Date(2026, 8, 16)), '2026-09-16');
});

console.log('默写页排期（递增间隔复习）');

function makeRecite() {
  return { groups: [], plan: [], pageSubmitted: {}, cursor: 1, nextSlot: 1, nextGroupId: 0 };
}

// 模拟：所有词都还没掌握，看看每组什么时候重逢
function simulateSlots(count, totalWords = 200) {
  const words = Array.from({ length: totalWords }, (_, i) => 'w' + i);
  const active = new Set(words);
  const used = new Set();
  const recite = makeRecite();
  const appearances = new Map();
  const isActive = (word) => active.has(word);
  const newWords = () => words.filter((word) => !used.has(word));
  for (let i = 0; i < count; i += 1) {
    const created = generateSlot(recite, isActive, newWords());
    if (!created) break;
    const group = recite.groups.find((item) => item.id === created.groupId);
    for (const word of group.words) used.add(word);
    appearances.set(group.id, [...(appearances.get(group.id) || []), created.slot]);
    markGroupAppeared(recite, group.id, created.slot);
  }
  return { recite, appearances, words, active };
}

test('同一组在 2、4、8、16… 页后重逢', () => {
  const { appearances } = simulateSlots(32);
  assert.deepEqual(appearances.get(0), [1, 3, 7, 15, 31]);
});
test('新词持续引入，每页固定 10 词', () => {
  const { recite } = simulateSlots(32);
  assert.ok(recite.groups.length >= 6, '应该不断有新组进来');
  for (const group of recite.groups) assert.equal(group.words.length, PER_PAGE);
  assert.equal(recite.plan.length, 32);
  assert.deepEqual(recite.plan.map((p) => p.slot), Array.from({ length: 32 }, (_, i) => i + 1));
});
test('同一页不会混两组词', () => {
  const { recite } = simulateSlots(32);
  const seen = new Map();
  for (const page of recite.plan) {
    assert.equal(seen.has(page.slot), false);
    seen.set(page.slot, page.groupId);
  }
  assert.equal(new Set(recite.plan.map((p) => p.groupId)).size, recite.groups.length);
});
test('组内单词全部掌握后不再出现', () => {
  const { recite, appearances, words, active } = simulateSlots(8);
  // 把第 1 组（w0..w9）全部标记为已掌握
  for (const word of recite.groups[0].words) active.delete(word);
  const before = appearances.get(0).length;
  for (let i = 0; i < 40; i += 1) {
    const created = generateSlot(recite, (w) => active.has(w), words.filter((w) => !w.startsWith('w0')));
    if (!created) break;
    assert.notEqual(created.groupId, 0, '已掌握的组不应再被排期');
  }
  assert.equal(recite.groups[0].done, true);
  assert.equal(appearances.get(0).length, before);
});
test('没有到期组也没有新词时返回 null', () => {
  const recite = makeRecite();
  assert.equal(generateSlot(recite, () => false, []), null);
  assert.equal(recite.plan.length, 0);
});
test('同时到期的多组顺延到后面的页，而不是挤在一页', () => {
  const recite = makeRecite();
  const isActive = () => true;
  const words = Array.from({ length: 60 }, (_, i) => 'w' + i);
  for (let i = 0; i < 3; i += 1) {
    recite.groups.push({
      id: recite.nextGroupId++,
      words: words.slice(i * PER_PAGE, (i + 1) * PER_PAGE),
      nextDueSlot: 1,
      stage: -1,
      done: false,
    });
  }
  const first = generateSlot(recite, isActive, []);
  assert.deepEqual([first.slot, first.groupId], [1, 0]);
  assert.equal(recite.groups[1].nextDueSlot, 2);
  assert.equal(recite.groups[2].nextDueSlot, 2);
  markGroupAppeared(recite, first.groupId, first.slot);   // 该页做完 -> 自己的下一次出现被推后
  const second = generateSlot(recite, isActive, []);
  assert.equal(second.slot, 2);
  assert.notEqual(second.groupId, first.groupId);
  for (const page of recite.plan) {
    const group = recite.groups.find((g) => g.id === page.groupId);
    assert.equal(group.words.length, PER_PAGE);
  }
});
