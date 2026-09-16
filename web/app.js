// 俄语学习系统前端。数据来自本地服务：/api/vocab（3200 词）+ /api/progress（学习进度）。
import {
  LIST_PAGE, MASTER_BASE, PER_PAGE, applyReciteResult, autoQueue, daysBetween, generateSlot,
  isMatch, markGroupAppeared, needFor, newEntry, todayISO,
} from './logic.js';

// 真实俄文键盘（ЙЦУКЕН）的三排字母布局：ё 在最左上（Tab 上方那颗键），
// 第三排末位放连字符（真实键盘对应 . 键），因为 что-то 这类词必须打连字符。
const KEYBOARD_ROWS = [
  ['ё', 'й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
  ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
  ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', '-'],
];

const POS_ZH = {
  noun: '名词', verb: '动词', adj: '形容词', adv: '副词', pron: '代词', prep: '前置词', conj: '连词',
  intj: '感叹词', num: '数词', det: '限定词', particle: '语气词', phrase: '短语',
};

const S = {
  words: [],
  byWord: new Map(),
  byIdx: new Map(),
  progress: null,
  view: 'vocab',
  audio: null,
  session: {
    vocabPage: 1, vocabQuery: '', vocabFocus: false,
    masteredQuery: '', masteredSort: 'days', masteredFocus: false,
    wrongQuery: '', wrongSort: 'errors', wrongFocus: false,
    keepVisible: {}, reviewSnap: null, lastInput: null, saveTimer: null, saving: false,
  },
};

const EMPTY_ENTRY = Object.freeze(newEntry());

const VIEWS = ['vocab', 'copy', 'recite', 'mastered', 'wrong'];

function viewFromHash() {
  const name = (window.location.hash || '').replace(/^#/, '');
  return VIEWS.includes(name) ? name : 'vocab';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || min, min), max);
}

function info(word) {
  return S.byWord.get(word);
}

function peek(word) {
  return S.progress.words[word] || EMPTY_ENTRY;
}

function entryOf(word) {
  const map = S.progress.words;
  if (!map[word]) map[word] = newEntry();
  return map[word];
}

function isActive(word) {
  const entry = peek(word);
  return !entry.mastered && !entry.queued;
}

function learningPool() {
  return S.words.map((item) => item.word).filter(isActive);
}

function reviewPool() {
  return S.words.map((item) => item.word).filter((word) => peek(word).queued);
}

function newWordsForGroups() {
  const used = new Set();
  for (const group of S.progress.recite.groups) for (const word of group.words) used.add(word);
  return S.words.map((item) => item.word).filter((word) => !used.has(word));
}

function playWord(word) {
  const item = info(word);
  if (!item || !S.audio) return;
  try {
    S.audio.pause();
    S.audio.currentTime = 0;
    S.audio.src = item.audio;
    const promise = S.audio.play();
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch (_) {
    /* 播放失败不影响输入 */
  }
}

function notice(text) {
  const box = document.getElementById('notice');
  box.textContent = text;
  box.classList.remove('hidden');
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => box.classList.add('hidden'), 3600);
}

function save() {
  if (S.session.saveTimer) return;
  S.session.saveTimer = setTimeout(() => {
    S.session.saveTimer = null;
    flush();
  }, 400);
}

async function flush() {
  if (!S.progress || S.session.saving) {
    if (S.progress) save();
    return;
  }
  S.session.saving = true;
  try {
    await fetch('/api/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(S.progress),
    });
  } catch (err) {
    notice('进度保存失败：' + err.message);
  } finally {
    S.session.saving = false;
  }
}

// ------------------------------------------------------------------ 启动

async function boot() {
  S.audio = new Audio();
  S.audio.preload = 'none';
  const [vocabRes, progressRes] = await Promise.all([fetch('/api/vocab'), fetch('/api/progress')]);
  if (!vocabRes.ok || !progressRes.ok) throw new Error('接口请求失败');
  const vocab = await vocabRes.json();
  const progress = await progressRes.json();
  S.progress = progress;
  progress.settings = Object.assign(
    { autoReviewDays: 30, autoReviewEnabled: true, virtualKeyboard: true, showExamples: true },
    progress.settings || {},
  );
  progress.ui = Object.assign(
    { copyPage: 1, copyTab: 'learn', reciteTab: 'learn', copyReviewPage: 1, reciteReviewPage: 1, masteredPage: 1, wrongPage: 1 },
    progress.ui || {},
  );
  progress.recite = Object.assign(
    { groups: [], plan: [], pageSubmitted: {}, cursor: 1, nextSlot: 1, nextGroupId: 0 },
    progress.recite || {},
  );
  for (const item of vocab.words) {
    S.words.push(item);
    S.byWord.set(item.word, item);
    S.byIdx.set(item.idx, item);
  }
  buildKeyboard();
  bindGlobal();
  S.view = viewFromHash();
  const queued = autoQueue(Object.values(progress.words), progress.settings, todayISO());
  ensureRecitePlan();
  render();
  if (queued) {
    notice(`已自动把 ${queued} 个超过 ${progress.settings.autoReviewDays} 天没复习的词加入复习队列`);
  }
  window.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
  });
}

