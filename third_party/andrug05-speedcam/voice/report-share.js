'use strict';
// Temporary, read-only, single-snapshot HTTP export. No filesystem routes.
const http=require('http'),crypto=require('crypto');
const {ReportNetwork,addresses,IFACE,PORT}=require('./report-network');
class ReportShare {
 constructor(collect,options){
  this.collect=collect;this.o=options||{};this.session=null;this.pending=false;this.generation=0;this.error=null;
  this.network=this.o.network||(this.o.simulated?{close:()=>Promise.resolve(),ensure:()=>Promise.resolve()}:new ReportNetwork());
 }
 initialize(){return this.network.close();}
 quietStop(reason){this.error=reason||null;this.stop().catch(()=>{});}
 status(){
  const s=this.session;
  if(s&&Date.now()>=s.expiresAt)this.quietStop('Срок ссылки истёк. Создайте новый отчёт.');
  const current=this.session;
  return {ok:true,reportShareProtocol:1,active:!!current,urls:current?current.urls:[],expiresAt:current?current.expiresAt:null,
   fileName:current?current.fileName:null,bytes:current?current.body.length:0,downloads:current?current.downloads:0,simulated:!!this.o.simulated,
   interface:this.o.simulated?'loopback':IFACE,firewall:current?(this.o.simulated?'simulated':'ready'):'closed',error:this.error};
 }
 async stop(){
  ++this.generation;const s=this.session;this.session=null;
  if(s)this.closeServer(s);
  try{await this.network.close();}catch(e){this.error='Сервер закрыт, но временное правило не удалено: '+e.message;throw Error(this.error);}
  return this.status();
 }
 closeServer(s){clearTimeout(s.timer);clearInterval(s.networkTimer);clearInterval(s.ruleTimer);s.server.close();s.sockets.forEach(socket=>socket.destroy());s.body=null;}
 checkNetwork(s){
  if(this.session!==s)return;
  try{const ips=(this.o.addresses||addresses)();if(ips.indexOf(s.ip)<0)this.quietStop('Адрес Wi-Fi-точки автомобиля изменился или исчез. Включите точку доступа и создайте новый отчёт.');}
  catch(e){this.quietStop('Не удалось проверить Wi-Fi-точку автомобиля: '+e.message);}
 }
 async start(request,live){
  if(this.pending)throw Error('Сбор отчёта уже выполняется.');
  this.pending=true;const closing=this.stop(),generation=this.generation;let s=null;
  const check=()=>{if(generation!==this.generation||(live&&!live()))throw Error('Передача отчёта отменена.');};
  try{
   await closing;check();this.error=null;
   const ips=(this.o.addresses||addresses)().filter(a=>/^\d{1,3}(\.\d{1,3}){3}$/.test(a));
   if(!ips.length)throw Error('Нет IPv4-адреса Wi-Fi-точки автомобиля (wlan_bridge). Включите точку доступа автомобиля и подключите к ней телефон.');
   const data=await this.collect(request),body=Buffer.from(JSON.stringify(data,null,2)+'\n','utf8');
   if(body.length>262144)throw Error('Диагностический отчёт слишком большой.');
   check();
   const token=crypto.randomBytes(16).toString('hex'),base='/r/'+token+'/';
   s={ip:ips[0],body,downloads:0,sockets:new Set(),fileName:'SpeedCAM-diagnostics-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'};
   s.server=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    const end=(code,text,type)=>{res.statusCode=code;res.setHeader('Content-Type',type||'text/plain; charset=utf-8');res.setHeader('Content-Length',Buffer.byteLength(text));res.end(req.method==='HEAD'?undefined:text);};
    if(this.session!==s||Date.now()>=s.expiresAt)return end(410,'Link expired');
    if(req.method!=='GET'&&req.method!=='HEAD'){res.setHeader('Allow','GET, HEAD');return end(405,'Read only');}
    if(req.url===base+'report.json'){
     res.setHeader('Content-Disposition','attachment; filename="'+s.fileName+'"');
     if(req.method==='GET')res.on('finish',()=>{s.downloads++;});
     return end(200,s.body,'application/json; charset=utf-8');
    }
    if(req.url!==base)return end(404,'Not found');
    return end(200,'<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SpeedCAM — отчёт</title><style>body{background:#080808;color:white;font:20px system-ui;max-width:580px;margin:60px auto;padding:24px}a{display:block;background:#cf2336;color:white;padding:22px;text-align:center;border-radius:8px}p{line-height:1.5}</style><h1>SpeedCAM</h1><h2>Диагностический отчёт</h2><p>'+(this.o.simulated?'Эмулятор: демонстрационные данные, не диагностика автомобиля.':'Снимок аудиодиагностики и GPS. Раздел GPS содержит координаты. Передайте скачанный JSON-файл для анализа.')+'</p><a href="'+base+'report.json" download>Скачать отчёт JSON</a><p>Ссылка временная. После отключения передачи в инженерном меню она перестанет работать.</p></html>','text/html; charset=utf-8');
   });
   s.server.timeout=5000;s.server.maxConnections=4;
   s.server.on('connection',socket=>{s.sockets.add(socket);socket.on('close',()=>s.sockets.delete(socket));});
   await new Promise((resolve,reject)=>{s.server.once('error',reject);s.server.listen(this.o.port!==undefined?this.o.port:this.o.simulated?0:PORT,s.ip,resolve);});
   check();await this.network.ensure(s.ip,s.server.address().port);check();
   s.server.on('error',e=>{if(this.session===s)this.quietStop('Ошибка сервера отчёта: '+e.message);});
   s.urls=['http://'+s.ip+':'+s.server.address().port+base];
   s.expiresAt=Date.now()+(this.o.ttlMs||600000);this.session=s;
   s.timer=setTimeout(()=>{if(this.session===s)this.quietStop('Срок ссылки истёк. Создайте новый отчёт.');},this.o.ttlMs||600000);s.timer.unref();
   s.networkTimer=setInterval(()=>this.checkNetwork(s),this.o.pollMs||5000);s.networkTimer.unref();
   s.ruleTimer=setInterval(()=>{
    if(s.checking||this.session!==s)return;s.checking=true;
    this.network.ensure(s.ip,s.server.address().port).catch(e=>{if(this.session===s)this.quietStop(e.message);}).then(()=>{s.checking=false;});
   },this.o.ruleMs||30000);s.ruleTimer.unref();
   return this.status();
  }catch(e){
   if(s)this.closeServer(s);
   this.error=e.code==='EADDRINUSE'?'Порт отчёта '+PORT+' занят. Отключите передачу отчёта и повторите.':e.message;
   try{await this.network.close();}catch(cleanup){this.error+='; '+cleanup.message;}
   throw Error(this.error);
  }finally{this.pending=false;}
 }
}
module.exports={ReportShare,addresses};
