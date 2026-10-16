const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectRuns, validateManifest } = require('../scripts/ci/prepare-marketplace.cjs');
const sha = 'a'.repeat(40);
const run = (id, path, extra = {}) => ({ id, path, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', ...extra });
const ci = '.github/workflows/ci.yml', compatibility = '.github/workflows/compatibility.yml';
test('publication waits for both checks on the exact main commit', () => {
  assert.deepEqual(selectRuns([run(1, ci), run(2, compatibility)], sha).map(r => r.id), [1, 2]);
  for (const extra of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }, { event: 'pull_request' }, { status: 'in_progress' }])
    assert.equal(selectRuns([run(1, ci, extra), run(2, compatibility)], sha)[0], undefined);
});
test('publication rejects failed checks and respects a newer rerun', () => {
  assert.throws(() => selectRuns([run(1, ci, { conclusion: 'failure' })], sha), /failed/);
  const runs = [run(1, ci), run(3, ci, { conclusion: 'cancelled' })];
  assert.throws(() => selectRuns(runs, sha), /failed/);
  assert.equal(selectRuns([...runs, run(4, ci)], sha)[0].id, 4);
});
test('publication rejects a mismatched package identity, version or license', () => {
  const expected = { name: 'vscode-qemu-asm', publisher: 'nothingzhl', version: '0.9.0', license: 'Apache-2.0' };
  validateManifest(expected, expected);
  for (const key of Object.keys(expected)) assert.throws(() => validateManifest({ ...expected, [key]: 'wrong' }, expected), /mismatch/);
});
