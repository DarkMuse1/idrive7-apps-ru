'use strict';
// Read-only inventory. Never acquire a route, instantiate a player or change volume.
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
const {readList}=require('./command-control');
const text=v=>String(v==null?'':v).slice(0,1000);
const fields=(v,keys)=>{const r={};keys.forEach(k=>{if(v&&v[k]!==undefined)r[k]=v[k];});return r;};
const io=(name,...args)=>new Promise((resolve,reject)=>fs[name](...args,(e,v)=>e?reject(e):resolve(v)));
async function attempt(fn){try{return {ok:true,value:await fn()};}catch(e){return {ok:false,error:text(e.message)};}}
function mountedUsb(raw,root){
 return raw.split('\n').map(line=>line.trim().split(/\s+/)).filter(f=>f.length>=4&&/^\/dev\//.test(f[0])&&f[3].split(',').includes('rw')).map(f=>f[1].replace(/\\([0-7]{3})/g,(_,n)=>String.fromCharCode(parseInt(n,8)))).filter((p,i,a)=>path.posix.dirname(p)===(root||'/media')&&a.indexOf(p)===i);
}
function helper(exec,bin,arg){return new Promise(resolve=>exec(bin,[arg],{timeout:3500,maxBuffer:32768},(err,out,stderr)=>{
 let result;try{result=JSON.parse(out);}catch(e){}
 resolve({ok:!err,exitCode:err?err.code:0,error:err?text(err.message):null,stderr:text(stderr),result:result||null});
}));}
async function smallFile(file){const stat=await io('stat',file);if(!stat.isFile()||stat.size>65536)throw Error('File omitted: not regular or larger than 64 KiB');return io('readFile',file,'utf8');}
function gpsSnapshot(value){
 if(!value)return {available:false,reason:'app_did_not_supply_gps_snapshot'};
 if(value.schema!==1||typeof value.capturedAt!=='string'||!value.decision||!Array.isArray(value.history))return {available:false,reason:'invalid_gps_snapshot'};
 const raw=JSON.stringify(value);
 if(Buffer.byteLength(raw)>24576)return {available:false,reason:'gps_snapshot_exceeds_24kib'};
 return JSON.parse(raw);
}
async function collect(d,request,options){
 const o=options||{},s=d.s,report={format:'SpeedCAM-audio-diagnostics',schema:2,createdAt:new Date().toISOString(),serviceVersion:o.serviceVersion||null,appVersion:text(request.appVersion),readOnly:true,audibilityTested:false,
  gps:gpsSnapshot(request.gps),
  mixerSettings:d.mix?d.mix.snapshot():null,
  beeperSound:d.beeperSounds?d.beeperSounds.snapshot():null,
  pulseAudio:s.pulseDiagnostics?JSON.parse(JSON.stringify(s.pulseDiagnostics)):null,
  musicDucking:s.musicDucker?s.musicDucker.snapshot():null,
  audioComparisons:JSON.parse(JSON.stringify(s.audioComparisons||[])),
  bufferDiagnostics:s.audioBufferHistory?JSON.parse(JSON.stringify(s.audioBufferHistory)):{schema:2,streams:[],total:0,lastFailure:null,note:'No instrumented ALSA/Converter stream since service start; M4A/FIFO not instrumented'},
  system:{platform:os.platform(),arch:os.arch(),kernel:os.release(),node:process.version},
  ui:{backend:['pulse','converter','converter-stable','converter-hold','converter-reset','converter-period','alsa','pcm','file'].includes(request.backend)?request.backend:null,overlay:request.overlay===true,lastMessage:text(request.lastMessage)},
  active:{backend:s.audioBackend,fileFallback:!!s.fileFallback,overlay:!!s.audioOverlay,sinkID:s.routeSinkId,lastError:text(s.lastError),inventoryError:text(s.inventoryError)},
  saved:fields(d.saved,['backend','overlay','sinkID','sourceID','confirmedAt']),
  previousDiscovery:d.alsa.lastOverlayDiscovery||null,
  lastAlsaProbe:fields(d.alsa.last,['at','kind','ok','error','audibleConfirmed']),
  lastOverlayProbe:fields(d.overlay&&d.overlay.last,['at','backend','kind','sourceID','sinkID','accepted','error','cleanupError','carplayRoutePreserved','routeInterruptionObserved','outputMechanism','probeProfile','stream']),
  lastConverterProbe:d.overlay&&d.overlay.lastConverter||null};
 const exec=o.exec||cp.execFile,bin=path.join(o.root||'/var/opt/bmwcaminfo-voice/current','alsa-probe');
 report.alsa=await helper(exec,bin,'--check');
 report.overlay=await helper(exec,bin,'--check-overlay');
 report.volumeControlCapabilities=await attempt(async()=>{
  const schema=require('./audio-schema'),file=schema.CATALOG;
  const st=await io('stat',file);if(!st.isFile()||st.size>16*1024*1024)throw Error('Audio catalog missing or exceeds 16 MiB');
  return schema.volumeCapabilities(await io('readFile',file,'utf8'));
 });
 // Use the already initialized service. Report unavailability instead of creating players.
 report.bmw={};
 for(const key of ['listOfMainSources','listOfMainSinks','listOfMainConnections']){
  report.bmw[key]=await attempt(async()=>{
   if(!s.cc||s.inventoryError)throw Error(s.inventoryError||'CommandControl not initialized');
   const rows=await readList(s.cc,key,2500);
   return {total:rows.length,truncated:rows.length>256,rows:rows.slice(0,256).map(r=>fields(r,['sourceID','sinkID','sourceClassID','sinkClassID','mainConnectionID','name','availability','volume','muteState','connectionState','delay']))};
  });
 }
 report.smartx=await attempt(async()=>{const names=await io('readdir','/dev/shm');const matches=names.filter(n=>/smartx|overlay/i.test(n));return {total:matches.length,truncated:matches.length>256,names:matches.slice(0,256)};});
 report.alsaFiles={};
 for(const file of ['/proc/asound/cards','/proc/asound/pcm','/etc/asound.conf'])report.alsaFiles[file]=await attempt(()=>smallFile(file));
 report.usbInventory=await attempt(async()=>{
  const raw=await io('readFile',o.mountsFile||'/proc/mounts','utf8');
  return {searchRule:'One writable /dev/* mount directly under /media',candidates:mountedUsb(raw,o.mediaRoot),
   mounts:raw.split('\n').filter(line=>/^\/dev\//.test(line)||/\s\/(?:media|mnt|run\/media)\//.test(line)).slice(0,64)};
 });
 return report;
}
async function writeReport(folder,name,data){
 try{await io('mkdir',folder,0o700);}catch(e){if(e.code!=='EEXIST')throw e;}
 const st=await io('lstat',folder);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Report directory must not be a link');
 const file=path.join(folder,name);const fd=await io('open',file,'wx',0o600);
 try{await new Promise((resolve,reject)=>fs.writeFile(fd,data,'utf8',e=>e?reject(e):resolve()));await io('fsync',fd);}finally{await io('close',fd);}
 return file;
}
async function save(d,r,o){
 o=o||{};const report=await collect(d,r,o),data=JSON.stringify(report,null,2)+'\n';
 if(Buffer.byteLength(data)>262144)throw Error('Audio report exceeds size limit');
 // Screen collection does not require writable storage, local or USB.
 if(r.screenOnly===true)return {ok:true,audioReportProtocol:1,screenOnly:true,report};
 const name='SpeedCAM-audio-'+report.createdAt.replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex')+'.json';
 const local=await writeReport(o.reportDir||'/var/opt/bmwcaminfo-voice/reports',name,data);
 let usb=null,usbError=null;
 try{
  const mounts=mountedUsb(await io('readFile',o.mountsFile||'/proc/mounts','utf8'),o.mediaRoot);
  if(!mounts.length)throw Error('Нет доступной для записи USB-флешки. Подключите её и повторите сохранение.');
  if(mounts.length!==1)throw Error('Подключено несколько USB-носителей. Оставьте одну флешку и повторите.');
  const mount=mounts[0];if(await io('realpath',mount)!==path.resolve(mount))throw Error('USB mount must not be a link');
  const device=(await io('stat',mount)).dev;
  const candidate=await writeReport(path.join(mount,'SpeedCAM-Diagnostics'),name,data);
  const stillMounted=mountedUsb(await io('readFile',o.mountsFile||'/proc/mounts','utf8'),o.mediaRoot);
  if(!stillMounted.includes(mount)||(await io('stat',mount)).dev!==device)throw Error('USB отключена во время сохранения. Повторите копирование.');
  if(await io('readFile',candidate,'utf8')!==data)throw Error('Проверка записанного отчёта на USB не пройдена.');
  usb=candidate;
 }catch(e){usbError=text(e.message);}
 // Bound retained local reports; never clean user files or USB media.
 try{const dir=path.dirname(local),names=(await io('readdir',dir)).filter(n=>/^SpeedCAM-audio-[0-9TZ.-]+-[a-f0-9]{6}\.json$/.test(n)).sort();for(const n of names.slice(0,Math.max(0,names.length-10)))await io('unlink',path.join(dir,n));}catch(e){}
 return {ok:true,audioReportProtocol:1,local,usb,usbError,fileName:name,bytes:Buffer.byteLength(data),sha256:crypto.createHash('sha256').update(data).digest('hex')};
}
class AudioReport {
 constructor(d,o){this.d=d;this.o=o||{};this.pending=null;}
 run(r){if(this.pending)return Promise.reject(Error('Сохранение отчёта уже выполняется'));this.pending=save(this.d,r,this.o);return this.pending.then(v=>{this.pending=null;return v;},e=>{this.pending=null;throw e;});}
}
module.exports={AudioReport,collect,mountedUsb,writeReport,helper};
