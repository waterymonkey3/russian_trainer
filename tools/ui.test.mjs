// 用极简 DOM 桩把 web/app.js 真跑一遍，验证「抄写/默写/复习」的交互接线。
// 运行： node tools/ui.test.mjs
import assert from 'node:assert/strict';

// ----------------------------------------------------------------- DOM 桩

function makeClassList() {
  const set = new Set();
  return {
    has: (name) => set.has(name),
    add: (name) => set.add(name),
    remove: (name) => set.delete(name),
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : !!force;
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
  };
}

function makeEl(name) {
  const el = {
    name,
    _html: '',
    _cache: new Map(),
    _inputs: [],
    _rows: [],
    listeners: {},
    classList: makeClassList(),
    dataset: {},
    value: '',
    textContent: '',
    disabled: false,
    focused: false,
    style: {},
    selectionStart: 0,
    selectionEnd: 0,
    parentElement: null,
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._disconnect();   // 旧内容（含缓存子元素）被替换即断开
      this._html = String(value);
      this._cache = new Map();
      this._inputs = [];
      this._rows = [];
      const rowRe = /<li class="row[^"]*" data-idx="(\d+)"/g;
      for (const match of this._html.matchAll(rowRe)) {
        const row = makeEl('row');
        row.dataset.idx = match[1];
        const input = makeEl('input');
        input.closest = (sel) => (sel === '.rows' ? el : row);
        input.parentElement = row;
        row.closest = (sel) => (sel === '.rows' ? el : null);
        row._input = input;
        el._rows.push(row);
        el._inputs.push(input);
      }
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type, event = {}) { for (const fn of [...(this.listeners[type] || [])]) fn(event); },
    querySelector(sel) {
      if (!this._cache.has(sel)) {
        const stub = makeEl(sel);
        this._stubs = [...(this._stubs || []), stub];
        this._cache.set(sel, stub);
      }
      return this._cache.get(sel);
    },
    _disconnect() {
      for (const child of [...this._inputs, ...this._rows, ...(this._stubs || [])]) {
        child.isConnected = false;
        if (typeof child._disconnect === 'function') child._disconnect();
      }
      this._stubs = [];
    },
    querySelectorAll(sel) {
      if (sel.includes('word-input')) return this._inputs;
      const attr = sel.match(/\[data-([a-zA-Z]+)\]/);
      if (attr) return this._attrStubs(attr[1]);
      return [];
    },
    _attrStubs(attrName) {
      const cacheKey = 'attr:' + attrName;
      if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);   // 让 app 与本测试共用同一批桩元素
      const list = [];
      const re = new RegExp(`data-${attrName}="([^"]+)"`, 'g');
      for (const match of this._html.matchAll(re)) {
        const button = makeEl('btn');
        button.dataset[attrName] = match[1];
        list.push(button);
      }
      this._cache.set(cacheKey, list);
      return list;
    },
    insertAdjacentHTML() {},
    closest(sel) { return sel === '.rows' ? this : null; },
    focus() { this.focused = true; this.fire('focus'); },
    scrollIntoView() {},
    remove() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    isConnected: true,
  };
  return el;
}

const byId = new Map();
const documentListeners = {};
const fakeDocument = {
  body: makeEl('body'),
  hidden: false,
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, makeEl('#' + id));
    return byId.get(id);
  },
  querySelector(selector) {
    if (selector.includes('word-input')) return this.querySelectorAll('.word-input')[0] || null;
    if (selector.startsWith('#')) return this.getElementById(selector.slice(1));
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes('word-input')) {          // 模拟 document.querySelectorAll('.word-input')
      const found = [];
      const walk = (el) => {
        found.push(...(el._inputs || []));
        for (const child of el._stubs || []) walk(child);
      };
      walk(byId.get('app'));
      return found;
    }
    return [];
  },
  addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); },
};

globalThis.document = fakeDocument;
globalThis.window = { location: { hash: '' }, addEventListener() {}, scrollTo() {} };
globalThis.Audio = class {
  constructor() { this.preload = ''; this.src = ''; this.currentTime = 0; this.played = []; }
  pause() {}
  play() { this.played.push(this.src); return Promise.resolve(); }
};

// ----------------------------------------------------------------- 假数据与 fetch