function ensureRecitePlan() {
  const recite = S.progress.recite;
  for (const group of recite.groups) {
    if (!group.done && !group.words.some(isActive)) group.done = true;
  }
  if (!recite.plan.length) {
    const created = generateSlot(recite, isActive, newWordsForGroups());
    if (created) recite.cursor = created.slot;
  }
  recite.cursor = clamp(recite.cursor, 1, Math.max(1, recite.plan.length));
}

function render() {
  S.session.reviewSnap = null;   // 每次切换视图都重算复习队列，避免显示已经通过的词
  document.querySelectorAll('#mainNav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === S.view);
  });
  renderStats();
  const root = document.getElementById('app');
  if (S.view === 'vocab') renderVocab(root);
  else if (S.view === 'copy') renderCopy(root);
  else if (S.view === 'recite') renderRecite(root);
  else if (S.view === 'mastered') renderMastered(root);
  else renderWrong(root);
  updateKeyboard();
}

function renderStats() {
  let mastered = 0;
  let wrong = 0;
  let queued = 0;
  for (const item of S.words) {
    const entry = S.progress.words[item.word];
    if (!entry) continue;
    if (entry.mastered) mastered += 1;
    if (entry.queued) queued += 1;
    if (!entry.mastered && entry.errors > 0) wrong += 1;
  }
  document.getElementById('stats').innerHTML =
    `学习池 <b>${S.words.length - mastered - queued}</b> · 已掌握 <b>${mastered}</b> · 复习队列 <b>${queued}</b>` +
    ` · 错题 <b>${wrong}</b> · 总计 <b>${S.words.length}</b>`;
}

// ------------------------------------------------------------------ 通用零件

function pagerHTML(page, total, unit = '页') {
  return `<div class="pager">
    <button class="btn" data-jump="1" ${page <= 1 ? 'disabled' : ''}>« 首页</button>
    <button class="btn" data-jump="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
    <span class="pager-info">第 <input class="page-input" type="number" min="1" max="${total}" value="${page}"> / ${total} ${unit}</span>
    <button class="btn" data-jump="${page + 1}" ${page >= total ? 'disabled' : ''}>下一页 ›</button>
    <button class="btn" data-jump="${total}" ${page >= total ? 'disabled' : ''}>末页 »</button>
  </div>`;
}

function bindPager(scope, total, onGo) {
  scope.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => onGo(clamp(btn.dataset.jump, 1, total)));
  });
  const input = scope.querySelector('.page-input');
  if (!input) return;
  const commit = () => onGo(clamp(input.value, 1, total));
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commit();
    }
  });
}

function statusChips(entry) {
  if (!entry) return '';
  const chips = [];
  if (entry.mastered) chips.push('<span class="chip ok">已掌握</span>');
  if (entry.queued) {
    chips.push(`<span class="chip warn">复习中${entry.queueReason === 'auto' ? '·自动' : ''}</span>`);
  }
  if (!entry.mastered && entry.errors > 0) chips.push(`<span class="chip bad">错题 ${entry.errors}</span>`);
  if (!entry.mastered && entry.correct > 0) {
    chips.push(`<span class="chip">连对 ${entry.correct}/${needFor(entry)}</span>`);
  }
  return chips.join('');
}

function speakButton(idx) {
  return `<button class="link speak" data-idx="${idx}" title="播放读音">🔊</button>`;
}

function exampleButton(item) {
  if (!item.example_ru || !S.progress.settings.showExamples) return '';
  return `<button class="link ex-toggle" data-idx="${item.idx}">例句</button>`;
}

function exampleBox(item) {
  if (!item.example_ru || !S.progress.settings.showExamples) return '';
  return `<div class="example hidden">${esc(item.example_ru)}${item.example_zh ? ' ｜ ' + esc(item.example_zh) : ''}</div>`;
}

function matchQuery(item, query) {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  return [item.word, item.stress, item.zh, item.en, item.pos].some(
    (field) => String(field).toLowerCase().includes(text),
  );
}

// ------------------------------------------------------------------ 词汇书

function vocabRow(item) {
  return `<tr data-idx="${item.idx}">
    <td class="col-idx muted">${item.idx}</td>
    <td class="ru">${speakButton(item.idx)}<span class="word">${esc(item.stress)}</span></td>
    <td class="muted">${esc(POS_ZH[item.pos] || item.pos)}</td>
    <td>${esc(item.zh)}</td>
    <td class="muted">${esc(item.en)}</td>
    <td>${statusChips(S.progress.words[item.word])}</td>
    <td class="col-ex">${item.example_ru ? exampleButton(item) + exampleBox(item) : '<span class="muted">—</span>'}</td>
  </tr>`;
}

