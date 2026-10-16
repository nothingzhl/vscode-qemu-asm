// Resolve a tested main artifact. This script never publishes or reads VSCE_PAT.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const workflows = ['.github/workflows/ci.yml', '.github/workflows/compatibility.yml'];
function selectRuns(runs, sha) {
  return workflows.map(workflow => {
    const run = runs.filter(r => r.head_sha === sha && r.head_branch === 'main' && r.event === 'push' && r.path === workflow)
      .sort((a, b) => b.id - a.id)[0];
    if (run?.status === 'completed') assert.equal(run.conclusion, 'success', `${workflow} failed; no publication`);
    return run?.status === 'completed' ? run : undefined;
  });
}
function validateManifest(actual, expected) {
  for (const key of ['name', 'publisher', 'version', 'license']) assert.equal(actual[key], expected[key], `VSIX ${key} mismatch`);
  assert.equal(actual.publisher, 'nothingzhl'); assert.equal(actual.name, 'vscode-qemu-asm');
  assert.equal(actual.license, 'Apache-2.0');
}
async function main() {
  const output = path.resolve(process.argv[2] || 'artifacts/marketplace');
  const ref = process.env.PUBLISH_REF, sha = process.env.PUBLISH_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  assert(repository === 'nothingzhl/vscode-qemu-asm', 'use the upstream repository');
  assert(/^[a-f0-9]{40}$/.test(sha || ''), 'set a full PUBLISH_SHA');
  const expected = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert(/^\d+\.\d+\.\d+$/.test(expected.version), 'require a stable version');
  assert(ref === 'refs/heads/main' || ref === `refs/tags/v${expected.version}`, 'publish only main or a matching version tag');
  assert.equal((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), sha, 'checkout must match the requested commit');
  await exec('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
  const api = async endpoint => JSON.parse((await exec('gh', ['api', endpoint], { maxBuffer: 8 * 1024 * 1024 })).stdout);
  const deadline = Date.now() + 20 * 60 * 1000;
  let ready;
  while (Date.now() < deadline) {
    const result = await api(`repos/${repository}/actions/runs?head_sha=${sha}&branch=main&event=push&per_page=100`);
    const runs = selectRuns(result.workflow_runs, sha);
    if (runs.every(Boolean)) { ready = runs; break; }
    console.log('Waiting for CI and tool compatibility on the exact main commit...');
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  assert(ready, 'timed out waiting for successful main checks');
  const ci = ready[0];
  const artifacts = await api(`repos/${repository}/actions/runs/${ci.id}/artifacts?per_page=100`);
  const matches = artifacts.artifacts.filter(a => a.name === 'extension-vsix' && !a.expired);
  assert.equal(matches.length, 1, 'require exactly one non-expired tested VSIX artifact');
  await fs.mkdir(output, { recursive: true });
  await exec('gh', ['run', 'download', String(ci.id), '--repo', repository, '--name', 'extension-vsix', '--dir', output]);
  const vsix = path.join(output, 'qemu-asm.vsix');
  const manifest = JSON.parse((await exec('unzip', ['-p', vsix, 'extension/package.json'])).stdout);
  validateManifest(manifest, expected);
  const hash = createHash('sha256').update(await fs.readFile(vsix)).digest('hex');
  const evidence = { version: manifest.version, publisher: manifest.publisher, sha, sha256: hash,
    ciRun: ci.html_url, compatibilityRun: ready[1].html_url, artifactId: matches[0].id };
  await fs.writeFile(path.join(output, 'provenance.json'), JSON.stringify(evidence, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'qemu-asm.vsix.sha256'), `${hash}  qemu-asm.vsix\n`);
  console.log(JSON.stringify(evidence, null, 2));
}
module.exports = { selectRuns, validateManifest };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
