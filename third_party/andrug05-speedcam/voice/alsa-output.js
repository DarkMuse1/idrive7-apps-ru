'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const {PcmMixer,RATE}=require('./pcm-mixer');
const {AlsaDiagnostics,stereo48}=require('./alsa-diagnostics');
const telemetry=require('./buffer-telemetry');
// Runtime uses the same single, guarded CarLife route as the engineering probe.
// No global volume changes, no channel enumeration and no automatic M4A replay.
class AlsaOutput {
 constructor(service,options){
  const o=options||{};this.s=service;this.telemetryOptions=o;this.measure=o.measure||telemetry.clock;this.overlay=!!o.overlay;this.converter=!!o.converter;this.root=o.root||'/var/opt/bmwcaminfo-voice/current';this.now=o.now||Date.now;
  this.read=o.read||(n=>fs.readFileSync(path.join(this.root,'pcm',n)));this.spawn=o.spawn||cp.spawn;
  this.route=o.route||new AlsaDiagnostics(service,o);if(this.converter&&!o.route){const diagnostics=this.route;this.route={withRoute:(kind,live,run)=>diagnostics.withConverter(kind,live,run)};}this.core=new PcmMixer(require('./beeper-sounds').pulse(service,this.read),{now:this.now,diagnostics:true,getPulse:()=>require('./beeper-sounds').pulse(service,this.read),getMix:()=>require('./mixer-settings').get(service,o)});
  this.cache={};this.pendingVoiceEvidence=[];this.running=null;this.child=null;this.closed=false;this.retryAt=0;this.idleFrames=o.idleFrames===undefined?12:o.idleFrames;
 }
 set(r,owner){if(this.closed)throw Error('Audio service stopping');if(this.now()<this.retryAt)throw Error(this.s.lastError||'ALSA retry pending');this.core.set(r,owner);this.kick();return {ok:true,backend:this.converter?'converter':'alsa',audibleConfirmed:false};}
 clear(owner){this.core.clear(owner);}
 async speak(file,volume,permit){
  file=require('./speech-language').file(file);
  if(this.closed)return {ok:false,error:'Audio service stopping'};
  if(this.now()<this.retryAt)return {ok:false,error:this.s.lastError||'ALSA retry pending'};
  const name=file.replace(/\.m4a$/,'.pcm');if(!/^[a-z0-9-]+\.pcm$/.test(name))throw Error('Invalid PCM asset');
  if(!this.cache[name]){const b=this.read(name);if(!b.length||b.length%2||b.length>RATE*2*20)throw Error('Invalid PCM asset');this.cache[name]=b;}
  const detail=name+'; volume='+volume+'; durationMs='+Math.round(this.cache[name].length/2/RATE*1000);
  if(this.telemetryRecord&&this.telemetryRecord.status==='active')telemetry.event(this.telemetryRecord,'voice-request',detail);
  else {this.pendingVoiceEvidence.push(detail);if(this.pendingVoiceEvidence.length>8)this.pendingVoiceEvidence.shift();}
  const job=this.core.enqueue(this.cache[name],volume,permit);this.kick();return job;
 }
 kick(){
  if(this.running||this.closed)return;
  let record=null;
  this.running=Promise.resolve().then(async()=>{
   if(!this.core.pending()){this.pendingVoiceEvidence=[];return;}
   this.core.resetSignalStats();
   record=this.telemetryRecord=telemetry.start(this.s,this.telemetryOptions);
   this.pendingVoiceEvidence.splice(0).forEach(detail=>telemetry.event(record,'voice-request',detail));
   await this.route.withRoute('runtime',()=>!this.closed,async()=>{if(!this.core.pending())return {skipped:true};return this.stream();});
   telemetry.finish(this.s,record,null);
   this.s.lastError=null;this.s.ready=true;
  }).catch(e=>{if(record)telemetry.finish(this.s,record,e);this.s.lastError='ALSA output: '+e.message;this.s.ready=false;this.retryAt=this.now()+10000;this.core.fail(this.s.lastError);}).then(()=>{
   this.running=null;if(!this.closed&&this.core.pending()&&this.now()>=this.retryAt)this.kick();
  });
 }
 stream(){
  return new Promise((resolve,reject)=>{
   let output='',errors='',stderrPending='',terminal=null,closed=false,ending=false,tick=null,watch=null,killTimer=null,idle=0,lastPump=null;
   const record=this.telemetryRecord;record.phase='stream';
   const child=this.child=this.spawn(path.join(this.root,'alsa-probe'),[this.converter?'--stream-converter':this.overlay?'--stream-overlay':'--stream'],{stdio:['pipe','pipe','pipe']});
   const finish=(e,r)=>{if(closed)return;closed=true;clearImmediate(tick);clearTimeout(watch);clearTimeout(killTimer);if(this.child===child)this.child=null;if(!e)this.lastStream=r;e?reject(e):resolve(r);};
   const fail=e=>{if(terminal||closed)return;terminal=e;clearTimeout(watch);try{child.stdin.destroy();child.kill('SIGTERM');}catch(x){}killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch(x){}},1000);};
   this.abort=()=>fail(Error('Audio service stopping'));
   const progress=()=>{clearTimeout(watch);watch=setTimeout(()=>fail(Error(ending?'ALSA drain timeout':'ALSA stream stalled')),4000);};
   child.on('error',e=>finish(e));child.stdin.on('error',fail);
   child.stdout.on('data',b=>{output+=b;if(output.length>16384)fail(Error('ALSA response too large'));});
   child.stderr.on('data',b=>{
    stderrPending+=b;let end;
    while((end=stderrPending.indexOf('\n'))>=0){const line=stderrPending.slice(0,end);stderrPending=stderrPending.slice(end+1);
     if(line.indexOf('SPEEDCAM_BUFFER ')==0){try{telemetry.native(record,JSON.parse(line.slice(16)));}catch(e){telemetry.event(record,'invalid-native-telemetry','ignored');}}
     else errors=(errors+line+'\n').slice(-16384);
    }
    if(stderrPending.length>16384){errors=(errors+stderrPending).slice(-16384);stderrPending='';}
   });
   child.on('close',(code,signal)=>{
    record.exitCode=code;record.signal=signal||null;errors=(errors+stderrPending).slice(-16384);
    try{telemetry.native(record,JSON.parse(output.trim()));}catch(e){}
    // A helper that rejects the device/format can close stdin before Node sees
    // its exit. Preserve stderr instead of hiding the actual cause behind EPIPE.
    if(terminal)return finish(errors.trim()?Error(terminal.message+'; ALSA helper: '+errors.trim().slice(-1200)):terminal);
    if(code!==0)return finish(Error('ALSA playback: '+(errors.trim()||signal||code)));
    try{const r=JSON.parse(output.trim());if(!ending||!r.streamCompleted||!r.framesWritten||r.pendingFrames>0)throw Error('Incomplete ALSA stream');if(this.converter&&(r.rate!==24000||r.channels!==1||r.device!=='plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO'))throw Error('Unexpected Converter stream format');finish(null,r);}catch(e){finish(e);}
   });
   const pump=()=>{
    if(closed||terminal)return;if(this.closed)return fail(Error('Audio service stopping'));
    const stamp=this.measure();if(lastPump!==null){const gap=Math.max(0,stamp-lastPump);record.maxPumpGapMs=Math.max(record.maxPumpGapMs,gap);if(gap>64)record.pumpGapsOver64Ms++;}lastPump=stamp;
    if(this.core.pending())idle=0;else if(++idle>this.idleFrames){ending=true;record.phase='drain';progress();child.stdin.end();return;}
    const mono=this.core.render(RATE/50),chunk=this.converter?mono:stereo48(mono);
    record.pcmSignal=this.core.signalStats();
    record.beeperActive=this.core.live();if(this.core.beep){record.beeperIntervalMs=this.core.beep.intervalMs;record.beeperVolume=this.core.beep.volume;}
    const writeAt=this.measure();record.maxRenderMs=Math.max(record.maxRenderMs,writeAt-stamp);record.chunks++;record.submittedFrames+=this.converter?RATE/50:RATE/25;
    const writable=child.stdin.write(chunk,e=>{const delay=Math.max(0,this.measure()-writeAt);record.maxWriteCallbackMs=Math.max(record.maxWriteCallbackMs,delay);if(delay>64)record.writeCallbacksOver64Ms++;if(e)return fail(e);if(closed||terminal)return;this.core.acknowledge();progress();tick=setImmediate(pump);});
    record.pipeQueuedBytes=Number(child.stdin.writableLength)||0;
    record.maxPipeQueuedBytes=Math.max(record.maxPipeQueuedBytes||0,record.pipeQueuedBytes);
    if(!writable)record.backpressureCount++;
   };
   progress();pump();
  });
 }
 async close(){this.closed=true;this.core.fail('Audio service stopped');if(this.child&&this.abort)this.abort();if(this.running)await this.running;}
}
module.exports={AlsaOutput};
