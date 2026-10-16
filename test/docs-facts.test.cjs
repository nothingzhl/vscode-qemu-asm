const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkFacts } = require('../scripts/docs/facts.cjs');

function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu docs facts '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ contributes: {
    commands: [{ title: 'QEMU Assembly: 检查环境' }],
    configuration: { properties: { 'qemuAsm.qemuPath': {} } }
  } }));
  fs.writeFileSync(path.join(root, 'guide.md'), content);
  return root;
}

test('current user guides contain valid JSON and manifest-backed commands/settings', () => {
  const result = checkFacts(path.resolve(__dirname, '..'));
  assert.deepEqual(result.errors, []);
  assert(result.jsonExamples >= 6, 'configuration examples must actually be examined');
});

test('facts check accepts Unicode commands, CRLF JSON and spaced paths', t => {
  const root = fixture(t, '**QEMU Assembly: 检查环境**\r\n```json\r\n{"qemuAsm.qemuPath":"/tools with spaces/qemu"}\r\n```');
  assert.deepEqual(checkFacts(root, ['guide.md']), { files: 1, jsonExamples: 1, errors: [] });
});

test('facts check points to malformed JSON examples', t => {
  const root = fixture(t, '# Guide\n\n```json\n{"image": "boot.img",}\n```');
  const result = checkFacts(root, ['guide.md']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^guide\.md:4: invalid JSON example:/);
});

test('facts check rejects commands and settings removed from the manifest', t => {
  const root = fixture(t, '**QEMU Assembly: 不存在的命令**\n`qemuAsm.oldSetting`\n```json\n{"qemuAsm.oldSetting": true}\n```');
  const result = checkFacts(root, ['guide.md']);
  assert.equal(result.errors.length, 2, 'repeat references produce one error per unknown fact');
  assert(result.errors.some(error => error.includes('unknown command title: QEMU Assembly: 不存在的命令')));
  assert(result.errors.some(error => error.includes('unknown setting: qemuAsm.oldSetting')));
});

test('literal Markdown examples and historical reports do not become current JSON requirements', t => {
  const root = fixture(t, '````markdown\n```json\nnot JSON\n```\n````\n\n~~~json\n{"image":"boot.img"}\n~~~');
  fs.writeFileSync(path.join(root, 'historical-report.md'), '**QEMU Assembly: 旧命令**\n```json\ninvalid\n```');
  assert.deepEqual(checkFacts(root, ['guide.md']), { files: 1, jsonExamples: 1, errors: [] });
});

test('a missing current guide fails rather than silently reducing coverage', t => {
  const root = fixture(t, '# Guide');
  assert.deepEqual(checkFacts(root, ['removed.md']).errors, ['removed.md: current guide does not exist']);
});
