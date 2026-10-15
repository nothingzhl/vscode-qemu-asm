const fs = require('node:fs');
const resultPath = process.argv[2];
if (!resultPath || !fs.existsSync(resultPath)) {
  console.log('Compatibility did not reach the test runner; inspect the tool installation log.');
  process.exit(0);
}
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const cell = value => String(value).replace(/[|\r\n]/g, ' ');
console.log(`### ${cell(result.label)}: ${cell(result.status)}\n`);
console.log('| Tool | Observed version |\n| --- | --- |');
for (const [name, tool] of Object.entries(result.tools)) console.log(`| ${cell(name)} | ${cell(tool.version)} |`);
console.log('\n| Stage | Capability | State | Evidence | Reason |\n| --- | --- | --- | --- | --- |');
for (const { stage, report } of result.observations) {
  for (const item of report.entries) console.log(`| ${cell(stage)} | ${cell(item.id)} | ${cell(item.state)} | ${cell(item.evidence)} | ${cell(item.reason)} |`);
}
if (result.error) console.log(`\nFailure: ${cell(result.error.split('\n')[0])}`);
