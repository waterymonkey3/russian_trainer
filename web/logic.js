// 纯逻辑：输入比对 + 掌握状态机 + 默写页排期。
// 同时被浏览器（import）与 Node 测试（tools/logic.test.mjs）使用，不依赖 DOM。

export const PER_PAGE = 10;        // 抄写 / 默写每页词数
export const LIST_PAGE = 20;       // 词汇书 / 已掌握 / 错题本每页条数
export const MASTER_BASE = 3;      // 进入「已掌握」所需的基础正确次数
export const RECITE_GAP_BASE = 2;  // 默写复习间隔底数：同一组在 2、4、8、16… 页后重逢

export function todayISO(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseISO(text) {
  const [year, month, day] = String(text).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function daysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return 0;
  return Math.round((parseISO(toISO) - parseISO(fromISO)) / 86400000);
}

// 宽松比对：忽略大小写、空白、重音符号、常见标点与引号，ё ≡ е；连字符保留（必须输入）。
export function normalize(input) {
  if (input == null) return '';
  let text = String(input).normalize('NFC');
  text = text.replace(/\p{M}/gu, '');
  text = text.replace(/["'«»„“”‘’`]/g, '');
  text = text.replace(/[.,!?;:()[\]{}…—–]/g, '');
  text = text.replace(/ё/g, 'е');
  text = text.replace(/\s+/g, ' ').trim();
  return text.toLowerCase();
}

export function isMatch(input, target) {
  const value = normalize(input);
  return value.length > 0 && value === normalize(target);
}

export function newEntry() {
  return {
    correct: 0,
    errors: 0,
    mastered: false,
    masteredAt: null,
    lastCorrectAt: null,
    queued: false,
    queueReason: null,
    firstErrorAt: null,
    lastErrorAt: null,
  };
}

// 进入「已掌握」需要的连续正确次数：3 + 累计错误次数（掌握时错误次数清零）
export function needFor(entry) {
  return MASTER_BASE + (entry?.errors || 0);
}

export function remainingNeed(entry) {
  return Math.max(0, needFor(entry) - (entry?.correct || 0));
}

// 默写结果落库；返回 'correct' | 'mastered' | 'review-pass' | 'wrong' | 'demoted'
export function applyReciteResult(entry, isCorrect, today) {
  if (isCorrect) {
    if (entry.mastered) {
      entry.queued = false;
      entry.queueReason = null;
      entry.lastCorrectAt = today;
      return 'review-pass';
    }
    entry.correct = (entry.correct || 0) + 1;
    entry.lastCorrectAt = today;
    if (entry.correct >= needFor(entry)) {
      entry.mastered = true;
      entry.masteredAt = today;
      entry.correct = 0;
      entry.errors = 0;
      entry.queued = false;
      entry.queueReason = null;
      return 'mastered';
    }
    return 'correct';
  }
  const wasMastered = !!entry.mastered;
  entry.errors = (entry.errors || 0) + 1;
  entry.correct = 0;
  entry.firstErrorAt = entry.firstErrorAt || today;
  entry.lastErrorAt = today;
  if (wasMastered) {
    entry.mastered = false;
    entry.masteredAt = null;
    entry.queued = false;
    entry.queueReason = null;
    return 'demoted';
  }
  return 'wrong';
}

// 到期自动纳入复习：已掌握、未在队列、且距上次正确默写 ≥ 设定天数
export function autoQueue(entries, settings, today) {
  if (!settings || settings.autoReviewEnabled === false) return 0;
  const threshold = Number(settings.autoReviewDays) || 30;
  let queued = 0;
  for (const entry of entries) {
    if (!entry || !entry.mastered || entry.queued || !entry.lastCorrectAt) continue;
    if (daysBetween(entry.lastCorrectAt, today) >= threshold) {
      entry.queued = true;
      entry.queueReason = 'auto';
      queued += 1;
    }
  }
  return queued;
}

// 生成下一页的排期：优先让到期的旧组重逢，否则引入一组新词。
// isActive(word) 用来判断该词是否仍需要练（未掌握且不在复习队列）。
export function generateSlot(recite, isActive, newWords, perPage = PER_PAGE) {
  const slot = recite.nextSlot;
  for (const group of recite.groups) {
    if (!group.done && !group.words.some(isActive)) group.done = true;
  }
  const due = recite.groups.filter(
    (group) => !group.done && group.nextDueSlot <= slot && group.words.some(isActive),
  );
  let group;
  if (due.length) {
    group = due[0];
    for (const pushed of due.slice(1)) pushed.nextDueSlot = slot + 1;  // 保证一页 10 词
  } else {
    const fresh = (newWords || []).filter(isActive);
    if (!fresh.length) return null;
    group = {
      id: recite.nextGroupId,
      words: fresh.slice(0, perPage),
      nextDueSlot: slot,
      stage: -1,
      done: false,
    };
    recite.nextGroupId += 1;
    recite.groups.push(group);
  }
  recite.plan.push({ slot, groupId: group.id });
  recite.nextSlot = slot + 1;
  return { slot, groupId: group.id };
}

// 这一页做完后，该组下一次出现推到 +2、+4、+8、+16… 页
export function markGroupAppeared(recite, groupId, slot) {
  const group = recite.groups.find((item) => item.id === groupId);
  if (!group) return;
  group.stage = (group.stage ?? -1) + 1;
  group.nextDueSlot = slot + RECITE_GAP_BASE ** (group.stage + 1);
}