function renderVocab(root) {
  const query = S.session.vocabQuery;
  const list = S.words.filter((item) => matchQuery(item, query));
  const total = Math.max(1, Math.ceil(list.length / LIST_PAGE));
  const page = clamp(S.session.vocabPage, 1, total);
  S.session.vocabPage = page;
  const rows = list.slice((page - 1) * LIST_PAGE, page * LIST_PAGE);
  root.innerHTML = `<section class="panel">
    <div class="panel-head">
      <h2>词汇书</h2>
      <input id="vocabSearch" class="search" type="search" placeholder="搜索俄文 / 中文 / 英文 / 词性…" value="${esc(query)}">
      <span class="muted">命中 ${list.length} / ${S.words.length} 词</span>
    </div>
    ${pagerHTML(page, total)}
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th class="col-idx">#</th><th>俄文（带重音）</th><th>词性</th><th>中文</th><th>英文</th><th>状态</th><th>例句</th>
        </tr></thead>
        <tbody>${rows.map(vocabRow).join('')}</tbody>
      </table>
    </div>
    ${pagerHTML(page, total)}
  </section>`;
  bindPager(root, total, (next) => {
    S.session.vocabPage = next;
    render();
  });
  const search = root.querySelector('#vocabSearch');
  search.addEventListener('input', () => {
    S.session.vocabQuery = search.value;
    S.session.vocabPage = 1;
    S.session.vocabFocus = true;
    render();
  });
  if (S.session.vocabFocus) {
    S.session.vocabFocus = false;
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

// ------------------------------------------------------------------ 输入框行为

function setVerdict(row, ok, text) {
  const box = row.querySelector('.verdict');
  if (!box) return;
  box.textContent = text || '';
  box.classList.toggle('ok', ok === true);
  box.classList.toggle('bad', ok === false);
}

function refreshChips(row, entry) {
  const head = row.querySelector('.row-head');
  if (!head) return;
  head.querySelectorAll('.chip').forEach((chip) => chip.remove());
  head.insertAdjacentHTML('beforeend', statusChips(entry));
}

function bindWordInputs(scope, onCheck) {
  scope.querySelectorAll('.word-input').forEach((input) => {
    const row = input.closest('.row');
    const item = S.byIdx.get(Number(row.dataset.idx));
    input.addEventListener('focus', () => {
      S.session.lastInput = input;
      playWord(item.word);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      const value = input.value.trim();
      if (!value) {
        setVerdict(row, null, '');
        return;
      }
      playWord(item.word);
      onCheck(row, item, input, value);
    });
  });
}

// ------------------------------------------------------------------ 抄写

function copyRow(word, index) {
  const item = info(word);
  return `<li class="row" data-idx="${item.idx}">
    <div class="row-head">
      <span class="idx">${index}</span>
      <span class="word">${esc(item.stress)}</span>
      ${speakButton(item.idx)}
      ${statusChips(S.progress.words[word])}
      ${exampleButton(item)}
    </div>
    <div class="tran"><span class="zh">${esc(item.zh)}</span><span class="en">${esc(item.en)}</span></div>
    ${exampleBox(item)}
    <div class="input-wrap">
      <input class="word-input" type="text" lang="ru" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="点这里听读音，抄写俄文后点别处比对">
      <span class="verdict"></span>
    </div>
  </li>`;
}

function copyCheck(row, item, _input, value) {
  const ok = isMatch(value, item.word);
  setVerdict(row, ok, ok ? '✓ 相符' : `✗ 不相符 · 正确写法：${item.stress}`);
}

function renderCopy(root) {
  const tab = S.progress.ui.copyTab;
  const learnCount = learningPool().length;
  const reviewCount = reviewPool().length;
  root.innerHTML = `<section class="panel">
    <div class="panel-head">
      <h2>抄写</h2>
      <div class="subtabs">
        <button class="subtab ${tab === 'learn' ? 'active' : ''}" data-copytab="learn">学习 (${learnCount})</button>
        <button class="subtab ${tab === 'review' ? 'active' : ''}" data-copytab="review">复习 (${reviewCount})</button>
      </div>
    </div>
    <p class="hint">点击输入框自动播放读音；输入后失焦会再播一次并自动比对是否相符。抄写只练手感与拼写，不改变掌握进度。<br>技巧：输入框里按 <b>回车</b> 就是判分；没有选中任何输入框时按 <b>回车</b>，会自动跳到本页第一个空着或写错的输入框。</p>
    <div id="copyBody"></div>
  </section>`;
  root.querySelectorAll('[data-copytab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.progress.ui.copyTab = btn.dataset.copytab;
      save();
      render();
    });
  });
  const body = root.querySelector('#copyBody');
  if (tab === 'review') renderCopyReview(body);
  else renderCopyLearn(body);
}

