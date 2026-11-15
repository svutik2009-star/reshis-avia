import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker,{calculate,evaluateScenario,buildStressTest} from '../dist/server/index.js';
import {validateData} from '../scripts/validate-data.mjs';

const readCsv=file=>{
  const [header,...lines]=readFileSync(new URL('../data/'+file,import.meta.url),'utf8').trim().split(/\r?\n/);
  const keys=header.split(',');
  return lines.map(line=>Object.fromEntries(line.split(',').map((value,i)=>[keys[i],['route','date','name'].includes(keys[i])?value:Number(value)])));
};
const forecast=readCsv('my_forecast.csv'),routes=readCsv('routes.csv');
const routeMap=new Map(routes.map(r=>[r.route,r]));
const near=(actual,expected,label='')=>assert(Math.abs(actual-expected)<=1e-6,`${label}: ${actual} != ${expected}`);
const at=(scenarios,q)=>scenarios.find(s=>s.q===q);

test('155 рейсов: сценарии, деньги, единая медиана и две готовые цены',()=>{
  for(const row of forecast){
    const info=routeMap.get(row.route);
    for(const price of [0,info.cost_per_passenger,info.base_price,row['0.1_price'],row['0.5_price'],1000000]){
      const result=calculate({route:row.route,date:row.date,price});
      assert.equal(result.scenarios.length,9);
      for(const s of result.scenarios){
        // Independent linear form (intercept - slope * price).
        const demand=Math.max(0,(row[`${s.q}_base_demand`]+info.price_sensitivity*info.base_price)-info.price_sensitivity*price);
        const sold=demand>row.seats?row.seats:demand;
        near(s.demand,demand);near(s.sales,sold);near(s.unsold+sold,row.seats);
        near(s.revenue,price*sold);near(s.contribution,s.revenue-info.cost_per_passenger*sold);
        near(s.loadFactor,sold/row.seats);
        assert(s.sales>=0&&s.sales<=row.seats);
        for(const value of Object.values(s))assert(Number.isFinite(value));
      }
      const median=at(result.scenarios,.5);
      assert.equal(result.wishes,median.demand);
      for(const key of ['sales','loadFactor','unsold','revenue','contribution'])assert.equal(result[key],median[key]);
      assert.equal(result.optimalPrice,row['0.5_price']);
      assert.equal(result.rawWishes,row['0.5_base_demand']-info.price_sensitivity*(price-info.base_price));
      const stress=result.stressTest;
      assert.equal(stress.version,1);assert.equal(stress.priceSource,'forecast_csv');assert.deepEqual(stress.selectedQuantiles,[.1,.5,.9]);
      for(const [name,q] of [['median',.5],['lowDemand',.1]]){
        const strategy=stress.strategies[name];assert.equal(strategy.price,row[`${q}_price`]);
        assert(strategy.price>=info.price_min&&strategy.price<=info.price_max);
        assert.deepEqual(strategy.scenarios.map(s=>s.q),[.1,.5,.9]);
        const independentlyCalculated=calculate({route:row.route,date:row.date,price:strategy.price});
        for(const s of strategy.scenarios)assert.deepEqual(s,at(independentlyCalculated.scenarios,s.q));
      }
      const {median:m,lowDemand:l}=stress.strategies;
      near(stress.deltas.gainLow,at(l.scenarios,.1).contribution-at(m.scenarios,.1).contribution);
      near(stress.deltas.medianSacrifice,at(m.scenarios,.5).contribution-at(l.scenarios,.5).contribution);
    }
    assert.deepEqual(calculate({route:row.route,date:row.date,price:0}).stressTest,calculate({route:row.route,date:row.date,price:1000000}).stressTest);
  }
});

test('Числовой пример PDF: Москва - Сочи, 12 июня, три цены',()=>{
  const input={route:'MOW-AER',date:'2026-06-12',price:9000};
  const r=calculate(input);
  assert.deepEqual(r.scenarios.filter(s=>[.1,.5,.9].includes(s.q)).map(s=>[s.demand,s.sales,s.contribution]),[[374,374,1795200],[801,801,3844800],[1228,900,4320000]]);
  const {median,lowDemand}=r.stressTest.strategies;
  assert.equal(median.price,9440);assert.equal(lowDemand.price,7925);
  near(at(median.scenarios,.1).contribution,1634670.4);
  near(at(median.scenarios,.5).contribution,3872150.4);
  near(at(median.scenarios,.9).contribution,4716000);
  near(at(lowDemand.scenarios,.1).demand,525.575);
  near(at(lowDemand.scenarios,.1).contribution,1957766.875);
  near(at(lowDemand.scenarios,.5).demand,952.575);
  assert.equal(at(lowDemand.scenarios,.5).sales,900);
  near(r.stressTest.deltas.gainLow,323096.475);
  near(r.stressTest.deltas.medianSacrifice,519650.4);
  const applied=calculate({...input,price:lowDemand.price});
  assert.equal(applied.sales,900);assert.equal(applied.loadFactor,1);near(applied.wishes,952.575);
});