const WORDS = Array.from({ length: 25 }, (_, i) => ({
  idx: i + 1,
  word: 'w' + i,
  stress: 'w' + i,
  pos: 'noun',
  zh: '词' + i,
  en: 'word' + i,
  example_ru: i < 3 ? 'Пример ' + i : '',
  example_zh: i < 3 ? '例句 ' + i : '',
  rank: i + 1,
  part: 'high_freq',
  audio: '/audio/w' + i + '.mp3',
}));

const DEFAULT_PROGRESS = {
  version: 1,
  settings: { autoReviewDays: 30, autoReviewEnabled: true, virtualKeyboard: true, showExamples: true },
  words: {},
  recite: { groups: [], plan: [], pageSubmitted: {}, cursor: 1, nextSlot: 1, nextGroupId: 0 },
  ui: {},
};

let lastSaved = null;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const method = options.method || 'GET';
  if (target.includes('/api/vocab')) {
    return { ok: true, json: async () => ({ total: WORDS.length, words: WORDS }) };
  }
  if (target.includes('/api/progress')) {
    if (method === 'GET') return { ok: true, json: async () => JSON.parse(JSON.stringify(DEFAULT_PROGRESS)) };
    lastSaved = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return { ok: false, json: async () => ({}) };
};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + name + '\n       ' + err.message);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const appHtml = () => byId.get('app').innerHTML;
const clickNav = (view) => byId.get('mainNav').fire('click', { target: { closest: () => ({ dataset: { view } }) } });
const entryOf = (word) => (lastSaved?.words || {})[word];

await import('../web/app.js');
await wait(150);

// ----------------------------------------------------------------- 用例

function bodyInputs(selector) {
  return byId.get('app').querySelector(selector)._inputs;
}
function bodyHtml(selector) {
  return byId.get('app').querySelector(selector).innerHTML;
}
function typeInto(input, value) {
  input.value = value;
  input.fire('focus');
  input.fire('blur');
}

console.log('词汇书');
await test('首页渲染 20 条（每页 20）并显示总数', () => {
  const html = appHtml();
  const rows = [...html.matchAll(/<tr data-idx="\d+"/g)];
  assert.equal(rows.length, 20);
  assert.ok(html.includes('词汇书'));
  assert.ok(html.includes('w0'));
  assert.ok(byId.get('stats').innerHTML.includes('总计 <b>25</b>'));
});

console.log('抄写');
await test('每页 10 行、显示俄文原文与中英文翻译', () => {
  clickNav('copy');
  const html = appHtml();
  assert.equal(bodyInputs('#copyBody').length, 10);
  const item = WORDS[0];
  assert.ok(html.includes('抄写'));
  const body = bodyHtml('#copyBody');
  assert.ok(body.includes(item.stress), '抄写页应显示俄文原文');
  assert.ok(body.includes(item.zh) && body.includes(item.en), '抄写页应显示中英文');
});
await test('聚焦播读音、失焦再播一次并判定相符/不相符', () => {
  const inputs = bodyInputs('#copyBody');
  const root = byId.get('app').querySelector('#copyBody');
  const word0 = root._rows[0]._input;
  typeInto(word0, WORDS[0].word.toUpperCase());   // 宽松比对：大小写不敏感
  assert.ok(root._rows[0].querySelector('.verdict').textContent.includes('相符'));
  typeInto(inputs[1], 'совсем не то');
  const verdict = root._rows[1].querySelector('.verdict').textContent;
  assert.ok(verdict.includes('不相符'), verdict);
  assert.ok(verdict.includes(WORDS[1].stress), '不相符时应给出正确写法');
});
await test('抄写不影响进度', async () => {
  await wait(500);
  assert.equal(lastSaved, null, '抄写不应写入进度');
});