function renderCopyLearn(body) {
  const pool = learningPool();
  if (!pool.length) {
    body.innerHTML = '<div class="empty">学习池已清空，所有单词都在「已掌握」里 🎉</div>';
    return;
  }
  const total = Math.max(1, Math.ceil(pool.length / PER_PAGE));
  const page = clamp(S.progress.ui.copyPage, 1, total);
  S.progress.ui.copyPage = page;
  const words = pool.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  body.innerHTML = `${pagerHTML(page, total)}
    <ul class="rows">${words.map((word, i) => copyRow(word, (page - 1) * PER_PAGE + i + 1)).join('')}</ul>`;
  bindPager(body, total, (next) => {
    S.progress.ui.copyPage = next;
    save();
    render();
  });
  bindWordInputs(body, copyCheck);
}

function reviewWordsFor(kind) {
  const pageKey = kind === 'copy' ? 'copyReviewPage' : 'reciteReviewPage';
  const key = `${kind}:${S.progress.ui[pageKey]}`;
  if (S.session.reviewSnap && S.session.reviewSnap.key === key) return S.session.reviewSnap.words;
  const page = S.progress.ui[pageKey];
  const words = reviewPool().slice((page - 1) * PER_PAGE, page * PER_PAGE);
  S.session.reviewSnap = { key, words };
  return words;
}

function renderCopyReview(body) {
  const pool = reviewPool();
  if (!pool.length) {
    body.innerHTML = '<div class="empty">复习队列是空的。在「已掌握」里点「复习」，或让超期单词自动纳入。</div>';
    return;
  }
  const total = Math.max(1, Math.ceil(pool.length / PER_PAGE));
  const page = clamp(S.progress.ui.copyReviewPage, 1, total);
  S.progress.ui.copyReviewPage = page;
  const words = reviewWordsFor('copy');
  body.innerHTML = `${pagerHTML(page, total)}
    <p class="hint">复习队列：写对一次即通过（保持「已掌握」、天数重新计时）；写错则移出「已掌握」并重新累计。</p>
    <ul class="rows">${words.map((word, i) => copyRow(word, (page - 1) * PER_PAGE + i + 1)).join('')}</ul>`;
  bindPager(body, total, (next) => {
    S.progress.ui.copyReviewPage = next;
    save();
    render();
  });
  bindWordInputs(body, copyCheck);
}

// ------------------------------------------------------------------ 默写

function reciteRow(word, index) {
  const item = info(word);
  return `<li class="row recite" data-idx="${item.idx}">
    <div class="row-head">
      <span class="idx">${index}</span>
      <span class="reveal-answer"></span>
      <button class="link reveal hidden" data-idx="${item.idx}">显示答案</button>
      ${speakButton(item.idx)}
      ${statusChips(S.progress.words[word])}
      ${exampleButton(item)}
    </div>
    <div class="tran"><span class="zh">${esc(item.zh)}</span><span class="en">${esc(item.en)}</span></div>
    ${exampleBox(item)}
    <div class="input-wrap">
      <input class="word-input" type="text" lang="ru" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="点这里听读音，写出俄文后点别处判分">
      <span class="verdict"></span>
    </div>
  </li>`;
}

function revealAnswer(row) {
  const item = S.byIdx.get(Number(row.dataset.idx));
  const target = row.querySelector('.reveal-answer');
  if (item && target) target.textContent = item.stress;
}

function reciteCheck(row, item, value, slot) {
  const entry = entryOf(item.word);
  const needBefore = needFor(entry);
  const ok = isMatch(value, item.word);
  const result = applyReciteResult(entry, ok, todayISO());
  const submitted = S.progress.recite.pageSubmitted[slot] || (S.progress.recite.pageSubmitted[slot] = []);
  if (!submitted.includes(item.word)) submitted.push(item.word);
  if (ok) {
    const text = result === 'mastered'
      ? `✓ 已掌握（连对 ${needBefore} 次，错误次数清零）`
      : `✓ 正确（连对 ${entry.correct}/${needFor(entry)} 次）`;
    setVerdict(row, true, text);
    const reveal = row.querySelector('.reveal');
    if (reveal) reveal.remove();
  } else {
    setVerdict(row, false, `✗ 错误（错误 +1，正确次数清零；下次需连对 ${needFor(entry)} 次）`);
    const reveal = row.querySelector('.reveal');
    if (reveal) reveal.classList.remove('hidden');
  }
  refreshChips(row, entry);
  updateReciteNext(row.closest('.rows'));
  renderStats();
  save();
}

function reciteReviewCheck(row, item, value) {
  const entry = entryOf(item.word);
  const ok = isMatch(value, item.word);
  const result = applyReciteResult(entry, ok, todayISO());
  if (ok) {
    setVerdict(row, true, '✓ 复习通过（保持「已掌握」，天数重新计时）');
    const reveal = row.querySelector('.reveal');
    if (reveal) reveal.remove();
  } else {
    setVerdict(row, false, result === 'demoted'
      ? '✗ 错误 · 已移出「已掌握」，错误次数 +1，正确次数清零'
      : '✗ 错误');
    const reveal = row.querySelector('.reveal');
    if (reveal) reveal.classList.remove('hidden');
  }
  refreshChips(row, entry);
  renderStats();
  save();
}