test('Москва - Петербург 12 июня: основной результат и применение тарифа слабого спроса',()=>{
  const input={route:'MOW-LED',date:'2026-06-12',price:5500};
  const result=calculate(input);
  assert.equal(result.seats,1440);assert.equal(result.sales,988);
  assert.equal(result.stressTest.strategies.median.price,5730);
  assert.equal(result.stressTest.strategies.lowDemand.price,4723);
  const applied=calculate({...input,price:4723});
  near(applied.sales,1216.438);
  assert.equal(at(applied.scenarios,.5).sales,applied.sales);
  assert.equal(applied.stressTest.version,1);
});

test('Границы спроса, цена ниже затрат, одинаковые тарифы и нулевые дельты',()=>{
  const info={base_price:100,cost_per_passenger:50,price_sensitivity:2};
  const row={seats:10,'0.1_base_demand':10,'0.5_base_demand':15,'0.9_base_demand':20,'0.1_price':100,'0.5_price':100};
  assert.equal(evaluateScenario(row,info,100,.1).sales,10);
  assert.equal(evaluateScenario(row,info,100,.5).demand,15);
  assert.equal(evaluateScenario(row,info,110,.1).sales,0);
  assert.equal(evaluateScenario(row,info,110,.1).contribution,0);
  assert.equal(evaluateScenario(row,info,50,.1).contribution,0);
  assert.equal(evaluateScenario(row,info,0,.1).contribution,-500);
  assert.deepEqual(buildStressTest(row,info).deltas,{gainLow:0,medianSacrifice:0});
  // Below cost, higher demand can increase losses rather than improve income.
  const negative={...row,seats:100,'0.1_base_demand':0,'0.9_base_demand':30};
  assert(evaluateScenario(negative,info,40,.9).contribution<=evaluateScenario(negative,info,40,.1).contribution);
  for(const price of [NaN,Infinity,-Infinity])assert.throws(()=>calculate({route:'MOW-AER',date:'2026-06-12',price}),error=>error.status===400);
});

test('При повышении цены спрос и продажи каждого квантиля не растут',()=>{
  for(const row of forecast){
    const info=routeMap.get(row.route),input={route:row.route,date:row.date};
    const before=calculate({...input,price:info.base_price}),after=calculate({...input,price:info.base_price+137});
    before.scenarios.forEach((s,i)=>{assert(after.scenarios[i].demand<=s.demand);assert(after.scenarios[i].sales<=s.sales);});
  }
});

test('Сборка отклоняет неполные и повреждённые данные, не исправляя их молча',()=>{
  const data={forecast,routes};const snapshot=structuredClone(data);validateData(data);assert.deepEqual(data,snapshot);
  const mutations=[
    x=>x.forecast.pop(),
    x=>{x.forecast[1]=structuredClone(x.forecast[0]);},
    x=>{x.forecast[0].date='2026-06-31';},
    x=>{x.forecast[0].seats=0;},
    x=>{x.forecast[0]['0.1_base_demand']=Infinity;},
    x=>{x.forecast[0]['0.1_base_demand']=x.forecast[0]['0.9_base_demand']+1;},
    x=>{delete x.forecast[0]['0.5_base_demand'];},
    x=>{x.forecast[0]['0.1_price']=-1;},
    x=>{x.routes[0].price_sensitivity=0;},
    x=>{x.routes[0].cost_per_passenger=-1;},
    x=>{x.routes[0].price_min=x.routes[0].price_max+1;},
    x=>{x.routes[1].route=x.routes[0].route;}
  ];
  for(const mutate of mutations){const broken=structuredClone(data);mutate(broken);assert.throws(()=>validateData(broken),/Некорректные данные прогноза/);}
});

test('API без БД сохраняет прежний контракт, график и исходный CSV',async()=>{
  const response=await worker.fetch(new Request('https://avia.test/api/calculate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({route:'MOW-AER',date:'2026-06-12',price:9000})}));
  assert.equal(response.status,200);const body=await response.json();
  for(const key of ['route','date','price','seats','baseDemand','basePrice','sensitivity','rawWishes','wishes','sales','loadFactor','unsold','revenue','contribution','optimalPrice','priceMin','priceMax','outsideRecommendedRange','scenarios','source'])assert(key in body,key);
  assert.equal(body.scenarios.length,9);assert.equal(body.stressTest.strategies.lowDemand.price,7925);
  const csvResponse=await worker.fetch(new Request('https://avia.test/api/forecast.csv'));
  assert.equal(await csvResponse.text(),readFileSync(new URL('../data/my_forecast.csv',import.meta.url),'utf8'));
});
