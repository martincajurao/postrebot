const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const inner = [
  "const f=require('fs');",
  "const out='dist/data/uploads';",
  'f.mkdirSync(out,{recursive:true});',
  "console.log('ensured '+out);",
  'try{',
  "f.mkdirSync('.git/hooks',{recursive:true});",
  "f.copyFileSync('.githooks/pre-push','.git/hooks/pre-push');",
  "f.chmodSync('.githooks/pre-push',0o755);",
  "console.log('installed git pre-push hook (auto db checkpoint)')",
  '}catch(e){',
  "console.log('skipping git hook install (CI/not a repo):',e.message)",
  '}'
].join('');
pkg.scripts.postinstall = 'node -e ' + JSON.stringify(inner);
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 4) + '\n');
console.log('postinstall updated:', pkg.scripts.postinstall);