function updateReciteNext(rows) {
  const button = document.getElementById('reciteNext');
  if (!button || !rows) return;
  const inputs = [...rows.querySelectorAll('.row .word-input')];
  button.disabled = !inputs.length || !inputs.every((input) => input.value.trim() !== '');
}

function renderRecite(root) {
  const tab = S.progress.ui.reciteTab;
  const reviewCount = reviewPool().length;
  root.innerHTML = `<section class="panel">
    <div class="panel-head">
      <h2>默写</h2>
      <div class="subtabs">
        <button class="subtab ${tab === 'learn' ? 'active' : ''}" data-recitab="learn">学习</button>
        <button class="subtab ${tab === 'review' ? 'active' : ''}" data-recitab="review">复习 (${reviewCount})</button>
      </div>
    </div>
    <p class="hint">不显示俄文原文。点输入框播读音，失焦后再次播放并判分：连对 ${MASTER_BASE} 次进「已掌握」（每错一次门槛 +1，正确次数清零）。写错可点「显示答案」。<br>技巧：输入框里按 <b>回车</b> 就是判分；没有选中任何输入框时按 <b>回车</b>，会自动跳到本页第一个空着或写错的输入框。</p>
    <div id="reciteBody"></div>
  </section>`;
  root.querySelectorAll('[data-recitab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.progress.ui.reciteTab = btn.dataset.recitab;
      save();
      render();
    });
  });
  const body = root.querySelector('#reciteBody');
  if (tab === 'review') renderReciteReview(body);
  else renderReciteLearn(body);
}

function renderReciteLearn(body) {
  const recite = S.progress.recite;
  if (!recite.plan.length) {
    body.innerHTML = '<div class="empty">所有单词都已掌握，没有需要默写的词了 🎉</div>';
    return;
  }
  const slot = clamp(recite.cursor, 1, recite.plan.length);
  recite.cursor = slot;
  const planEntry = recite.plan[slot - 1];
  const group = recite.groups.find((item) => item.id === planEntry.groupId);
  const keep = S.session.keepVisible[slot] || (S.session.keepVisible[slot] = new Set());
  const submitted = recite.pageSubmitted[slot] || (recite.pageSubmitted[slot] = []);
  const words = group ? group.words.filter((word) => isActive(word) || keep.has(word)) : [];
  words.forEach((word) => keep.add(word));
  const done = !words.length || words.every((word) => submitted.includes(word));
  const round = (group?.stage ?? -1) + 2;
  body.innerHTML = `<div class="pagebar">
      <button class="btn" id="recitePrev" ${slot <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="pager-info">第 <input class="page-input" id="reciteJump" type="number" min="1" max="${recite.plan.length}" value="${slot}"> / ${recite.plan.length} 页</span>
      <button class="btn" id="reciteNext" ${done ? '' : 'disabled'}>下一页 ›</button>
      <span class="muted">本页 ${words.length} 词 · 已提交 ${words.filter((w) => submitted.includes(w)).length} 词 · 该组第 ${round} 轮</span>
    </div>
    ${done ? '' : '<p class="hint">本页每个词都提交过一次后，「下一页」才会亮起。</p>'}
    <ul class="rows">${words.map((word, i) => reciteRow(word, i + 1)).join('')}</ul>`;
  const jump = body.querySelector('#reciteJump');
  const commitJump = () => {
    const target = clamp(jump.value, 1, recite.plan.length);
    if (target === slot) return;
    recite.cursor = target;
    save();
    render();
  };
  jump.addEventListener('change', commitJump);
  jump.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commitJump();
    }
  });
  body.querySelector('#recitePrev').addEventListener('click', () => {
    if (slot <= 1) return;
    recite.cursor = slot - 1;
    save();
    render();
  });
  body.querySelector('#reciteNext').addEventListener('click', () => {
    if (done) goNextSlot();
  });
  bindWordInputs(body, (row, item, _input, value) => reciteCheck(row, item, value, slot));
}

function renderReciteReview(body) {
  const pool = reviewPool();
  if (!pool.length) {
    body.innerHTML = '<div class="empty">复习队列是空的。在「已掌握」里点「复习」，或让超期单词自动纳入。</div>';
    return;
  }
  const total = Math.max(1, Math.ceil(pool.length / PER_PAGE));
  const page = clamp(S.progress.ui.reciteReviewPage, 1, total);
  S.progress.ui.reciteReviewPage = page;
  const words = reviewWordsFor('recite');
  body.innerHTML = `${pagerHTML(page, total)}
    <p class="hint">复习队列：写对一次即通过；写错则移出「已掌握」、错误次数 +1、正确次数清零。</p>
    <ul class="rows">${words.map((word, i) => reciteRow(word, (page - 1) * PER_PAGE + i + 1)).join('')}</ul>`;
  bindPager(body, total, (next) => {
    S.progress.ui.reciteReviewPage = next;
    save();
    render();
  });
  bindWordInputs(body, (row, item, _input, value) => reciteReviewCheck(row, item, value));
}

