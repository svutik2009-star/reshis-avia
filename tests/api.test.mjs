import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import worker,{calculate} from '../dist/server/index.js';

function adapter(sqlite){
  const prepare=(sql,args=[])=>({bind(...values){return prepare(sql,values);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return sqlite.prepare(sql).run(...args);}});
  return {prepare,async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
}
async function call(path,body,cookie,db,origin){
  const headers={...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{})};
  const response=await worker.fetch(new Request('https://avia.test'+path,{method:body!==undefined?'POST':'GET',headers,...(body!==undefined?{body:JSON.stringify(body)}:{})}),{DB:db});
  return {response,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
}
test('Все 155 рейсов: формула, базовая цена, нулевой спрос и ограничение кресел',async()=>{
  const {data:catalog}=await call('/api/catalog');assert.equal(catalog.flights.length,155);assert.equal(catalog.dates.length,31);
  for(const f of catalog.flights){
    const route=catalog.routes.find(r=>r.route===f.route);
    for(const price of [0,route.base_price,route.price_max,1000000]){
      const r=calculate({...f,price});
      const independent=Math.min(r.seats,Math.max(0,r.baseDemand-route.price_sensitivity*(price-route.base_price)));
      assert.equal(r.sales,independent);assert(r.sales>=0&&r.sales<=r.seats);assert.equal(r.scenarios[4].demand,r.wishes);
      if(price===0)assert.equal(r.sales,r.seats);
      if(price===1000000)assert.equal(r.sales,0);
    }
  }
  const june12=calculate({route:'MOW-AER',date:'2026-06-12',price:9000});assert.equal(june12.seats,900);assert.equal(june12.sales,801);
  assert.equal(calculate({route:'MOW-AER',date:'2026-06-12',price:9440}).sales,738.96);
});
test('API отклоняет неизвестный рейс, некорректные цены и чужой Origin',async()=>{
  for(const price of [-1,null,'9000',true,1000001])assert.equal((await call('/api/calculate',{route:'MOW-AER',date:'2026-06-12',price})).response.status,400);
  assert.equal((await call('/api/calculate',{route:'AER-MOW',date:'2026-06-12',price:9000})).response.status,404);
  assert.equal((await call('/api/calculate',{route:'MOW-AER',date:'2026-07-02',price:9000})).response.status,404);
  assert.equal((await call('/api/calculate',{route:'MOW-AER',date:'2026-06-12',price:9000},null,null,'https://another.test')).response.status,403);
});
test('Регистрация, защита паролей, изоляция истории, выход и сохранность после перезапуска',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'reshis-test-')),file=join(folder,'test.sqlite');let sqlite=new DatabaseSync(file);sqlite.exec(readFileSync('drizzle/0000_initial.sql','utf8'));let db=adapter(sqlite);
  try{
    assert.equal((await call('/api/history',undefined,null,db)).response.status,401);
    const a=await call('/api/register',{username:'review_a',password:'Independent-Test-2026'},null,db);assert.equal(a.response.status,201);assert.match(a.response.headers.get('Set-Cookie'),/HttpOnly; SameSite=Strict/);assert.match(a.response.headers.get('Set-Cookie'),/Secure/);
    const stored=sqlite.prepare('SELECT password_hash,salt FROM users WHERE username=?').get('review_a');assert.notEqual(stored.password_hash,'Independent-Test-2026');assert.equal(stored.password_hash.length,64);assert.equal(stored.salt.length,32);
    assert.equal((await call('/api/register',{username:'REVIEW_A',password:'Independent-Test-2026'},null,db)).response.status,409);
    assert.equal((await call('/api/login',{username:'review_a',password:'wrong-password'},null,db)).response.status,401);
    assert.equal((await call('/api/login',{username:'review_a',password:'Independent-Test-2026'},null,db)).response.status,200);
    assert.equal((await call('/api/history',{route:'MOW-AER',date:'2026-06-12',price:9000},a.cookie,db)).response.status,201);
    const applied=calculate({route:'MOW-AER',date:'2026-06-12',price:9000}).stressTest.strategies.lowDemand.price;
    assert.equal((await call('/api/history',{route:'MOW-AER',date:'2026-06-12',price:applied},a.cookie,db)).response.status,201);
    assert.equal((await call('/api/history',undefined,a.cookie,db)).data.items.length,2);
    const b=await call('/api/register',{username:'review_b',password:'Another-Test-2026'},null,db);assert.equal((await call('/api/history',undefined,b.cookie,db)).data.items.length,0);
    sqlite.close();sqlite=new DatabaseSync(file);db=adapter(sqlite);
    assert.equal((await call('/api/me',undefined,a.cookie,db)).data.user.username,'review_a');
    const restored=(await call('/api/history',undefined,a.cookie,db)).data.items;
    assert.equal(restored.length,2);assert(restored.some(item=>item.price===7925));
    await call('/api/logout',{},a.cookie,db);assert.equal((await call('/api/me',undefined,a.cookie,db)).data.user,null);
    assert.equal((await call('/api/history',undefined,a.cookie,db)).response.status,401);
  }finally{sqlite.close();rmSync(folder,{recursive:true,force:true});}
});
