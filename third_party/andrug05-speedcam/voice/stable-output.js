'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const telemetry=require('./buffer-telemetry');
function packet(type,id,a,b,data){
 data=data||Buffer.alloc(0);const h=Buffer.alloc(24);
 [0x31504353,type,id||0,a||0,b||0,data.length].forEach((n,i)=>h.writeUInt32LE(n,i*4));
 return Buffer.concat([h,data]);
}
function pcm(data){if(!Buffer.isBuffer(data)||!data.length||data.length%2||data.length>960000)throw Error('Invalid stable PCM asset');return data;}
class StableOutput {
 constructor(service,options){
  const o=this.o=options||{};this.s=service;this.root=o.root||'/var/opt/bmwcaminfo-voice/current';this.now=o.now||Date.now;
  this.read=o.read||(n=>fs.readFileSync(path.join(this.root,'pcm',n)));this.spawn=o.spawn||cp.spawn;
  this.route=o.route||new (require('./overlay-output').OverlayOutput)(service,Object.assign({},o,{converter:true}));
  this.pulse=pcm(require('./beeper-sounds').pulse(service,this.read));this.cache={};this.jobs=[];this.beep=null;this.nextId=1;this.cameraId=0;
  this.running=null;this.child=null;this.closed=false;this.accepting=false;this.retryAt=0;
 }
 set(r,owner){
  if(this.closed)throw Error('Audio service stopping');if(this.now()<this.retryAt)throw Error(this.s.lastError||'Stable ALSA retry pending');
  if(!Number.isInteger(r.intervalMs)||r.intervalMs<300||r.intervalMs>30000||r.intervalMs%100||!Number.isInteger(r.volume)||r.volume<10||r.volume>100||r.volume%10||typeof r.cameraId!=='string'||r.cameraId.length>200)throw Error('Invalid beeper state');
  const nextPulse=pcm(require('./beeper-sounds').pulse(this.s,this.read));if(nextPulse!==this.pulse){if(this.accepting)throw Error('Finish current audio session before changing beeper');this.pulse=nextPulse;}
  if(!this.beep||this.beep.camera!==r.cameraId)this.cameraId++;
  this.beep={camera:r.cameraId,id:this.cameraId,interval:r.intervalMs,volume:r.volume,owner,expires:this.now()+1200};
  if(this.accepting){this.nativeIdle=false;this.cancelIdle();this.send(packet(2,this.beep.id,r.intervalMs,r.volume));}this.kick();
  return {ok:true,backend:this.o.profile||(this.o.direct?'smartx':'converter-stable'),audibleConfirmed:false};
 }
 clear(owner){if(this.beep&&this.beep.owner===owner){this.beep=null;if(this.accepting)this.send(packet(4));}}
 speak(file,volume,permit){
  file=require('./speech-language').file(file);
  if(this.closed||this.now()<this.retryAt)return Promise.resolve({ok:false,error:this.s.lastError||'Audio unavailable'});
  const name=file.replace(/\.m4a$/,'.pcm');if(!/^[a-z0-9-]+\.pcm$/.test(name)||!Number.isInteger(volume)||volume<0||volume>100)throw Error('Invalid stable voice');
  // Read the COMPLETE phrase before it is enqueued. The native renderer never
  // touches a file and never waits for JS to mix/render its next 20ms block.
  if(!this.cache[name])this.cache[name]=pcm(this.read(name));
  if(this.jobs.length>=2)return Promise.resolve({ok:false,retryable:true,error:'Voice queue busy'});
  const result=new Promise(resolve=>this.jobs.push({id:this.nextId++,data:this.cache[name],volume,permit,resolve,expires:this.now()+8000,sent:false}));
  this.cancelIdle();this.flushVoice();this.kick();return result;
 }
 cancelIdle(){clearTimeout(this.idleTimer);this.idleTimer=null;}
 scheduleIdle(){if(this.o.profile==='converter-hold'&&!this.endRequested)return;if(!this.nativeIdle||this.jobs.length||this.beep&&this.beep.expires>this.now())return;this.cancelIdle();this.idleTimer=setTimeout(()=>{if(this.nativeIdle&&!this.pending()&&this.accepting){this.send(packet(5));this.accepting=false;this.child.stdin.end();}},this.endRequested||this.o.profile==='converter-reset'?0:200);}
 pending(){return this.jobs.length||this.beep&&this.beep.expires>this.now();}
 send(data){if(!this.accepting)return;const r=this.telemetryRecord,t=telemetry.clock();r.ipcPackets=(r.ipcPackets||0)+1;r.ipcBytes=(r.ipcBytes||0)+data.length;const ok=this.child.stdin.write(data,e=>{r.maxWriteCallbackMs=Math.max(r.maxWriteCallbackMs,telemetry.clock()-t);if(e&&this.abort)this.abort(e);});if(!ok)r.backpressureCount++;r.maxPipeQueuedBytes=Math.max(r.maxPipeQueuedBytes||0,this.child.stdin.writableLength||0);}
 flushVoice(){
  if(!this.accepting||this.jobs.some(j=>j.sent))return;
  while(this.jobs.length){const j=this.jobs[0];if(this.now()>=j.expires||j.permit&&!j.permit.live()){this.jobs.shift();j.resolve({ok:false,skipped:true});continue;}
   if(this.telemetryRecord)telemetry.event(this.telemetryRecord,'voice-request','id='+j.id+'; bytes='+j.data.length+'; volume='+j.volume);j.sent=true;this.nativeIdle=false;this.cancelIdle();this.send(packet(3,j.id,j.volume,0,j.data));break;}
 }
 kick(){
  if(this.running||this.closed||!this.pending())return;this.endRequested=false;
  const record=this.telemetryRecord=telemetry.start(this.s,Object.assign({},this.o,{converter:true}));
  record.backend=this.o.profile||(this.o.direct?'smartx':'converter-stable');record.profile=this.o.profile||(this.o.direct?'smartx-direct':'plug-stable');record.sessionPolicy=this.o.profile==='converter-hold'?'hold-with-silence':this.o.profile==='converter-reset'?'full-close':'idle-close';record.testKind=this.o.kind||null;record.nativeMixer=true;record.device=(this.o.direct?'':'plug:')+'smartx:Media_Overlay_Converter_Source_CF_24_MONO';record.nativeQueueMs=200;record.gainDb=-6;record.edgeMs=8;record.assets={voice:this.jobs[0]?{bytes:this.jobs[0].data.length,volume:this.jobs[0].volume}:null,pulseBytes:this.pulse.length};
  this.running=Promise.resolve().then(()=>this.route.withRoute('runtime',()=>!this.closed,()=>this.stream())).then(()=>{telemetry.finish(this.s,record,null);this.s.lastError=null;this.s.ready=true;},e=>{
   telemetry.finish(this.s,record,e);
   this.s.lastError='Stable ALSA output: '+e.message;this.s.ready=false;this.retryAt=this.now()+10000;
   this.jobs.splice(0).forEach(j=>j.resolve({ok:false,error:this.s.lastError}));this.beep=null;
  }).then(()=>{this.running=null;if(!this.closed&&this.pending()&&this.now()>=this.retryAt)this.kick();});
 }
 stream(){return new Promise((resolve,reject)=>{
  let output='',errors='',pending='',terminal=null,ended=false,killTimer=null;
  const record=this.telemetryRecord;record.phase='stream';
  const child=this.child=this.spawn(path.join(this.root,'alsa-probe'),[this.o.profile==='converter-period'?'--stream-converter-period':this.o.profile?'--stream-converter-profile':this.o.direct?'--stream-converter-direct':'--stream-converter-stable'],{stdio:['pipe','pipe','pipe']});
  const finish=e=>{if(ended)return;ended=true;this.accepting=false;this.cancelIdle();clearInterval(heartbeat);clearTimeout(watch);clearTimeout(killTimer);if(this.child===child)this.child=null;this.abort=null;e?reject(e):resolve(this.lastStream);};
  const fail=e=>{if(ended||terminal)return;terminal=e;this.accepting=false;try{child.stdin.destroy();child.kill('SIGTERM');}catch(x){}killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch(x){}},1000);};
  this.abort=fail;
  let watch=setTimeout(()=>fail(Error('Native stable mixer did not respond')),4000);
  const progress=()=>{clearTimeout(watch);watch=setTimeout(()=>fail(Error('Native stable mixer stalled')),4000);};
  const heartbeat=setInterval(()=>{if(this.accepting)this.send(packet(6));},400);
  child.on('error',finish);child.stdin.on('error',fail);
  child.stdout.on('data',b=>{output+=b;if(output.length>16384)fail(Error('Native response too large'));});
  child.stderr.on('data',b=>{pending+=b;let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);
   if(line.indexOf('SPEEDCAM_STABLE ')==0){let e;try{e=JSON.parse(line.slice(16));}catch(x){fail(Error('Invalid native stable event'));continue;}progress();
    if(e.event==='started'){const j=this.jobs.find(j=>j.id===e.id);if(j&&j.permit&&j.permit.started)j.permit.started();}
    if(e.event==='done'){const j=this.jobs.find(j=>j.id===e.id);if(j){this.jobs=this.jobs.filter(v=>v!==j);j.resolve({ok:true,message:'Native PCM voice written'});this.flushVoice();this.scheduleIdle();}}
    if(e.event==='idle'){this.nativeIdle=true;this.scheduleIdle();}
    if(e.event==='stats'){record.nativeMixerStats=e;record.lastSignalAt=new Date().toISOString();this.s.stableAudioStats=e;}
    if(e.event==='started'||e.event==='done')telemetry.event(record,'voice-'+e.event,e.id);
   }else if(line.indexOf('SPEEDCAM_BUFFER ')==0){try{telemetry.native(record,JSON.parse(line.slice(16)));progress();}catch(e){telemetry.event(record,'invalid-native-telemetry',e.message);}}else if(line.indexOf('SPEEDCAM_FORMAT ')==0){try{record.format=JSON.parse(line.slice(16));}catch(e){telemetry.event(record,'invalid-native-format',e.message);}}else errors=(errors+line+'\n').slice(-4096);
  }if(pending.length>16384)fail(Error('Native response too large'));});
  child.on('close',(code,signal)=>{
   record.exitCode=code;record.signal=signal||null;
   if(pending)errors=(errors+pending).slice(-4096);
   if(terminal)return finish(Error(terminal.message+(errors?'; '+errors.trim():'')));
   if(code!==0)return finish(Error(errors.trim()||'Native stable stream failed: '+(signal||code)));
   try{const r=JSON.parse(output.trim());if(code!==0||!r.streamCompleted||!r.framesWritten||r.pendingFrames>0||r.rate!==24000||r.channels!==1||r.device!==record.device||this.jobs.some(j=>j.sent))throw Error(errors.trim()||'Incomplete stable stream: '+(signal||code));telemetry.native(record,r);this.lastStream=r;finish();}catch(e){finish(e);}
  });
  this.accepting=true;const mix=require('./mixer-settings').get(this.s,this.o);this.send(packet(7,mix.voice,mix.beeper,mix.duck));record.mixerSettings=Object.assign({},mix);this.send(packet(1,0,0,0,this.pulse));
  if(this.beep&&this.beep.expires>this.now())this.send(packet(2,this.beep.id,this.beep.interval,this.beep.volume));this.flushVoice();
 });}
 async finishSession(){this.endRequested=true;this.scheduleIdle();if(this.running)await this.running;}
 async close(){if(this.running&&!this.pending()){await this.finishSession();}this.closed=true;this.cancelIdle();this.jobs.splice(0).forEach(j=>j.resolve({ok:false,error:'Audio service stopped'}));this.beep=null;if(this.abort)this.abort(Error('Audio service stopping'));if(this.running)await this.running;}
}
module.exports={StableOutput,packet};
