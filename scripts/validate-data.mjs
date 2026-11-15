// This tournament dataset has a fixed horizon and five outbound routes.
export function validateData(data){
  const fail=message=>{throw new Error('Некорректные данные прогноза: '+message);};
  const finite=(value,label)=>{if(typeof value!=='number'||!Number.isFinite(value))fail(label+' должно быть конечным числом.');};
  if(!Array.isArray(data?.routes)||data.routes.length!==5)fail('ожидалось 5 маршрутов.');
  if(!Array.isArray(data.forecast)||data.forecast.length!==155)fail('ожидалось 155 строк.');
  const routes=new Map();
  for(const info of data.routes){
    if(typeof info.route!=='string'||!/^MOW-[A-Z]{3}$/.test(info.route)||routes.has(info.route))fail('неверный или повторный маршрут.');
    if(typeof info.name!=='string'||!info.name.trim())fail('отсутствует название маршрута.');
    for(const key of ['base_price','cost_per_passenger','price_sensitivity','price_min','price_max'])finite(info[key],info.route+' / '+key);
    if(info.price_sensitivity<=0||info.cost_per_passenger<0)fail(info.route+': чувствительность должна быть положительной, затраты неотрицательными.');
    if(info.price_min<0||info.price_max>1000000||info.price_min>info.price_max||info.base_price<info.price_min||info.base_price>info.price_max)fail(info.route+': неверные границы цены.');
    routes.set(info.route,info);
  }
  const dates=new Set(Array.from({length:31},(_,i)=>new Date(Date.UTC(2026,5,1+i)).toISOString().slice(0,10)));
  const pairs=new Set();
  for(const row of data.forecast){
    const info=routes.get(row.route),key=row.route+'|'+row.date;
    if(!info||!dates.has(row.date)||pairs.has(key))fail('неизвестная или повторная пара '+key+'.');
    pairs.add(key);
    if(!Number.isSafeInteger(row.seats)||row.seats<=0)fail(key+': вместимость должна быть положительным целым числом.');
    let previous=-Infinity;
    for(let i=1;i<=9;i++){
      const q=i/10,demand=row[`${q}_base_demand`],price=row[`${q}_price`],priceDemand=row[`${q}_price_demand`];
      for(const [label,value] of [['base_demand',demand],['price',price],['price_demand',priceDemand]])finite(value,key+' / '+q+'_'+label);
      if(demand<0||demand<previous)fail(key+': квантили спроса отрицательны или нарушен их порядок.');
      if(price<info.price_min||price>info.price_max||priceDemand<0)fail(key+': неверная цена или спрос при ней.');
      previous=demand;
    }
  }
  for(const route of routes.keys())for(const date of dates)if(!pairs.has(route+'|'+date))fail('пропущен рейс '+route+'|'+date+'.');
  return data;
}
