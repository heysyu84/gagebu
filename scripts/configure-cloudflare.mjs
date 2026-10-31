import fs from 'node:fs';
import path from 'node:path';

// Resolve an existing private D1 database into the local Wrangler config.
// This script never reads or writes ledger transactions, credentials, or secrets.
const input=process.argv[2];
if(!input)throw Error('Expected path to Wrangler D1 JSON list');
const payload=JSON.parse(fs.readFileSync(input,'utf8'));
const rows=Array.isArray(payload)?payload:(Array.isArray(payload.result)?payload.result:[]);
const match=rows.find(x=>x?.name==='store-ledger-private');
if(!match){console.error('The dedicated D1 database has not been created yet.');process.exit(12)}
const id=String(match.uuid||match.id||match.database_id||'');
if(!/^[a-fA-F0-9-]{32,36}$/.test(id))throw Error('Invalid D1 database UUID');
const sample=fs.readFileSync('wrangler.toml.example','utf8');
const needle='REPLACE_WITH_YOUR_D1_DATABASE_ID';
if(sample.split(needle).length!==2)throw Error('Unexpected Wrangler template');
fs.writeFileSync('wrangler.toml',sample.replace(needle,id),{mode:0o600});
console.log('Configured the existing store-ledger-private D1 database.');