// 完成本页 -> 记录该组这一次的出现 -> 生成/前进到下一页
function goNextSlot() {
  const recite = S.progress.recite;
  const current = recite.cursor;
  const planEntry = recite.plan[current - 1];
  if (planEntry) {
    const group = recite.groups.find((item) => item.id === planEntry.groupId);
    if (group && group.scheduledSlot !== current) {
      group.scheduledSlot = current;
      markGroupAppeared(recite, group.id, current);
    }
  }
  if (current < recite.plan.length) {
    recite.cursor = current + 1;
  } else {
    const created = generateSlot(recite, isActive, newWordsForGroups());
    if (!created) {
      notice('所有单词都已掌握，没有下一页了 🎉');
      return;
    }
    recite.cursor = recite.plan.length;
  }
  save();
  render();
}

// ------------------------------------------------------------------ 已掌握

function masteredRow({ item, entry, days }) {
  return `<tr data-idx="${item.idx}">
    <td class="col-idx muted">${item.idx}</td>
    <td class="ru">${speakButton(item.idx)}<span class="word">${esc(item.stress)}</span></td>
    <td>${esc(item.zh)}</td>
    <td class="muted">${esc(item.en)}</td>
    <td><b>${days}</b> 天${entry.lastCorrectAt ? `<span class="muted"> · ${esc(entry.lastCorrectAt)}</span>` : ''}</td>
    <td>${statusChips(entry)}</td>
    <td><button class="btn small review-btn" data-idx="${item.idx}" ${entry.queued ? 'disabled' : ''}>${entry.queued ? '已在队列' : '复习'}</button></td>
  </tr>`;
}

function masteredList() {
  const today = todayISO();
  const rows = [];
  for (const item of S.words) {
    const entry = S.progress.words[item.word];
    if (!entry || !entry.mastered) continue;
    rows.push({ item, entry, days: entry.lastCorrectAt ? daysBetween(entry.lastCorrectAt, today) : 0 });
  }
  return rows;
}

