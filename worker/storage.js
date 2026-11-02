/* Each immutable revision is chunked below D1's single-value size limit.
 * The CAS and all revision writes run in one D1 batch transaction. */
const KEY='main-v2',CHUNK_CHARS=64000,MAX_HISTORY=10;
export async function listDocumentHistory(db){
 const rows=await db.prepare('SELECT version,updated_at FROM ledger_document_history WHERE ledger_key=? ORDER BY version DESC LIMIT 10').bind(KEY).all();
 return rows.results.map(row=>({version:row.version,updatedAt:row.updated_at}));
}
export async function readDocumentVersion(db,version){
 if(!Number.isSafeInteger(version)||version<1)return null;
 const row=await db.prepare('SELECT version,revision,chunk_count,updated_at FROM ledger_document_history WHERE ledger_key=? AND version=?').bind(KEY,version).first();
 if(!row)return null;
 const rows=await db.prepare('SELECT part,content FROM ledger_document_chunks WHERE ledger_key=? AND revision=? ORDER BY part').bind(KEY,row.revision).all();
 if(rows.results.length!==row.chunk_count)return null;
 return {version:row.version,updatedAt:row.updated_at,data:JSON.parse(rows.results.map(x=>x.content).join(''))};
}
export async function readDocument(db){
 // Retry if a concurrent writer pruned the revision between the two reads.
 for(let attempt=0;attempt<2;attempt++){
  const row=await db.prepare('SELECT version,revision,chunk_count,updated_at FROM ledger_documents WHERE ledger_key=?').bind(KEY).first();
  if(!row)throw Error('V2 schema missing');
  if(!row.revision)return {version:row.version,updatedAt:row.updated_at,data:null};
  const rows=await db.prepare('SELECT part,content FROM ledger_document_chunks WHERE ledger_key=? AND revision=? ORDER BY part').bind(KEY,row.revision).all();
  if(rows.results.length!==row.chunk_count)continue;
  return {version:row.version,updatedAt:row.updated_at,data:JSON.parse(rows.results.map(x=>x.content).join(''))};
 }
 throw Error('Incomplete saved revision');
}
export async function writeDocument(db,version,data,{audits=[]}={}){
 const content=JSON.stringify(data),revision=crypto.randomUUID(),chunks=[];
 for(let at=0;at<content.length;){
  let end=Math.min(at+CHUNK_CHARS,content.length);
  const last=content.charCodeAt(end-1);if(last>=0xd800&&last<=0xdbff)end--;
  chunks.push(content.slice(at,end));at=end;
 }
 const statements=[db.prepare("UPDATE ledger_documents SET version=version+1,revision=?,chunk_count=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ledger_key=? AND version=?").bind(revision,chunks.length,KEY,version)];
 chunks.forEach((part,i)=>statements.push(db.prepare('INSERT INTO ledger_document_chunks(ledger_key,revision,part,content) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM ledger_documents WHERE ledger_key=? AND revision=?)').bind(KEY,revision,i,part,KEY,revision)));
 statements.push(db.prepare('INSERT INTO ledger_document_history(ledger_key,version,revision,chunk_count,updated_at) SELECT ledger_key,version,revision,chunk_count,updated_at FROM ledger_documents WHERE ledger_key=? AND revision=?').bind(KEY,revision));
 for(const a of audits)statements.push(db.prepare('INSERT INTO management_changes(id,actor,kind,target_id,before_json,after_json,identity_json,reason,version_before,version_after,created_at,undo_of) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM ledger_documents WHERE ledger_key=? AND revision=?)').bind(a.id,a.actor,a.kind,a.targetId,JSON.stringify(a.before),JSON.stringify(a.after),JSON.stringify(a.identity),a.reason,version,version+1,a.at,a.undoOf||null,KEY,revision));
 statements.push(db.prepare('DELETE FROM ledger_document_history WHERE ledger_key=? AND version < ? AND EXISTS (SELECT 1 FROM ledger_documents WHERE ledger_key=? AND revision=?)').bind(KEY,version+2-MAX_HISTORY,KEY,revision));
 statements.push(db.prepare('DELETE FROM ledger_document_chunks WHERE ledger_key=? AND revision NOT IN (SELECT revision FROM ledger_document_history WHERE ledger_key=?) AND EXISTS (SELECT 1 FROM ledger_documents WHERE ledger_key=? AND revision=?)').bind(KEY,KEY,KEY,revision));
 const result=await db.batch(statements);
 if(result[0].meta.changes!==1){
  const row=await db.prepare('SELECT version FROM ledger_documents WHERE ledger_key=?').bind(KEY).first();
  return {conflict:true,error:'Version conflict',serverVersion:row?.version};
 }
 return {ok:true,version:version+1};
}
