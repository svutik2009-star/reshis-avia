import PAGE from './page.generated.js';
import DATA from './data.generated.js';

const encoder = new TextEncoder();
const quantiles = Array.from({length:9}, (_,i)=>(i+1)/10);
const stressQuantiles = [0.1,0.5,0.9];
const flights = new Map(DATA.forecast.map(row=>[`${row.route}|${row.date}`,row]));
const routes = new Map(DATA.routes.map(row=>[row.route,row]));
const baseHeaders = {'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'};
const json = (value,status=200,headers={})=>new Response(JSON.stringify(value), {status,headers:{...baseHeaders,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
class ApiError extends Error { constructor(status,message){ super(message);this.status=status; } }
function assert(condition,status,message){if(!condition)throw new ApiError(status,message);}
export function evaluateScenario(row,info,price,q){
  const demand=Math.max(0,row[`${q}_base_demand`]-info.price_sensitivity*(price-info.base_price));
  const sales=Math.min(row.seats,demand);
  return {q,demand,sales,loadFactor:sales/row.seats,unsold:row.seats-sales,revenue:price*sales,contribution:sales===0?0:(price-info.cost_per_passenger)*sales};
}
export function buildStressTest(row,info){
  const strategy=price=>({price,scenarios:stressQuantiles.map(q=>evaluateScenario(row,info,price,q))});
  const median=strategy(row['0.5_price']),lowDemand=strategy(row['0.1_price']);
  return {
    version:1,priceSource:'forecast_csv',selectedQuantiles:stressQuantiles,
    strategies:{median,lowDemand},
    deltas:{
      gainLow:lowDemand.scenarios[0].contribution-median.scenarios[0].contribution,
      medianSacrifice:median.scenarios[1].contribution-lowDemand.scenarios[1].contribution
    }
  };
}
export function calculate(input){
  assert(input && typeof input==='object',400,'Ожидается объект с параметрами рейса.');
  const {route,date,price}=input;
  assert(typeof price==='number' && Number.isFinite(price) && price>=0 && price<=1000000,400,'Введите цену от 0 до 1 000 000 ₽.');
  assert(typeof route==='string' && typeof date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(date),400,'Укажите маршрут и дату.');
  const row=flights.get(`${route}|${date}`), info=routes.get(route);
  assert(row && info,404,'На эту дату нет прогноза для выбранного маршрута.');
  const rawWishes=row['0.5_base_demand']-info.price_sensitivity*(price-info.base_price);
  const scenarios=quantiles.map(q=>evaluateScenario(row,info,price,q)),median=scenarios[4];
  return {route,date,price,name:info.name,seats:row.seats,baseDemand:row['0.5_base_demand'],basePrice:info.base_price,sensitivity:info.price_sensitivity,costPerPassenger:info.cost_per_passenger,rawWishes,wishes:median.demand,sales:median.sales,loadFactor:median.loadFactor,unsold:median.unsold,revenue:median.revenue,contribution:median.contribution,optimalPrice:row['0.5_price'],priceMin:info.price_min,priceMax:info.price_max,outsideRecommendedRange:price<info.price_min || price>info.price_max,scenarios,stressTest:buildStressTest(row,info),source:DATA.metrics};
}
const hex = bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const random = n=>hex(crypto.getRandomValues(new Uint8Array(n)));
const digest = async text=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))));
async function passwordHash(password,salt){
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256)));
}
function equal(a,b){let mismatch=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)mismatch|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return mismatch===0;}
function cookie(request,value,maxAge=604800){return `reshis_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
function sessionToken(request){return /(?:^|;\s*)reshis_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie')||'')?.[1];}
async function userFor(request,db){
  const token=sessionToken(request);if(!token)return null;
  return await db.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await digest(token),Date.now()).first();
}
async function parseBody(request){
  assert((request.headers.get('Content-Type')||'').includes('application/json'),415,'Отправьте данные в JSON.');
  const text=await request.text();assert(text.length<=8192,413,'Слишком большой запрос.');
  try{return JSON.parse(text);}catch{throw new ApiError(400,'Некорректный JSON.');}
}
async function auth(request,env,action){
  assert(env.DB,503,'Сервис входа временно недоступен.');
  const {username,password}=await parseBody(request);
  assert(typeof username==='string' && /^[a-zA-Z0-9_\-]{3,24}$/.test(username),400,'Логин: 3–24 латинских буквы, цифры, дефис или подчёркивание.');
  assert(typeof password==='string' && password.length>=8 && password.length<=128,400,'Пароль должен содержать от 8 до 128 символов.');
  const canonical=username.toLowerCase();
  const limit=await env.DB.prepare('SELECT failures,window_start FROM auth_limits WHERE username=?').bind(canonical).first();
  assert(!limit || Date.now()-limit.window_start>600000 || limit.failures<20,429,'Слишком много попыток. Повторите через 10 минут.');
  let user=await env.DB.prepare('SELECT id,username,password_hash,salt FROM users WHERE username=?').bind(canonical).first();
  if(action==='register'){
    assert(!user,409,'Этот логин уже занят.');
    const salt=random(16), hash=await passwordHash(password,salt), id=random(16);
    try{await env.DB.prepare('INSERT INTO users(id,username,password_hash,salt,created_at) VALUES(?,?,?,?,?)').bind(id,canonical,hash,salt,Date.now()).run();}
    catch(error){if(String(error).includes('UNIQUE'))throw new ApiError(409,'Этот логин уже занят.');throw error;}
    user={id,username:canonical};
  }else{
    const hash=await passwordHash(password,user?.salt||'00000000000000000000000000000000');
    if(!user || !equal(hash,user.password_hash)){
      await env.DB.prepare('INSERT INTO auth_limits(username,failures,window_start) VALUES(?,1,?) ON CONFLICT(username) DO UPDATE SET failures=CASE WHEN window_start<? THEN 1 ELSE failures+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END').bind(canonical,Date.now(),Date.now()-600000,Date.now()-600000).run();
      throw new ApiError(401,'Неверный логин или пароль.');
    }
  }
  const token=random(32),tokenHash=await digest(token);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_limits WHERE username=?').bind(canonical),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(tokenHash,user.id,Date.now()+604800000)
  ]);
  return json({user:{username:user.username}},action==='register'?201:200,{'Set-Cookie':cookie(request,token)});
}
export default {async fetch(request,env={},ctx={}){
  try{
    const url=new URL(request.url),path=url.pathname;
    if(request.method==='GET' && path==='/')return new Response(PAGE,{headers:{...baseHeaders,'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"}});
    if(path==='/favicon.svg')return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#ffdd2d"/><path d="m12 34 40-18-15 36-7-15-18-3Z" fill="#222"/></svg>',{headers:{'Content-Type':'image/svg+xml'}});
    if(path==='/api/catalog' && request.method==='GET')return json({routes:DATA.routes,dates:[...new Set(DATA.forecast.map(r=>r.date))].sort(),metrics:DATA.metrics,flights:DATA.forecast.map(({route,date})=>({route,date}))});
    if(path==='/api/health')return json({status:'ok',rows:flights.size,database:Boolean(env.DB),model:DATA.metrics.model});
    if(path.startsWith('/api/') && request.method==='POST'){
      const origin=request.headers.get('Origin');assert(!origin||origin===url.origin,403,'Источник запроса не разрешён.');
      if(path==='/api/calculate')return json(calculate(await parseBody(request)));
      if(path==='/api/register'||path==='/api/login')return await auth(request,env,path.slice(5));
      if(path==='/api/logout'){
        const token=sessionToken(request);if(token&&env.DB)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
        return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)});
      }
      if(path==='/api/history'){
        const user=env.DB?await userFor(request,env.DB):null;assert(user,401,'Войдите, чтобы сохранить расчёт.');
        const result=calculate(await parseBody(request));
        await env.DB.prepare('INSERT INTO scenarios(id,user_id,route,date,price,created_at) VALUES(?,?,?,?,?,?)').bind(random(16),user.id,result.route,result.date,result.price,Date.now()).run();
        return json({ok:true},201);
      }
    }
    if(path==='/api/me' && request.method==='GET')return json({user:env.DB?await userFor(request,env.DB):null});
    if(path==='/api/history' && request.method==='GET'){
      const user=env.DB?await userFor(request,env.DB):null;assert(user,401,'Войдите, чтобы увидеть сохранённые расчёты.');
      const result=await env.DB.prepare('SELECT route,date,price,created_at FROM scenarios WHERE user_id=? ORDER BY created_at DESC LIMIT 8').bind(user.id).all();
      return json({items:result.results});
    }
    if(path==='/api/forecast.csv' && request.method==='GET'){
      const columns=Object.keys(DATA.forecast[0]);
      const csv=columns.join(',')+'\n'+DATA.forecast.map(r=>columns.map(c=>r[c]).join(',')).join('\n')+'\n';
      return new Response(csv,{headers:{...baseHeaders,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="my_forecast.csv"'}});
    }
    return json({error:'Страница не найдена.'},404);
  }catch(error){if(error instanceof ApiError)return json({error:error.message},error.status);console.error('API request failed:',String(error));return json({error:'Ошибка сервера. Повторите запрос позже.'},500);}
}};
