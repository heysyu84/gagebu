import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export class TestD1{
 constructor(){this.sql=new DatabaseSync(':memory:');this.sql.exec(readFileSync(new URL('../../db/schema.sql',import.meta.url),'utf8'))}
 prepare(query){const db=this.sql;let params=[];return {bind(...values){params=values;return this},async first(){return db.prepare(query).get(...params)??null},async all(){return {results:db.prepare(query).all(...params)}},async run(){const r=db.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}}}}}
 async batch(statements){this.sql.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());this.sql.exec('COMMIT');return result}catch(error){this.sql.exec('ROLLBACK');throw error}}
}