function renderMastered(root) {
  const settings = S.progress.settings;
  const query = S.session.masteredQuery;
  const list = masteredList().filter(({ item }) => matchQuery(item, query));
  if (S.session.masteredSort === 'days') {
    list.sort((a, b) => b.days - a.days || a.item.rank - b.item.rank);
  } else {
    list.sort((a, b) => a.item.rank - b.item.rank);
  }
  const total = Math.max(1, Math.ceil(list.length / LIST_PAGE));
  const page = clamp(S.progress.ui.masteredPage, 1, total);
  S.progress.ui.masteredPage = page;
  const rows = list.slice((page - 1) * LIST_PAGE, page * LIST_PAGE);
  root.innerHTML = `<section class="panel">
    <div class="panel-head">
      <h2>已掌握</h2>
      <input id="masteredSearch" class="search" type="search" placeholder="搜索俄文 / 中文 / 英文…" value="${esc(query)}">
      <select id="masteredSort" class="select">
        <option value="days" ${S.session.masteredSort === 'days' ? 'selected' : ''}>按间隔天数（久未复习在前）</option>
        <option value="rank" ${S.session.masteredSort === 'rank' ? 'selected' : ''}>按词频顺序</option>
      </select>
      <span class="muted">共 ${list.length} 词</span>
    </div>
    <div class="settings">
      <label><input type="checkbox" id="autoOn" ${settings.autoReviewEnabled ? 'checked' : ''}> 自动纳入复习</label>
      <label>超过 <input type="number" id="autoDays" class="num" min="1" max="3650" value="${settings.autoReviewDays}"> 天没正确默写就自动加入复习队列</label>
      <button class="btn small" id="autoRun">立即检查</button>
      <label><input type="checkbox" id="vkbOn" ${settings.virtualKeyboard ? 'checked' : ''}> 显示俄文字母键盘</label>
    </div>
    ${pagerHTML(page, total)}
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th class="col-idx">#</th><th>俄文</th><th>中文</th><th>英文</th><th>距上次正确默写</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>${rows.map(masteredRow).join('') || '<tr><td colspan="7" class="muted">还没有已掌握的单词，去「默写」连对几次试试。</td></tr>'}</tbody>
      </table>
    </div>
    ${pagerHTML(page, total)}
  </section>`;
  bindPager(root, total, (next) => {
    S.progress.ui.masteredPage = next;
    save();
    render();
  });
  const search = root.querySelector('#masteredSearch');
  search.addEventListener('input', () => {
    S.session.masteredQuery = search.value;
    S.progress.ui.masteredPage = 1;
    S.session.masteredFocus = true;
    render();
  });
  root.querySelector('#masteredSort').addEventListener('change', (ev) => {
    S.session.masteredSort = ev.target.value;
    render();
  });
  root.querySelector('#autoOn').addEventListener('change', (ev) => {
    settings.autoReviewEnabled = ev.target.checked;
    save();
    notice(ev.target.checked ? '已开启自动纳入复习' : '已关闭自动纳入复习');
  });
  root.querySelector('#autoDays').addEventListener('change', (ev) => {
    settings.autoReviewDays = clamp(ev.target.value, 1, 3650);
    save();
    render();
  });
  root.querySelector('#autoRun').addEventListener('click', () => {
    const count = autoQueue(Object.values(S.progress.words), settings, todayISO());
    save();
    render();
    notice(count ? `已把 ${count} 个超期单词加入复习队列` : '暂时没有超期需要复习的单词');
  });
  root.querySelector('#vkbOn').addEventListener('change', (ev) => {
    settings.virtualKeyboard = ev.target.checked;
    save();
    updateKeyboard();
  });
  if (S.session.masteredFocus) {
    S.session.masteredFocus = false;
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

// ------------------------------------------------------------------ 错题本

function wrongRow({ item, entry }) {
  const need = needFor(entry);
  return `<tr data-idx="${item.idx}">
    <td class="col-idx muted">${item.idx}</td>
    <td class="ru">${speakButton(item.idx)}<span class="word">${esc(item.stress)}</span></td>
    <td>${esc(item.zh)}</td>
    <td class="muted">${esc(item.en)}</td>
    <td><b class="bad-text">${entry.errors}</b> 次</td>
    <td class="muted">${esc(entry.lastErrorAt || '')}</td>
    <td>连对 <b>${need}</b> 次（已连对 ${entry.correct || 0}）</td>
  </tr>`;
}

function renderWrong(root) {
  const query = S.session.wrongQuery;
  const list = [];
  for (const item of S.words) {
    const entry = S.progress.words[item.word];
    if (entry && !entry.mastered && entry.errors > 0 && matchQuery(item, query)) list.push({ item, entry });
  }
  if (S.session.wrongSort === 'errors') {
    list.sort((a, b) => b.entry.errors - a.entry.errors || a.item.rank - b.item.rank);
  } else if (S.session.wrongSort === 'recent') {
    list.sort((a, b) => String(b.entry.lastErrorAt || '').localeCompare(String(a.entry.lastErrorAt || '')));
  } else {
    list.sort((a, b) => a.item.rank - b.item.rank);
  }
  const total = Math.max(1, Math.ceil(list.length / LIST_PAGE));
  const page = clamp(S.progress.ui.wrongPage, 1, total);
  S.progress.ui.wrongPage = page;
  const rows = list.slice((page - 1) * LIST_PAGE, page * LIST_PAGE);
  root.innerHTML = `<section class="panel">
    <div class="panel-head">
      <h2>错题本</h2>
      <input id="wrongSearch" class="search" type="search" placeholder="搜索俄文 / 中文 / 英文…" value="${esc(query)}">
      <select id="wrongSort" class="select">
        <option value="errors" ${S.session.wrongSort === 'errors' ? 'selected' : ''}>按错误次数（多在前）</option>
        <option value="recent" ${S.session.wrongSort === 'recent' ? 'selected' : ''}>按最近出错</option>
        <option value="rank" ${S.session.wrongSort === 'rank' ? 'selected' : ''}>按词频顺序</option>
      </select>
      <span class="muted">共 ${list.length} 词</span>
    </div>
    <p class="hint">默写写错的词会自动记在这里；每多错一次，进入「已掌握」所需的连续正确次数 +1。进入「已掌握」后自动移出本表。</p>
    ${pagerHTML(page, total)}
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th class="col-idx">#</th><th>俄文</th><th>中文</th><th>英文</th><th>错误次数</th><th>最近出错</th><th>还需连对</th>
        </tr></thead>
        <tbody>${rows.map(wrongRow).join('') || '<tr><td colspan="7" class="muted">错题本是空的，继续保持 👍</td></tr>'}</tbody>
      </table>
    </div>
    ${pagerHTML(page, total)}
  </section>`;
  bindPager(root, total, (next) => {
    S.progress.ui.wrongPage = next;
    save();
    render();
  });
  const search = root.querySelector('#wrongSearch');
  search.addEventListener('input', () => {
    S.session.wrongQuery = search.value;
    S.progress.ui.wrongPage = 1;
    S.session.wrongFocus = true;
    render();
  });
  root.querySelector('#wrongSort').addEventListener('change', (ev) => {
    S.session.wrongSort = ev.target.value;
    render();
  });
  if (S.session.wrongFocus) {
    S.session.wrongFocus = false;
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

// ------------------------------------------------------------------ 交互与虚拟键盘

// 这个格子是否还需要动手：空着，或者写错了（用同一套宽松规则比对）
function inputNeedsAttention(input) {
  if (!input.value.trim()) return true;
  const row = input.closest('.row');
  const item = row ? S.byIdx.get(Number(row.dataset.idx)) : null;
  if (!item) return false;
  return !isMatch(input.value, item.word);
}

// 没有选中任何输入框时按回车：跳到本页从上到下第一个空着或写错的输入框
function focusFirstPendingInput() {
  const inputs = [...document.querySelectorAll('.word-input')];
  if (!inputs.length) return;
  const target = inputs.find(inputNeedsAttention);
  if (!target) {
    notice('本页都写对了 👍');
    return;
  }
  target.focus();
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function isTextField(node) {
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable === true);
}

// 只有「什么都没聚焦」（焦点在页面本体上）时才接管回车，避免抢走按钮/下拉的回车操作
function isIdleFocus() {
  const active = document.activeElement;
  if (!active) return true;
  return active.tagName === 'BODY' || active.tagName === 'HTML';
}

function bindGlobal() {
  document.getElementById('kbdToggle').addEventListener('click', () => toggleKeyboard());

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (isTextField(ev.target) || !isIdleFocus()) return;   // 输入框/按钮上的回车交给它们自己处理
    if (ev.preventDefault) ev.preventDefault();
    focusFirstPendingInput();
  });

  document.getElementById('mainNav').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-view]');
    if (!btn) return;
    S.view = btn.dataset.view;
    if (window.location.hash !== '#' + S.view) window.location.hash = S.view;
    render();
  });

  window.addEventListener('hashchange', () => {
    S.view = viewFromHash();
    render();
  });

  document.addEventListener('click', (ev) => {
    const speak = ev.target.closest('.speak');
    if (speak) {
      const item = S.byIdx.get(Number(speak.dataset.idx));
      if (item) playWord(item.word);
      return;
    }
    const example = ev.target.closest('.ex-toggle');
    if (example) {
      const box = example.closest('td, .row, .panel')?.querySelector('.example');
      if (box) box.classList.toggle('hidden');
      return;
    }
    const reveal = ev.target.closest('.reveal');
    if (reveal) {
      const row = reveal.closest('.row');
      if (row) {
        revealAnswer(row);
        reveal.classList.add('hidden');
      }
      return;
    }
    const review = ev.target.closest('.review-btn');
    if (review) {
      const item = S.byIdx.get(Number(review.dataset.idx));
      if (!item) return;
      const entry = entryOf(item.word);
      if (entry.queued) return;
      entry.queued = true;
      entry.queueReason = 'manual';
      save();
      render();
      notice(`已把「${item.word}」加入复习队列，去「抄写 / 默写」的复习标签页练习`);
    }
  });
}

