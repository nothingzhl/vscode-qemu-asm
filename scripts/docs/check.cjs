const fs = require('node:fs');
const path = require('node:path');

function markdownFiles(root) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'artifacts', '.vscode-test']);
  function visit(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (ignored.has(entry.name)) return [];
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? visit(file) : /\.md$/i.test(file) ? [file] : [];
    });
  }
  return visit(root);
}

function prose(text) {
  let fence;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const start = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (start) {
        if (!fence) fence = start[1];
        else if (start[1][0] === fence[0] && start[1].length >= fence.length) fence = undefined;
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
}

function anchors(text) {
  const result = new Set();
  const duplicates = new Map();
  const clean = prose(text);
  for (const match of clean.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]
      .replace(/<[^>]*>/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    const count = duplicates.get(base) ?? 0;
    duplicates.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  for (const match of clean.matchAll(/<(?:a|h[1-6])\s+[^>]*(?:id|name)=["']([^"']+)["']/gi))
    result.add(match[1]);
  return result;
}

function checkDocs(root, files = markdownFiles(root)) {
  const errors = [];
  const anchorCache = new Map();
  for (const file of files) {
    const text = prose(fs.readFileSync(file, 'utf8'));
    const targets = [...text.matchAll(/\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)(?:\s+["'][^)\n]*["'])?\)/g)].map(
      (match) => match[1]
    );
    for (const match of text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>\n]+>|\S+)/gm)) targets.push(match[1]);
    for (const original of targets) {
      const target = original.replace(/^<|>$/g, '');
      if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) continue;
      try {
        const [rawFile, rawAnchor] = target.split('#', 2);
        const relative = decodeURIComponent(rawFile.split('?', 1)[0]);
        let destination = relative
          ? path.resolve(relative.startsWith('/') ? root : path.dirname(file), relative.replace(/^\//, ''))
          : file;
        const outside = path.relative(root, destination);
        if (outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside))
          throw new Error('link leaves the repository');
        if (!fs.existsSync(destination)) throw new Error('target does not exist');
        if (fs.statSync(destination).isDirectory()) {
          if (fs.existsSync(path.join(destination, 'README.md')))
            destination = path.join(destination, 'README.md');
          else if (rawAnchor) throw new Error('directory has no README anchor');
        }
        if (rawAnchor && /\.md$/i.test(destination)) {
          if (!anchorCache.has(destination))
            anchorCache.set(destination, anchors(fs.readFileSync(destination, 'utf8')));
          if (!anchorCache.get(destination).has(decodeURIComponent(rawAnchor)))
            throw new Error('heading anchor does not exist');
        }
      } catch (error) {
        errors.push(`${path.relative(root, file)}: ${original}: ${error.message}`);
      }
    }
  }
  return { files: files.length, errors };
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  const result = checkDocs(root);
  const facts = require('./facts.cjs').checkFacts(root);
  const errors = [...result.errors, ...facts.errors];
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      `PASS: ${result.files} Markdown files; links and anchors exist; ${facts.files} current guides and ${facts.jsonExamples} JSON examples match the manifest`
    );
}
module.exports = { checkDocs, anchors, prose };
