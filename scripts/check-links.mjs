// Fails if a relative link in the skill's markdown points to a missing file or heading.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve('skills');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.md')) files.push(path);
  }
})(root);

// GitHub-style heading anchors: lowercase, drop punctuation except hyphens, spaces to hyphens.
const anchorsOf = (markdown) =>
  new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) =>
      title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')
    )
  );

let broken = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [path, anchor] = target.split('#');
    const resolved = path ? resolve(dirname(file), path) : file;
    if (!existsSync(resolved)) {
      console.error(`${file}: missing ${target}`);
      broken++;
    } else if (anchor && resolved.endsWith('.md') && !anchorsOf(readFileSync(resolved, 'utf8')).has(anchor)) {
      console.error(`${file}: missing anchor ${target}`);
      broken++;
    }
  }
}
console.log(`checked ${files.length} files, ${broken} broken links`);
process.exit(broken ? 1 : 0);
