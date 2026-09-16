// 静态一致性检查：id 绑定、class 样式、模块引用是否对得上。
// 运行： node tools/assets.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = new URL('../web/', import.meta.url);
const read = (name) => readFileSync(fileURLToPath(new URL(name, web)), 'utf8');

const html = read('index.html');
const app = read('app.js');
const logic = read('logic.js');
const css = read('style.css');

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

function collect(source, regex, group = 1) {
  const found = new Set();
  for (const match of source.matchAll(regex)) found.add(match[group]);
  return found;
}

console.log('前端静态一致性');

test('所有 getElementById / querySelector("#id") 的元素都在 index.html 或模板里存在', () => {
  const defined = new Set([...collect(html, /id="([^"]+)"/g), ...collect(app, /id="([^"]+)"/g)]);
  const referenced = new Set([
    ...collect(app, /getElementById\('([^']+)'\)/g),
    ...collect(app, /querySelector\('#([^']+)'\)/g),
  ]);
  const missing = [...referenced].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], '以下 id 被引用但没有定义: ' + missing.join(', '));
});

test('data-view 导航都在 VIEWS 白名单里', () => {
  const navs = collect(html, /data-view="([^"]+)"/g);
  const viewList = app.match(/const VIEWS = \[([^\]]+)\]/)[1];
  const views = new Set(collect(viewList, /'([^']+)'/g));
  for (const nav of navs) assert.ok(views.has(nav), `data-view="${nav}" 不在 VIEWS 里`);
  assert.equal(navs.size, views.size);
});

// 这些 class 只作为行为钩子（点击/查询用），外观由 .link / .btn 提供
const BEHAVIOR_ONLY = new Set(['speak', 'ex-toggle', 'reveal', 'review-btn', 'recite']);

test('模板与 HTML 里用到的 class 都有样式定义', () => {
  const used = new Set();
  const addClasses = (value) => {
    for (const name of value.split(/\s+/)) {
      if (/^[a-zA-Z][\w-]*$/.test(name)) used.add(name);  // 过滤 ${...} 这类插值
    }
  };
  for (const match of html.matchAll(/class="([^"]+)"/g)) addClasses(match[1]);
  for (const match of app.matchAll(/class="([^"]+)"/g)) addClasses(match[1]);
  for (const match of app.matchAll(/classList\.(?:toggle|add|remove)\('([^']+)'/g)) addClasses(match[1]);
  const styled = collect(css, /\.([a-zA-Z][\w-]*)/g);
  const missing = [...used].filter((name) => !styled.has(name) && !BEHAVIOR_ONLY.has(name));
  assert.deepEqual(missing, [], '以下 class 没有样式: ' + missing.join(', '));
});

test('index.html 引用的资源都由前端目录提供', () => {
  const refs = collect(html, /(?:src|href)="\/([^"]+)"/g);
  for (const ref of refs) {
    assert.ok(['app.js', 'style.css', 'logic.js'].includes(ref), `未预期的资源引用: ${ref}`);
  }
  assert.ok(refs.has('app.js') && refs.has('style.css'));
});

test('app.js 从 logic.js 引入的函数都真实导出', () => {
  const importBlock = app.match(/import \{([\s\S]*?)\} from '\.\/logic\.js'/);
  assert.ok(importBlock, 'app.js 没有引入 logic.js');
  const imported = collect(importBlock[1], /([A-Za-z_][\w]*)/g);
  const exported = new Set([
    ...collect(logic, /export function (\w+)/g),
    ...collect(logic, /export const (\w+)/g),
  ]);
  const missing = [...imported].filter((name) => !exported.has(name));
  assert.deepEqual(missing, [], '未导出的名字: ' + missing.join(', '));
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed) process.exitCode = 1;
