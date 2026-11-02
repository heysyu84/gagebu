import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../worker/index.js';
const template=readFileSync(new URL('../wrangler.toml.example',import.meta.url),'utf8');
const origins=template.match(/^ALLOWED_ORIGINS = "([^"]+)"$/m)?.[1];
const site="https://gagebu-money-desk.heysyu457310.chatgpt.site",api='https://store-ledger-private-api.heysyu84.workers.dev';
test('Sites CORS allows the registered host without bypassing ledger authentication',async()=>{
 assert(origins?.split(',').includes(site));
 const env={ALLOWED_ORIGINS:origins,DB:{},ADMIN_PASSWORD:'test-only',SESSION_PEPPER:'test-only'};
 for(const origin of origins.split(',')){
  const response=await worker.fetch(new Request(api+'/api/login',{method:'OPTIONS',headers:{Origin:origin}}),env);
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);
 }
 const unauthorized=await worker.fetch(new Request(api+'/api/v2/state',{headers:{Origin:site}}),env);
 assert.equal(unauthorized.status,401);assert.equal(unauthorized.headers.get('access-control-allow-origin'),site);
 for(const origin of [site+'.evil.example','https://unapproved.chatgpt.site']){
  const response=await worker.fetch(new Request(api+'/api/login',{method:'OPTIONS',headers:{Origin:origin}}),env);
  assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
 }
});
