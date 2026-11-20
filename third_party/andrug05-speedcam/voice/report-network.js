'use strict';
// Local report access only. Never change a chain policy or other applications' rules.
const os=require('os'),cp=require('child_process');
const IFACE='wlan_bridge',PORT=8471,TAG='speedcam-report-share';
let queue=Promise.resolve();
function addresses(interfaces){
 return ((interfaces||os.networkInterfaces())[IFACE]||[])
  .filter(a=>!a.internal&&(a.family==='IPv4'||a.family===4))
  .map(a=>a.address).filter((a,i,all)=>validIP(a)&&all.indexOf(a)===i);
}
function validIP(a){return typeof a==='string'&&/^\d{1,3}(\.\d{1,3}){3}$/.test(a)&&a.split('.').every(n=>Number(n)<=255);}
function run(args){return new Promise((resolve,reject)=>{
 cp.execFile('nft',args,{timeout:5000,maxBuffer:262144},(e,out,err)=>{
  if(e)return reject(Error('Сетевой фильтр MGU: '+String(err||e.message).trim().slice(0,400)));
  resolve(out);
 });
});}
class ReportNetwork {
 constructor(options){this.run=options&&options.run||run;}
 queued(fn){const p=queue.then(fn,fn);queue=p.catch(()=>{});return p;}
 async rules(){
  const out=await this.run(['-a','list','chain','ip','filter','input']);
  return String(out).split('\n').filter(l=>l.indexOf('comment "'+TAG+'"')>=0).map(line=>{
   const m=/# handle (\d+)\s*$/.exec(line);if(!m)throw Error('Сетевой фильтр MGU: не найден номер временного правила.');
   return {line,handle:m[1]};
  });
 }
 async remove(){for(const r of await this.rules())await this.run(['delete','rule','ip','filter','input','handle',r.handle]);}
 close(){return this.queued(()=>this.remove());}
 ensure(ip,port){
  if(!validIP(ip)||!Number.isInteger(port)||port<1||port>65535)return Promise.reject(Error('Некорректный адрес отчёта.'));
  return this.queued(async()=>{
   const matches=r=>r.line.indexOf('iifname "'+IFACE+'"')>=0&&
    new RegExp('ip daddr '+ip.replace(/\./g,'\\.')+'(?:\\s|$)').test(r.line)&&
    new RegExp('tcp dport '+port+'(?:\\s|$)').test(r.line)&&/\baccept\b/.test(r.line);
   const current=await this.rules();if(current.length===1&&matches(current[0]))return;
   for(const r of current)await this.run(['delete','rule','ip','filter','input','handle',r.handle]);
   await this.run(['insert','rule','ip','filter','input','iifname','"'+IFACE+'"','ip','daddr',ip,'tcp','dport',String(port),'accept','comment','"'+TAG+'"']);
   const added=await this.rules();
   if(added.length!==1||!matches(added[0]))throw Error('Сетевой фильтр MGU: открытие порта не подтверждено.');
  });
 }
}
module.exports={ReportNetwork,addresses,IFACE,PORT,TAG};
// ExecStopPost also runs after an abnormal service exit. Only our tagged rule is removed.
if(require.main===module){
 if(process.argv[2]!=='cleanup'){process.exitCode=2;}else new ReportNetwork().close().catch(e=>{console.error(e.message);process.exitCode=1;});
}
