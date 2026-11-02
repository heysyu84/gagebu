import fs from 'node:fs';
const files=['index.html','style-v2.css','ledger-v2.js','ledger-rules-v2.js','ledger-validation.js','ledger-sync.js','server-config.js','bank-xlsx-v2.js','favicon.svg','_headers'];
fs.mkdirSync('dist',{recursive:true});
for(const entry of fs.readdirSync('dist'))fs.rmSync('dist/'+entry,{recursive:true,force:true});
for(const file of files)fs.copyFileSync(file,'dist/'+file);
fs.cpSync('vendor','dist/vendor',{recursive:true});
console.log('Built static site in dist (application assets only).');