console.log('默写');
await test('不显示俄文原文，只有中英文提示', () => {
  clickNav('recite');
  const html = appHtml();
  const inputs = bodyInputs('#reciteBody');
  const body = bodyHtml('#reciteBody');
  assert.equal(inputs.length, 10);
  for (const item of WORDS.slice(0, 10)) {
    assert.ok(!body.includes(`>${item.word}<`), `默写页不该出现原文 ${item.word}`);
  }
  assert.ok(body.includes(WORDS[0].zh));
});
await test('「下一页」在本页 10 词未提交完前是禁用的', async () => {
  const inputs = bodyInputs('#reciteBody');
  typeInto(inputs[0], WORDS[0].word);
  await wait(500);
  assert.equal(byId.get('reciteNext').disabled, true);
  assert.ok(bodyHtml('#reciteBody').includes('id="reciteNext" disabled'), '未完成时按钮应带 disabled');
  assert.equal(entryOf('w0').correct, 1, '答对应记一次正确');
  assert.equal(entryOf('w0').errors, 0);
});
await test('答错：错误 +1、正确清零、露出「显示答案」', async () => {
  const root = byId.get('app').querySelector('#reciteBody');
  typeInto(root._rows[3]._input, 'ой нет');
  await wait(500);
  const entry = entryOf('w3');
  assert.equal(entry.errors, 1);
  assert.equal(entry.correct, 0);
  assert.ok(root._rows[3].querySelector('.verdict').textContent.includes('错误'));
  assert.equal(root._rows[3].querySelector('.reveal').classList.has('hidden'), false, '错的词应出现「显示答案」');
});
await test('全部提交后「下一页」可用，点它进入下一页', async () => {
  const inputs = bodyInputs('#reciteBody');
  for (const input of inputs) if (!input.value) typeInto(input, 'мимо');
  clickNav('vocab');
  clickNav('recite');
  assert.ok(!bodyHtml('#reciteBody').includes('id="reciteNext" disabled'), '10 词都提交过后按钮该亮起');
  const next = byId.get('app').querySelector('#reciteBody').querySelector('#reciteNext');
  next.fire('click');
  await wait(600);   // 等 save() 的防抖把进度写出去
  assert.equal(byId.get('reciteNext').disabled, false, '运行时按钮应为可用');
  const saved = lastSaved.recite;
  assert.equal(saved.plan.length, 2, '应该生成第 2 页');
  assert.equal(saved.cursor, 2);
  assert.equal(saved.groups[0].stage, 0);
  assert.equal(saved.groups[0].nextDueSlot, 3, '第 1 组下一次应在 2 页之后（1+2=3）重逢');
  assert.equal(bodyInputs('#reciteBody').length, 10, '新一页仍应 10 词');
});

console.log('掌握与已掌握模块');

