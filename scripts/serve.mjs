import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import worker from '../dist/server/index.js';
mkdirSync('.local',{recursive:true});
const sqlite=new DatabaseSync('.local/reshis.sqlite');sqlite.exec('PRAGMA foreign_keys=ON;');
sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations (tag TEXT PRIMARY KEY);');
if(!sqlite.prepare('SELECT tag FROM local_migrations WHERE tag=?').get('0000_initial')){
  sqlite.exec(readFileSync('drizzle/0000_initial.sql','utf8'));sqlite.prepare('INSERT INTO local_migrations VALUES(?)').run('0000_initial');
}
function statement(sql,args=[]){return {bind(...values){return statement(sql,values);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return sqlite.prepare(sql).run(...args);}};}
const DB={prepare:sql=>statement(sql),async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const q of statements)results.push(await q.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
const port=Number(process.env.PORT||8765);
const server=http.createServer(async(req,res)=>{try{
  const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>16384){res.writeHead(413);res.end();return;}chunks.push(c);}
  const request=new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
  const response=await worker.fetch(request,{DB});
  if(req.url==='/api/health'&&process.env.RESHIS_PREVIEW_INSTANCE)res.setHeader('X-Reshis-Preview-Instance',process.env.RESHIS_PREVIEW_INSTANCE);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch(error){console.error(error.message);res.writeHead(500);res.end('Server error');}}).listen(port,'127.0.0.1',()=>console.log(`Решись Авиа: http://127.0.0.1:${port}`));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>{sqlite.close();process.exit(0);}));
