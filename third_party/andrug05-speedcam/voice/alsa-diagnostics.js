'use strict';
// Shared guarded route for engineering probes and the ALSA runtime.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const {PcmMixer}=require('./pcm-mixer');
const {readList}=require('./command-control');
const {launchError}=require('./alsa-launch-error');
const telemetry=require('./buffer-telemetry');
const PROFILE={sourceID:287,sinkID:1024,device:'plug:smartx:CarLifeMedia_CF_48_STEREO'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function bounded(p,ms){return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('ALSA/BMW timeout')),ms);Promise.resolve(p).then(v=>{clearTimeout(t);resolve(v);},e=>{clearTimeout(t);reject(e);});});}
function ok(r){return r&&(r.amError==='E_OK'||r.amError===0);}
function stereo48(mono){const b=Buffer.alloc(mono.length*4);for(let i=0;i<mono.length/2;i++){const a=mono.readInt16LE(i*2),n=i+1<mono.length/2?mono.readInt16LE((i+1)*2):a;const mid=Math.round((a+n)/2);b.writeInt16LE(a,i*8);b.writeInt16LE(a,i*8+2);b.writeInt16LE(mid,i*8+4);b.writeInt16LE(mid,i*8+6);}return b;}
class AlsaDiagnostics {
 constructor(service,options){this.s=service;this.o=options||{};this.root=this.o.root||'/var/opt/bmwcaminfo-voice/current';this.bin=path.join(this.root,'alsa-probe');this.sleep=this.o.sleep||sleep;this.spawn=this.o.spawn||cp.spawn;this.exec=this.o.exec||cp.execFile;this.child=null;this.last=null;}
 check(){return new Promise((resolve,reject)=>{this.exec(this.bin,['--check'],{timeout:3000,maxBuffer:16384},(err,out,stderr)=>{if(err)return reject(Error('ALSA helper: '+String(stderr||launchError(err,this.bin)).slice(0,240)));try{const r=JSON.parse(out);if(r.library!==true)throw Error('ALSA library unavailable');resolve(Object.assign({},PROFILE,r,{experimental:true}));}catch(e){reject(e);}});});}
 async scan(){try{return {available:true,profile:await this.check(),last:this.last};}catch(e){return {available:false,error:e.message,last:this.last};}}
 checkOverlay(){return new Promise((resolve,reject)=>{this.exec(this.bin,['--check-overlay'],{timeout:3000,maxBuffer:16384},(err,out,stderr)=>{
  let r;try{r=JSON.parse(out);}catch(e){}
  if(r&&r.discoveryProtocol===1){
   this.lastOverlayDiscovery=r;
   const snapshot=JSON.stringify(r);if(snapshot!==this.overlayDiscoverySnapshot){this.overlayDiscoverySnapshot=snapshot;console.log('ALSA_OVERLAY_DISCOVERY '+snapshot);}
   if(r.overlay!==true){
    const reasons={'no-advertised-output':'ALSA не объявила выход Overlay; подключение SmartX также не найдено.','ambiguous-output':'Найдено несколько ALSA-выходов Overlay. Автовыбор остановлен.','hint-api-unavailable':'ALSA не предоставляет интерфейс списка выходов, порт SmartX не найден.','enumeration-failed':'Не удалось прочитать список ALSA-выходов.','incomplete-inventory':'Неполный список портов SmartX. Автовыбор остановлен.'};
    const inventory=Number.isInteger(r.sharedMemoryTotal)?' Подсказок ALSA: '+r.outputsTotal+'; портов Overlay: '+r.sharedMemoryTotal+'.':'';
    return reject(Error((reasons[r.reason]||'ALSA Overlay: ошибка обнаружения выхода.')+inventory+' Используйте рабочий M4A + Overlay. Подробности: ALSA_OVERLAY_DISCOVERY в журнале сервиса.'));
   }
  }
  if(err)return reject(Error('ALSA Overlay: '+String(stderr||launchError(err,this.bin)).trim().slice(0,240)));
  try{if(!r||r.library!==true||r.overlay!==true||typeof r.device!=='string'||!/^(plug:)?smartx:OapGenericOverlay(?:_[a-z0-9_-]+)?$/i.test(r.device))throw Error('No advertised Overlay ALSA output');resolve(r);}catch(e){reject(e);}
 });});}
 async scanOverlay(){try{return {available:true,profile:await this.checkOverlay()};}catch(e){return {available:false,error:e.message};}}
 checkConverter(){return new Promise((resolve,reject)=>{this.exec(this.bin,['--check-converter'],{timeout:3000,maxBuffer:16384},(err,out,stderr)=>{
  if(err)return reject(Error('ALSA converter: '+String(stderr||launchError(err,this.bin)).trim().slice(0,500)));
  try{const r=JSON.parse(out);if(r.converterProtocol!==1||r.library!==true||r.present!==true||r.device!=='plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO'||r.rate!==24000||r.channels!==1)throw Error('Обновите звуковой компонент: нет пробы порта Converter');resolve(r);}catch(e){reject(e);}
 });});}
 async checkConverterStream(){
  const p=await this.checkConverter();
  if(p.streamSupported!==true)throw Error('Обновите звуковой компонент: нет непрерывного потока ALSA Converter');
  return p;
 }
 async scanConverter(){try{return {available:true,profile:await this.checkConverterStream()};}catch(e){return {available:false,error:e.message};}}
 async withConverter(kind,alive,stream){
  // Checkbox off: direct writes to the verified Converter port, without a BMW
  // Overlay connection. Audibility of this variant must be confirmed separately.
  await this.checkConverterStream();if(!alive())throw Error('Converter playback cancelled');
  return stream();
 }
 async testConverterDirect(kind,alive){return this.withConverter(kind,alive,()=>this.stream(kind,alive,'converter'));}
 async connections(){return readList(this.s.cc,'listOfMainConnections');}
 async test(kind,alive){
  if(!['voice','beeper','both'].includes(kind))throw Error('Invalid ALSA test');
  return this.withRoute(kind,alive,()=>this.stream(kind,alive));
 }
 async withRoute(kind,alive,stream){
  const previous=this.last;
  try{return await this.acquireRoute(kind,alive,stream);}
  catch(e){if(this.last===previous){this.last={at:new Date().toISOString(),profile:PROFILE,kind,ok:false,error:e.message,audibleConfirmed:false,independentVolume:'not-confirmed'};console.log('ALSA_PROBE '+JSON.stringify(this.last));}throw e;}
 }
 async acquireRoute(kind,alive,stream){
  await this.check();if(!alive())throw Error('Test cancelled');
  await bounded(this.s.init(),5000);
  if(this.s.inventoryError)throw Error(this.s.inventoryError);
  const sources=await readList(this.s.cc,'listOfMainSources');
  const source=sources.find(s=>s.sourceID===PROFILE.sourceID&&/CarLifeMedia/i.test(s.name||''));
  if(!source)throw Error('ALSA profile unavailable: BMW source 287 CarLifeMedia not advertised');
  const availability=source.availability;
  if(!availability||!['A_UNAVAILABLE',2].includes(availability.availability))throw Error('CarLife source not confirmed idle/unavailable; test refused');
  const before=await this.connections();
  if(before.some(c=>c.sourceID===PROFILE.sourceID))throw Error('CarLife audio route is busy');
  const sinks=await readList(this.s.cc,'listOfMainSinks');
  if(!sinks.some(s=>s.sinkID===PROFILE.sinkID))throw Error('BMW output 1024 unavailable');
  const routing=await bounded(this.s.createRoutingObserver(),4000);
  let touched=false,connection=null,result=null,failure=null,cleanupError=null,conflict=false;
  const call=(method,args)=>bounded(this.s.cc.callMethod(method,args,3000),3500);
  const availabilityCall=value=>bounded(routing.callMethod('hookSourceAvailablityStatusChange',{sourceID:PROFILE.sourceID,availability:value},3000),3500);
  try{
   if(!alive())throw Error('Test cancelled');
   touched=true;await availabilityCall({availability:'A_AVAILABLE',availabilityReason:0});
   if(!alive())throw Error('Test cancelled');
   const r=await call('connect',{sourceID:PROFILE.sourceID,sinkID:PROFILE.sinkID});
   if(!ok(r)){
    conflict=(await this.connections()).some(c=>c.sourceID===PROFILE.sourceID);
    throw Error('ALSA route not acquired: '+JSON.stringify(r));
   }
   connection=r.mainConnectionID;
   let connected=false;
   const until=Date.now()+4000;
   for(let i=0;i<12&&alive()&&Date.now()<until;i++){
    const routes=await this.connections();
    connected=routes.some(c=>c.sourceID===PROFILE.sourceID&&c.sinkID===PROFILE.sinkID&&['CS_CONNECTED',2].includes(c.connectionState));
    if(connected)break;await this.sleep(200);
   }
   if(!connected||!alive())throw Error(alive()?'ALSA route did not reach CS_CONNECTED':'Test cancelled');
   result=await stream();
   if(!alive())throw Error('Test cancelled');
  }catch(e){failure=e;}
  finally{
   this.stop();
   if(touched&&!conflict){
    // Reconcile a timed-out connect too. Source was unavailable and had no connections before the test.
    try{
     const routes=await this.connections();
     const owned=routes.filter(c=>c.sourceID===PROFILE.sourceID&&c.sinkID===PROFILE.sinkID);
     if(connection!=null&&!owned.some(c=>c.mainConnectionID===connection))connection=null;
     for(const c of owned){const r=await call('disconnect',{mainConnectionID:c.mainConnectionID});if(!ok(r))throw Error('BMW did not confirm ALSA route release');}
    }catch(e){cleanupError=e;}
    try{await availabilityCall(availability);}catch(e){cleanupError=e;}
   }
   if(conflict)cleanupError=Error('Concurrent CarLife route: left untouched; verify audio state before retry');
  }
  this.last={at:new Date().toISOString(),profile:PROFILE,kind,ok:!failure&&!cleanupError,result,error:failure&&failure.message,cleanupError:cleanupError&&cleanupError.message,audibleConfirmed:false,independentVolume:'not-confirmed'};
  console.log('ALSA_PROBE '+JSON.stringify(this.last));
  if(cleanupError)throw Error('ALSA cleanup: '+cleanupError.message+(failure?'; '+failure.message:''));
  if(failure)throw failure;
  return {ok:true,alsa:this.last,accepted:true,audibleConfirmed:false,requiresListening:true,continuousBeeper:kind!=='voice',message:'ALSA stream completed; audibility and independent volume require listening. M4A mode unchanged.'};
 }
 stop(){if(this.child){try{this.child.kill('SIGTERM');}catch(e){}}}
 stream(kind,alive,overlay){
  const converter=overlay==='converter';
  const read=n=>{const b=fs.readFileSync(path.join(this.root,'pcm',n));if(!b.length||b.length%2||b.length>960000)throw Error('Invalid PCM sample');return b;};
  let clock=0,output='',errors='',stderrPending='',closed=false,tick=null,watch=null,cancelWatch=null,killTimer=null,voiceQueued=false,lastPump=null;
  const core=new PcmMixer(require('./beeper-sounds').pulse(this.s,read),{now:()=>clock});
  const voice=kind==='beeper'?null:read('camera-500.pcm'),owner={};
  return new Promise((resolve,reject)=>{
   const record=telemetry.start(this.s,{converter,overlay:overlay===true,diagnosticOrigin:'probe'});record.phase='stream';
   let terminal=null;const child=this.child=this.spawn(this.bin,[converter?'--play-converter':overlay?'--play-overlay':'--play'],{stdio:['pipe','pipe','pipe']});
   const fail=e=>{if(terminal)return;terminal=e;try{child.stdin.destroy();child.kill('SIGTERM');}catch(x){}killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch(x){}},1000);};
   const finish=(err,r)=>{if(closed)return;closed=true;telemetry.finish(this.s,record,err);clearImmediate(tick);clearTimeout(watch);clearInterval(cancelWatch);clearTimeout(killTimer);if(this.child===child)this.child=null;core.fail('Probe ended');err?reject(err):resolve(r);};
   child.on('error',e=>finish(e));child.stdin.on('error',e=>fail(e));
   child.stdout.on('data',b=>{output+=b;if(output.length>16384)fail(Error('ALSA response too large'));});
   child.stderr.on('data',b=>{stderrPending+=b;let end;while((end=stderrPending.indexOf('\n'))>=0){const line=stderrPending.slice(0,end);stderrPending=stderrPending.slice(end+1);if(line.indexOf('SPEEDCAM_BUFFER ')==0){try{telemetry.native(record,JSON.parse(line.slice(16)));}catch(e){}}else errors=(errors+line+'\n').slice(-16384);}if(stderrPending.length>16384){errors=(errors+stderrPending).slice(-16384);stderrPending='';}});
   child.on('close',(code,signal)=>{
    record.exitCode=code;record.signal=signal||null;errors=(errors+stderrPending).slice(-16384);try{telemetry.native(record,JSON.parse(output.trim()));}catch(e){}
    if(terminal)return finish(terminal);
    if(code!==0)return finish(Error('ALSA playback: '+(errors.trim()||signal||code)));
    try{const r=JSON.parse(output.trim());if(!r.streamCompleted||!r.framesWritten||r.pendingFrames>0)throw Error('No completed ALSA stream');if(converter&&(r.rate!==24000||r.channels!==1||r.device!=='plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO'))throw Error('Unexpected converter stream format');finish(null,r);}catch(e){finish(e);}
   });
   watch=setTimeout(()=>fail(Error('ALSA playback timeout')),12000);
   cancelWatch=setInterval(()=>{if(!alive())fail(Error('Test cancelled'));},50);
   const pump=()=>{
    if(closed||terminal)return;
    if(!alive())return fail(Error('Test cancelled'));
    const stamp=telemetry.clock();if(lastPump!==null){const gap=stamp-lastPump;record.maxPumpGapMs=Math.max(record.maxPumpGapMs,gap);if(gap>64)record.pumpGapsOver64Ms++;}lastPump=stamp;
    if(clock>=8000){core.clear(owner);child.stdin.end();return;}
    if(kind!=='voice'&&clock<5000)core.set({cameraId:'alsa-probe',volume:40,intervalMs:clock<2500?1000:500},owner);else core.clear(owner);
    if(voice&&!voiceQueued&&clock>=1000){voiceQueued=true;core.enqueue(voice,40,{live:alive}).catch(()=>{});}
    const mono=core.render(480),chunk=converter?mono:stereo48(mono);clock+=20;
    // The native nonblocking ALSA writer and bounded pipe provide the clock.
    // Chaining JS timers here accumulates jitter and can underrun the device.
    const writeAt=telemetry.clock();record.maxRenderMs=Math.max(record.maxRenderMs,writeAt-stamp);record.chunks++;record.submittedFrames+=converter?480:960;
    const writable=child.stdin.write(chunk,e=>{const delay=telemetry.clock()-writeAt;record.maxWriteCallbackMs=Math.max(record.maxWriteCallbackMs,delay);if(delay>64)record.writeCallbacksOver64Ms++;if(e)return fail(e);core.acknowledge();if(!closed&&!terminal)tick=setImmediate(pump);});if(!writable)record.backpressureCount++;
   };
   pump();
  });
 }
}
module.exports={AlsaDiagnostics,PROFILE,stereo48};
