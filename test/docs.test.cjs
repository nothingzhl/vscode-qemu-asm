const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkDocs, anchors } = require('../scripts/docs/check.cjs');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs check '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}
test('documentation links support spaces, Unicode headings, reference links and directory READMEs', t => {
  const root = fixture(t, {
    'README.md': '[start](<docs/My Guide.md#开始-调试>)\n[guide][reference]\n[reference]: docs/\n[web](https://example.com/missing)\n',
    'docs/My Guide.md': '# 开始 调试\n',
    'docs/README.md': '# Guide\n'
  });
  assert.deepEqual(checkDocs(root).errors, []);
});
test('missing files and heading anchors fail with the owning document', t => {
  const root = fixture(t, { 'README.md': '[missing](missing.md)\n[anchor](guide.md#gone)\n', 'guide.md': '# Present' });
  const result = checkDocs(root);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /^README.md: missing.md/);
  assert.match(result.errors[1], /heading anchor/);
});
test('example links in code fences are excluded and repository escapes fail', t => {
  const root = fixture(t, { 'README.md': '```md\n[example](absent.md)\n```\n[escape](../outside.md)\n' });
  const result = checkDocs(root);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /leaves the repository/);
});
test('duplicate headings receive GitHub-style suffixes and explicit HTML anchors remain available', () => {
  assert.deepEqual([...anchors('# Start\n# Start\n## `开始` 调试\n<a id="custom"></a>')], ['start', 'start-1', '开始-调试', 'custom']);
});