function buildKeyboard() {
  const keys = document.getElementById('kbdKeys');
  keys.innerHTML = KEYBOARD_ROWS
    .map((row, index) => `<div class="kbd-row r${index + 1}">${row
      .map((ch) => `<button class="key" data-char="${ch}">${ch}</button>`)
      .join('')}</div>`)
    .join('')
    + '<div class="kbd-row fn">'
    + '<button class="key wide" data-char=" ">空格</button>'
    + '<button class="key wide" id="kbdBack">⌫ 删除</button></div>';
  keys.addEventListener('mousedown', (ev) => ev.preventDefault());
  keys.addEventListener('click', (ev) => {
    const key = ev.target.closest('.key');
    if (!key) return;
    const input = S.session.lastInput;
    if (!input || !input.isConnected) {
      notice('先点一下要输入的那一行输入框，再点字母');
      return;
    }
    if (key.id === 'kbdBack') {
      const start = input.selectionStart ?? input.value.length;
      if (start > 0) {
        input.value = input.value.slice(0, start - 1) + input.value.slice(input.selectionEnd ?? start);
        input.focus();
        input.setSelectionRange(start - 1, start - 1);
      }
      return;
    }
    insertAtCursor(input, key.dataset.char);
  });
  document.getElementById('kbdClose').addEventListener('click', () => {
    toggleKeyboard(false);
  });
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.focus();
  input.setSelectionRange(pos, pos);
}

function updateKeyboard() {
  const visible = !!S.progress.settings.virtualKeyboard;
  const panel = document.getElementById('keyboard');
  const toggle = document.getElementById('kbdToggle');
  panel.classList.toggle('hidden', !visible);
  document.body.classList.toggle('with-keyboard', visible);
  toggle.classList.toggle('open', visible);
  toggle.textContent = visible ? '⌨ 收起键盘' : '⌨ 展开键盘';
  toggle.title = visible ? '收起俄文字母键盘' : '展开俄文字母键盘';
  toggle.style.bottom = visible ? `${(panel.offsetHeight || 232) + 14}px` : '16px';
  const checkbox = document.getElementById('vkbOn');
  if (checkbox) checkbox.checked = visible;
}

// 键盘与右下角悬浮按钮共用同一个开关（settings.virtualKeyboard），收起后按钮依然常驻
function toggleKeyboard(force) {
  const next = force === undefined ? !S.progress.settings.virtualKeyboard : !!force;
  S.progress.settings.virtualKeyboard = next;
  save();
  updateKeyboard();
  if (!next) notice('键盘已收起，右下角「⌨ 展开键盘」可以随时展开');
}

boot().catch((err) => {
  document.getElementById('app').innerHTML =
    `<div class="empty">启动失败：${esc(err.message)}<br>请确认是用 start.bat（或 python server.py）启动的本页面。</div>`;
});
