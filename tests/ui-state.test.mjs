import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the actual request/action functions with deferred HTTP responses.
// Layout and full DOM rendering are checked separately in a real browser.
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function slice(start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert(a>=0&&b>a,`UI test anchor: ${start}`);return source.slice(a,b);
}
function harness(){
  const nodes=new Map(),pending=[],renders=[];
  const get=id=>{if(!nodes.has(id))nodes.set(id,{value:'',disabled:false,hidden:false,textContent:'',attrs:{},setAttribute(key,value){this.attrs[key]=value;},reportValidity(){return true;}});return nodes.get(id);};
  const buttons=[get('median-apply'),get('apply-low-price')];
  const context=vm.createContext({Intl,Number,Error,console,renders,document:{getElementById:get,querySelectorAll:()=>buttons},fetch:(url,options)=>new Promise((resolve,reject)=>pending.push({url,input:JSON.parse(options.body),resolve,reject}))});
  const prelude=slice('const $=','// Switch off');
  const shared=slice('// Switch off','function toast(');
  const invalidate=slice('function invalidate(){','function drawChart(');
  const calculate=slice('async function calculate(){','function setUser(');
  vm.runInContext(prelude+shared+invalidate+calculate+`
    function render(result){renders.push(result);lastResult=result;calculationFresh=true;$('save-scenario').disabled=false;}
    catalog={};activeRoute={route:'MOW-AER',price_min:5400,price_max:18000};
  `,context);
  get('price').value='9000';get('date').value='2026-06-12';
  const run=code=>vm.runInContext(code,context);
  const success=(index,overrides={})=>pending[index].resolve(Response.json({...pending[index].input,...overrides}));
  return {get,buttons,pending,renders,run,success};
}

test('Запоздавший ответ не перезаписывает более новый расчёт',async()=>{
  const h=harness(),old=h.run('calculate()');
  h.get('price').value='10000';h.run('invalidate()');const recent=h.run('calculate()');
  h.success(1);await recent;assert.equal(h.renders[0].price,10000);
  h.success(0);await old;
  assert.deepEqual(h.renders.map(r=>r.price),[10000]);
  assert.equal(h.run('isFreshResult()'),true);
});

test('Старый finally не активирует кнопки во время нового запроса',async()=>{
  const h=harness(),old=h.run('calculate()');
  h.get('price').value='11000';h.run('invalidate()');const recent=h.run('calculate()');
  h.success(0);await old;
  assert.equal(h.renders.length,0);assert.equal(h.get('calculate').disabled,true);
  assert.equal(h.get('results-card').attrs['aria-busy'],'true');
  assert.equal(h.get('save-scenario').disabled,true);assert(h.buttons.every(b=>b.disabled));
  h.success(1);await recent;assert.equal(h.get('calculate').disabled,false);
});

test('Смена маршрута без прогноза отменяет старый результат',async()=>{
  const h=harness(),old=h.run('calculate()');h.run('activeRoute=null;invalidate()');
  h.success(0);await old;
  assert.equal(h.renders.length,0);assert.equal(h.get('stress-card').hidden,true);
  assert.equal(h.get('calculate').disabled,true);assert.equal(h.run('isFreshResult()'),false);
});

test('Сеть, HTTP 500 и некорректный JSON оставляют действия выключенными',async()=>{
  for(const failure of ['network','http','json']){
    const h=harness(),request=h.run('calculate()');
    if(failure==='network')h.pending[0].reject(Error('Нет соединения'));
    if(failure==='http')h.pending[0].resolve(Response.json({error:'Сбой сервера'},{status:500}));
    if(failure==='json')h.pending[0].resolve(new Response('not json'));
    await request;
    assert.equal(h.renders.length,0);assert.equal(h.get('form-error').hidden,false);
    if(failure==='network')assert.match(h.get('form-error').textContent,/Нет связи с сервером/);
    assert.equal(h.get('result-status').textContent,'Расчёт недоступен');
    assert.equal(h.get('stress-content').hidden,true);assert(h.buttons.every(b=>b.disabled));
    assert.equal(h.get('save-scenario').disabled,true);assert.equal(h.get('calculate').disabled,false);
  }
});

test('Чужой ответ и изменение формы без события не принимаются',async()=>{
  const h=harness(),request=h.run('calculate()');h.success(0,{route:'MOW-LED'});await request;
  assert.equal(h.renders.length,0);assert.match(h.get('form-error').textContent,/других параметров/);
  const other=harness(),pending=other.run('calculate()');other.get('price').value='12345';other.success(0);await pending;
  assert.equal(other.renders.length,0);assert.equal(other.run('isFreshResult()'),false);
});

test('Старая рекомендация не применяется; свежая запускает общий расчёт',async()=>{
  const h=harness();h.run("lastResult={route:'MOW-AER',date:'2026-06-12',price:9000};calculationFresh=true");
  h.get('price').value='10000';h.run('applyRecommendedPrice(lastResult,7925)');assert.equal(h.pending.length,0);
  h.get('price').value='9000';h.run('applyRecommendedPrice(lastResult,7925)');
  assert.equal(h.pending.length,1);assert.equal(h.pending[0].input.price,7925);
  assert.equal(h.get('price-range').value,7925);assert.equal(h.run('isFreshResult()'),false);
  h.success(0);
});

test('Старый backend без stressTest не ломает новую карточку',()=>{
  const h=harness();h.run('renderStressTest({scenarios:[]})');assert.equal(h.get('stress-card').hidden,true);
  h.run('renderStressTest({stressTest:{version:2},scenarios:[]})');assert.equal(h.get('stress-card').hidden,true);
});

test('Ползунок точно отражает готовый тариф и цену вне рекомендованного диапазона',()=>{
  const h=harness();h.run('syncPriceRange(7925)');assert.equal(h.get('price-range').value,7925);
  h.run('syncPriceRange(0)');assert.equal(h.get('price-range').min,0);assert.equal(h.get('price-range').value,0);
  h.run('syncPriceRange(1000000)');assert.equal(h.get('price-range').max,1000000);assert.equal(h.get('price-range').value,1000000);
  h.run('syncPriceRange(9000)');assert.equal(h.get('price-range').min,5400);assert.equal(h.get('price-range').max,18000);
});
