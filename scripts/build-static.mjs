import fs from 'node:fs';
const files=['index.html','style-v2.css','ledger-v2.js','ledger-rules-v2.js','ledger-validation.js','ledger-sync.js','server-config.js','bank-xlsx-v2.js','favicon.svg','favicon.ico','favicon-16x16.png','favicon-32x32.png','apple-touch-icon.png','icon-192.png','icon-512.png','icon-maskable-512.png','manifest.webmanifest','_headers'];
fs.mkdirSync('dist',{recursive:true});
for(const entry of fs.readdirSync('dist'))fs.rmSync('dist/'+entry,{recursive:true,force:true});
for(const file of files)fs.copyFileSync(file,'dist/'+file);
fs.mkdirSync('dist/vendor',{recursive:true});
for(const file of ['jszip.min.js','LICENSE-jszip.md'])fs.copyFileSync('vendor/'+file,'dist/vendor/'+file);
console.log('Built static site in dist (application assets only).');
