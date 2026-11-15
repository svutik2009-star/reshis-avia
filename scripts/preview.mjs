import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';

const root=fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.env.PORT||8766);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT должен быть целым числом от 1 до 65535.');
const url=`http://127.0.0.1:${port}`;
const local=join(root,'.local'),metadataFile=join(local,`preview-${port}.json`),logFile=join(local,`preview-${port}.log`);
const command=process.argv[2]||'start';

async function health(){
  try{
    const response=await fetch(url+'/api/health',{signal:AbortSignal.timeout(700)});
    const body=await response.json();
    if(response.ok&&body.status==='ok'&&body.rows===155)return {instance:response.headers.get('X-Reshis-Preview-Instance')};
  }catch{}
  return null;
}
function metadata(){try{return JSON.parse(readFileSync(metadataFile,'utf8'));}catch{return null;}}

async function start(){
  if(await health()){console.log(`Приложение уже запущено: ${url}`);return;}
  mkdirSync(local,{recursive:true});
  const instance=randomUUID(),log=openSync(logFile,'a',0o600);
  let child,error;
  try{
    child=spawn(process.execPath,[join(root,'scripts/serve.mjs')],{
      cwd:root,env:{...process.env,PORT:String(port),RESHIS_PREVIEW_INSTANCE:instance},
      detached:true,stdio:['ignore',log,log],windowsHide:true
    });
    child.on('error',cause=>{error=cause;});
    // The server has its own process group and file-backed streams. It survives
    // the launcher and the interactive tool session that invoked the launcher.
    child.unref();
  }finally{closeSync(log);}
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
    if(error)throw error;
    if(child.exitCode!==null)throw Error(`Сервер завершился при запуске. Подробности: ${logFile}`);
    if((await health())?.instance===instance){
      writeFileSync(metadataFile,JSON.stringify({pid:child.pid,instance,port,url},null,2)+'\n',{mode:0o600});
      console.log(`Решись Авиа: ${url}\nСамостоятельный процесс: ${child.pid}`);return;
    }
    await pause(100);
  }
  child.kill('SIGTERM');
  throw Error(`Сервер не запустился на порту ${port}. Подробности: ${logFile}`);
}

async function stop(){
  const current=await health(),owned=metadata();
  if(!current){console.log(`Сервер на порту ${port} уже остановлен.`);return;}
  // Never signal a foreign server or a reused PID from stale metadata.
  if(!owned||!Number.isSafeInteger(owned.pid)||owned.pid<=0||!owned.instance||current.instance!==owned.instance){
    throw Error('Этот сервер запущен другим способом. Остановите его в исходном терминале.');
  }
  process.kill(owned.pid,'SIGTERM');
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    if((await health())?.instance!==owned.instance){
      if(metadata()?.instance===owned.instance)rmSync(metadataFile,{force:true});
      console.log(`Сервер на порту ${port} остановлен.`);return;
    }
    await pause(100);
  }
  throw Error('Сервер ещё завершает текущие запросы. Повторите проверку состояния.');
}

try{
  if(command==='start')await start();
  else if(command==='stop')await stop();
  else if(command==='restart'){await stop();await start();}
  else if(command==='status'){
    const running=await health();console.log(running?`Работает: ${url}`:`Остановлен: ${url}`);if(!running)process.exitCode=1;
  }else throw Error('Команды: start, restart, stop, status.');
}catch(error){console.error(error.message);process.exitCode=1;}
