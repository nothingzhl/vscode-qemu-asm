const fs = require('node:fs');
const path = require('node:path');

// Historical validation reports retain the commands/configuration of their release.
const CURRENT_GUIDES = [
  'README.md', 'docs/README.md', 'docs/QUICKSTART.md', 'docs/CONFIGURATION.md',
  'docs/DEBUGGING.md', 'docs/TROUBLESHOOTING.md', 'docs/DEVELOPMENT.md', 'docs/OS_PROJECT.md'
];

function jsonBlocks(text) {
  const blocks = [];
  let fence;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && fence && marker[1][0] === fence.marker &&
        marker[1].length >= fence.length && !marker[2].trim()) {
      if (fence.json) blocks.push({ text: fence.lines.join('\n'), line: fence.line });
      fence = undefined;
    } else if (!fence && marker) {
      fence = { marker: marker[1][0], length: marker[1].length,
        json: marker[2].trim().toLowerCase() === 'json', line: index + 2, lines: [] };
    } else if (fence) fence.lines.push(line);
  }
  return blocks;
}

function checkFacts(root, files = CURRENT_GUIDES) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commands = new Set((manifest.contributes?.commands ?? []).map(command => command.title));
  const settings = new Set(Object.keys(manifest.contributes?.configuration?.properties ?? {}));
  const errors = [];
  let jsonExamples = 0;
  for (const relative of files) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) { errors.push(`${relative}: current guide does not exist`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    for (const block of jsonBlocks(text)) {
      jsonExamples++;
      try { JSON.parse(block.text); }
      catch (error) { errors.push(`${relative}:${block.line}: invalid JSON example: ${error.message}`); }
    }
    for (const title of new Set([...text.matchAll(/\*\*(QEMU Assembly: [^*\r\n]+)\*\*/g)].map(match => match[1].trim()))) {
      if (!commands.has(title)) errors.push(`${relative}: unknown command title: ${title}`);
    }
    for (const setting of new Set([...text.matchAll(/\bqemuAsm\.[A-Za-z][A-Za-z0-9]*/g)].map(match => match[0]))) {
      if (!settings.has(setting)) errors.push(`${relative}: unknown setting: ${setting}`);
    }
  }
  return { files: files.length, jsonExamples, errors };
}

if (require.main === module) {
  const result = checkFacts(path.resolve(__dirname, '../..'));
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`PASS: ${result.files} current guides, ${result.jsonExamples} JSON examples, command titles and settings`);
}
module.exports = { checkFacts, CURRENT_GUIDES };