console.log('俄文字母键盘');
await test('三排按真实 ЙЦУКЕН 顺序排列，另带空格与删除', () => {
  const html = byId.get('kbdKeys').innerHTML;
  const rows = [...html.matchAll(/<div class="kbd-row r\d">([\s\S]*?)<\/div>/g)]
    .map((match) => [...match[1].matchAll(/data-char="([^"]*)"/g)].map((item) => item[1]));
  assert.equal(rows.length, 3, '字母应该是三排');
  assert.deepEqual(rows[0], ['ё', 'й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ']);
  assert.deepEqual(rows[1], ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э']);
  assert.deepEqual(rows[2], ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', '-']);
  assert.ok(html.includes('>空格<') && html.includes('⌫ 删除'));
});
await test('点字母插入到光标处、⌫ 删除最后一个字符', () => {
  clickNav('copy');
  assert.equal(byId.get('keyboard').classList.has('hidden'), false, '抄写页应显示键盘');
  const input = bodyInputs('#copyBody')[0];
  input.value = 'при';
  input.selectionStart = 3;
  input.selectionEnd = 3;
  input.fire('focus');   // 先点输入框，让键盘知道往哪儿插
  const keys = byId.get('kbdKeys');
  const pressKey = (char, id = '') => keys.fire('click', {
    target: { closest: (sel) => (sel === '.key' ? { id, dataset: { char } } : null) },
  });
  pressKey('в');
  assert.equal(input.value, 'прив');
  pressKey('', 'kbdBack');
  assert.equal(input.value, 'при');
});
await test('在默写页也能用键盘输入，且不会显示原文', () => {
  clickNav('recite');
  assert.equal(byId.get('keyboard').classList.has('hidden'), false, '默写页也应显示键盘');
  const input = bodyInputs('#reciteBody')[0];
  input.value = '';
  input.selectionStart = 0;
  input.selectionEnd = 0;
  input.fire('focus');
  byId.get('kbdKeys').fire('click', {
    target: { closest: (sel) => (sel === '.key' ? { id: '', dataset: { char: 'я' } } : null) },
  });
  assert.equal(input.value, 'я');
});
await test('切换视图后旧输入框失效，键盘会提示先点输入框', () => {
  const stale = byId.get('app').querySelector('#reciteBody')._inputs[0];
  clickNav('vocab');                       // 换视图 -> 旧输入框脱离文档
  assert.equal(stale.isConnected, false);
  const before = stale.value;
  byId.get('kbdKeys').fire('click', {
    target: { closest: (sel) => (sel === '.key' ? { id: '', dataset: { char: 'ю' } } : null) },
  });
  assert.equal(stale.value, before, '不该往已经消失的输入框里塞字符');
  assert.ok(byId.get('notice').textContent.includes('先点一下'), byId.get('notice').textContent);
});
await test('右下角常驻按钮：收起后依然显示，点一下就能再展开', async () => {
  const toggle = byId.get('kbdToggle');
  clickNav('copy');
  assert.equal(byId.get('keyboard').classList.has('hidden'), false);
  assert.ok(toggle.textContent.includes('收起'), toggle.textContent);
  assert.equal(toggle.classList.has('open'), true);

  byId.get('kbdClose').fire('click');            // 面板上的「收起」
  await wait(500);
  assert.equal(byId.get('keyboard').classList.has('hidden'), true);
  assert.ok(toggle.textContent.includes('展开'), toggle.textContent);
  assert.equal(toggle.style.bottom, '16px', '收起后按钮回到右下角');
  assert.equal(lastSaved.settings.virtualKeyboard, false);

  toggle.fire('click');                           // 从右下角重新展开
  await wait(500);
  assert.equal(byId.get('keyboard').classList.has('hidden'), false);
  assert.ok(toggle.textContent.includes('收起'), toggle.textContent);
  assert.equal(lastSaved.settings.virtualKeyboard, true);

  const input = bodyInputs('#copyBody')[0];
  input.value = '';
  input.selectionStart = 0;
  input.selectionEnd = 0;
  input.fire('focus');
  byId.get('kbdKeys').fire('click', {
    target: { closest: (sel) => (sel === '.key' ? { id: '', dataset: { char: 'ё' } } : null) },
  });
  assert.equal(input.value, 'ё', '重新展开后应能继续用键盘输入');
});
await test('已掌握页的键盘开关与右下角按钮保持同步', () => {
  clickNav('mastered');
  assert.equal(byId.get('vkbOn').checked, true);
  byId.get('kbdToggle').fire('click');
  assert.ok(byId.get('kbdToggle').textContent.includes('展开'));
  assert.equal(byId.get('vkbOn').checked, false, '收起后设置里的复选框要同步取消');
  byId.get('kbdToggle').fire('click');
  assert.equal(byId.get('vkbOn').checked, true);
});

console.log('回车快速跳格');

function fireDocKey(key, extra = {}) {
  let prevented = false;
  for (const fn of (documentListeners.keydown || [])) {
    fn({ key, preventDefault() { prevented = true; }, stopPropagation() {}, ...extra });
  }
  return prevented;
}

const wordFor = (input) => WORDS[Number(input.closest('.row').dataset.idx) - 1].word;

await test('没有选中输入框时按回车：跳过已写对的，跳到第一个空格子', () => {
  clickNav('copy');
  const inputs = bodyInputs('#copyBody');
  for (const input of inputs) input.focused = false;
  inputs[0].value = wordFor(inputs[0]);   // 第一个已经写对
  fakeDocument.activeElement = null;
  fireDocKey('Enter');
  assert.equal(inputs[0].focused, false, '写对了就不该跳回去');
  assert.equal(inputs[1].focused, true, '应跳到第一个空输入框');
});
await test('写错的格子会重新被找到（哪怕后面还有空的）', () => {
  const inputs = bodyInputs('#copyBody');
  for (const input of inputs) input.focused = false;
  inputs[1].value = 'заведомо неверно';   // 第二个写错
  fakeDocument.activeElement = null;
  fireDocKey('Enter');
  assert.equal(inputs[1].focused, true, '写错的格子要能被找回来');
  assert.equal(inputs[2].focused, false, '不该跳过错的先去后面的空格');
  inputs[1].value = wordFor(inputs[1]);    // 改对之后就应该往后走
  for (const input of inputs) input.focused = false;
  fireDocKey('Enter');
  assert.equal(inputs[2].focused, true);
});
await test('输入框有焦点、或回车来自输入框时都不会抢焦点（留给判分）', () => {
  clickNav('recite');
  const inputs = bodyInputs('#reciteBody');
  for (const input of inputs) input.focused = false;
  fakeDocument.activeElement = { tagName: 'INPUT' };
  fireDocKey('Enter');
  assert.equal(inputs.some((input) => input.focused), false, '焦点在输入框里时不该跳格');
  fakeDocument.activeElement = null;
  fireDocKey('Enter', { target: { tagName: 'INPUT' } });
  assert.equal(inputs.some((input) => input.focused), false, '回车来自输入框时也不该跳格');
});
await test('焦点在按钮/下拉上时，回车留给它们自己（不抢焦点、不拦默认行为）', () => {
  const inputs = bodyInputs('#reciteBody');
  for (const input of inputs) input.focused = false;
  for (const tagName of ['BUTTON', 'SELECT', 'A']) {
    fakeDocument.activeElement = { tagName };
    const prevented = fireDocKey('Enter');
    assert.equal(inputs.some((input) => input.focused), false, `${tagName} 上按回车不该跳格`);
    assert.equal(prevented, false, `${tagName} 上按回车不该 preventDefault`);
  }
  fakeDocument.activeElement = { tagName: 'BODY' };
  assert.equal(fireDocKey('Enter'), true, '焦点在页面本体上时才接管回车');
  assert.equal(inputs[0].focused, true);
});
await test('回车键在非输入框上才生效，其他键不触发', () => {
  const inputs = bodyInputs('#reciteBody');
  for (const input of inputs) input.focused = false;
  fakeDocument.activeElement = null;
  fireDocKey('a');
  assert.equal(inputs.some((input) => input.focused), false);
  fireDocKey('Enter');
  assert.equal(inputs[0].focused, true);
});
await test('本页全部写对后按回车 → 直接进入下一页（走「下一页」同一套排期）', async () => {
  const inputs = bodyInputs('#reciteBody');
  for (const input of inputs) { input.value = wordFor(input); input.focused = false; }
  fakeDocument.activeElement = null;
  fireDocKey('Enter');
  await wait(500);
  const saved = lastSaved.recite;
  assert.equal(saved.cursor, 3, '应前进到下一页');
  assert.equal(saved.plan.length, 3, '应生成了第 3 页');
  assert.equal(saved.groups[1].stage, 0, '第 2 组这一轮出现要记账');
  assert.equal(saved.groups[1].nextDueSlot, 4, '下一轮应在 2 页之后（2+2=4）');
  assert.equal(bodyInputs('#reciteBody').length, 10);
  assert.equal(bodyInputs('#reciteBody')[0].focused, true, '光标应落在新页第一格');
  // 回到第 2 页，保持后续用例的前置状态
  byId.get('app').querySelector('#reciteBody').querySelector('#recitePrev').fire('click');
  await wait(100);
  assert.ok(bodyHtml('#reciteBody').includes('value="2"'), '应回到第 2 页');
});

function fireDocClick(target) {
  for (const fn of (documentListeners.click || [])) fn({ target });
}
function clickReviewButton(idx) {
  fireDocClick({ closest: (sel) => (sel === '.review-btn' ? { dataset: { idx: String(idx) } } : null) });
}
function clickSubtab(attr, value) {
  const stub = byId.get('app').querySelectorAll(`[data-${attr}]`).find((el) => el.dataset[attr] === value);
  assert.ok(stub, `找不到 ${attr}=${value} 的标签`);
  stub.fire('click');
}
function localToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

await test('连对 3 次后进入已掌握（错误次数清零、正确计数归位）', async () => {
  clickNav('recite');
  byId.get('app').querySelector('#reciteBody').querySelector('#recitePrev').fire('click');   // 回到第 1 页
  const input = bodyInputs('#reciteBody')[0];
  typeInto(input, WORDS[0].word);   // 第 2 次
  typeInto(input, WORDS[0].word);   // 第 3 次
  await wait(600);
  const entry = entryOf('w0');
  assert.equal(entry.mastered, true);
  assert.equal(entry.errors, 0);
  assert.equal(entry.correct, 0);
  assert.equal(entry.masteredAt, localToday());
});

await test('已掌握的词不再出现在抄写学习池', () => {
  clickNav('copy');
  const body = bodyHtml('#copyBody');
  assert.ok(!body.includes('<span class="word">w0</span>'), 'w0 已掌握，不该再出现');
  assert.equal(bodyInputs('#copyBody').length, 10);
  assert.ok(body.includes('<span class="word">w1</span>'), '后面的词应当补上来');
});

await test('已掌握列表显示间隔天数与「复习」按钮', () => {
  clickNav('mastered');
  const html = appHtml();
  assert.ok(html.includes('<span class="word">w0</span>'));
  assert.ok(html.includes('review-btn'));
  assert.ok(html.includes('>0</b> 天'), '刚掌握应为 0 天');
  assert.ok(html.includes('自动纳入复习'));
});

await test('点「复习」：保持已掌握、进入复习队列', async () => {
  clickReviewButton(WORDS[0].idx);
  await wait(600);
  const entry = entryOf('w0');
  assert.equal(entry.queued, true);
  assert.equal(entry.queueReason, 'manual');
  assert.equal(entry.mastered, true, '复习期间仍留在已掌握');
});

await test('复习页出现该词，写对一次即通过（天数重新计时）', async () => {
  clickNav('recite');
  clickSubtab('recitab', 'review');
  assert.equal(bodyInputs('#reciteBody').length, 1, '复习队列里只有 w0');
  assert.ok(bodyHtml('#reciteBody').includes(WORDS[0].zh));
  assert.ok(!bodyHtml('#reciteBody').includes(`>${WORDS[0].word}<`), '复习页同样不显示原文');
  typeInto(bodyInputs('#reciteBody')[0], WORDS[0].word);
  await wait(600);
  const entry = entryOf('w0');
  assert.equal(entry.mastered, true);
  assert.equal(entry.queued, false);
  assert.equal(entry.lastCorrectAt, localToday());
});

await test('复习写错：移出已掌握、错误 +1、回到学习池与错题本', async () => {
  clickNav('mastered');
  clickReviewButton(WORDS[0].idx);
  await wait(600);
  assert.equal(entryOf('w0').queued, true);
  clickNav('recite');
  clickSubtab('recitab', 'review');
  typeInto(bodyInputs('#reciteBody')[0], 'совершенно неверно');
  await wait(600);
  const entry = entryOf('w0');
  assert.equal(entry.mastered, false);
  assert.equal(entry.queued, false);
  assert.equal(entry.errors, 1);
  assert.equal(entry.correct, 0);

  clickNav('mastered');
  assert.ok(!appHtml().includes('<span class="word">w0</span>'), '已掌握列表应移除 w0');
  clickNav('wrong');
  const wrongHtml = appHtml();
  assert.ok(wrongHtml.includes('<span class="word">w0</span>'), '错题本应记录 w0');
  assert.ok(wrongHtml.includes('>1</b> 次'));
  assert.ok(wrongHtml.includes('连对 <b>4</b> 次'), '错一次后需要连对 3+1=4 次');
});

console.log('整页翻页（抄写）');
await test('抄写页整页写对后回车翻页，最后一页只给提示', async () => {
  clickNav('copy');
  let page = lastSaved?.ui?.copyPage ?? 1;
  for (let round = 0; round < 6; round += 1) {
    const inputs = bodyInputs('#copyBody');
    for (const input of inputs) { input.value = wordFor(input); input.focused = false; }
    fakeDocument.activeElement = null;
    fireDocKey('Enter');
    await wait(500);
    const next = lastSaved?.ui?.copyPage ?? 1;
    if (next === page) break;                     // 翻不动了 = 已经是最后一页
    page = next;
    assert.equal(bodyInputs('#copyBody')[0].focused, true, '翻页后光标应落在新页第一格');
  }
  assert.equal(page, 3, '25 个词应该刚好翻到第 3 页');
  assert.ok(byId.get('notice').textContent.includes('最后一页'), byId.get('notice').textContent);
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed) process.exitCode = 1;
