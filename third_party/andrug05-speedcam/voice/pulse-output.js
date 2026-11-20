'use strict';
const fs=require('fs'),path=require('path');
const {PcmMixer,RATE}=require('./pcm-mixer');
const {PulseRuntime}=require('./pulse-runtime');
const {OverlayOutput}=require('./overlay-output');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Two raw streams are mixed by PulseAudio, not by a BMW file decoder.
// Each stream <= 0.432 FS, so their sum retains headroom even at volume 100.
class PulseOutput {
 constructor(service,options){
  this.s=service;this.o=options||{};this.root=this.o.root||'/var/opt/bmwcaminfo-voice/current';this.read=this.o.read||(n=>fs.readFileSync(path.join(this.root,'pcm',n)));
  this.now=this.o.now||Date.now;this.sleep=this.o.sleep||sleep;this.route=this.o.pulseRoute||new OverlayOutput(service,this.o);
  this.voice=new PcmMixer(Buffer.alloc(2),{now:this.now,diagnostics:true,getPulse:()=>require('./beeper-sounds').pulse(service,this.read),getMix:()=>require('./mixer-settings').get(service,this.o)});this.beep=new PcmMixer(require('./beeper-sounds').pulse(service,this.read),{now:this.now,diagnostics:true,getPulse:()=>require('./beeper-sounds').pulse(service,this.read),getMix:()=>require('./mixer-settings').get(service,this.o)});
  this.running=null;this.closed=false;this.retryAt=0;this.cache={};this.duck=1;this.completions=[];
 }
 pending(){return this.voice.pending()||this.beep.pending();}
 set(r,owner){if(this.closed)throw Error('Audio service stopping');if(this.now()<this.retryAt)throw Error(this.s.lastError||'PulseAudio retry pending');this.beep.set(r,owner);this.kick();return {ok:true};}
 clear(owner){this.beep.clear(owner);}
 async speak(file,volume,permit){
  if(this.closed)return {ok:false,error:'Audio service stopping'};
  if(this.now()<this.retryAt)return {ok:false,error:this.s.lastError};
  if(!/^[a-z0-9-]+\.m4a$/.test(file)||!Number.isInteger(volume)||volume<0||volume>100)throw Error('Invalid PulseAudio voice request');
  if(permit&&!permit.live())return {ok:false,skipped:true};
  const name=file.replace(/\.m4a$/,'.pcm');if(!this.cache[name]){const b=this.read(name);if(!b.length||b.length%2||b.length>RATE*40)throw Error('Invalid PCM asset');this.cache[name]=b;}
  const task=this.voice.enqueue(this.cache[name],volume,permit);this.kick();return task;
 }
 kick(){if(this.running||this.closed)return;this.running=this.run().catch(e=>{this.s.lastError='PulseAudio: '+e.message;this.s.ready=false;this.retryAt=this.now()+10000;this.voice.fail(this.s.lastError);this.beep.fail(this.s.lastError);this.completions.splice(0).forEach(j=>j.resolve({ok:false,error:this.s.lastError}));}).then(()=>{this.running=null;if(!this.closed&&this.pending()&&this.now()>=this.retryAt)this.kick();});}
 frames(){
  const talking=!!(this.voice.speech||this.voice.jobs.length),v=this.voice.render(RATE/50),b=this.beep.render(RATE/50),target=talking?require('./mixer-settings').get(this.s,this.o).duck/100:1;
  for(let i=0;i<v.length;i+=2){this.duck+=Math.max(-1/(RATE*.025),Math.min(1/(RATE*.18),target-this.duck));v.writeInt16LE(Math.round(v.readInt16LE(i)*.45),i);b.writeInt16LE(Math.round(b.readInt16LE(i)*.45*this.duck),i);}
  return [v,b];
 }
 async run(){
  const rt=this.runtime=this.o.makePulseRuntime?this.o.makePulseRuntime():new PulseRuntime(this.o);let connected=false,failure=null;
  const record={at:new Date().toISOString(),backend:'pulse',experimental:true,accepted:false,hardwareAudibilityConfirmed:false,frames:0,maxFeedGapMs:0,lateFeeds:0};this.s.pulseDiagnostics=record;
  const live=()=>!this.closed&&!!this.pending();
  try{
   await rt.check();await this.route.waitAvailable(live);if(!live())return;
   await this.route.connectAudio('converter',live);connected=true;
   await rt.start(live);this.s.lastError=null;this.s.ready=true;
   let idle=0,last=this.now(),next=last;this.duck=1;
   while(!this.closed){
    if(this.pending())idle=0;else if(++idle>12)break;
    const now=this.now(),gap=now-last;last=now;record.maxFeedGapMs=Math.max(record.maxFeedGapMs,gap);if(gap>80)record.lateFeeds++;
    const pair=this.frames();await rt.writePair(pair[0],pair[1]);record.frames+=RATE/50;
    this.voice.completed.splice(0).forEach(j=>{j.ackAt=this.now()+450;this.completions.push(j);});
    this.completions=this.completions.filter(j=>{if(this.now()<j.ackAt)return true;j.resolve({ok:true,message:'PulseAudio voice submitted; audibility requires MGU test'});return false;});
    // Bounded 160 ms preroll. Never dump seconds of stale beeps after a scheduler stall.
    next+=20;if(next<this.now()-200)next=this.now();await this.sleep(Math.max(0,next-this.now()-160));
   }
   if(this.closed)throw Error('Audio service stopped');
   await rt.drain();record.accepted=true;
   this.completions.splice(0).forEach(j=>j.resolve({ok:true,message:'PulseAudio streams drained'}));
  }catch(e){failure=e;record.error=e.message;throw e;}
  finally{
   record.voiceSignal=this.voice.signalStats();record.beeperSignal=this.beep.signalStats();record.runtime=Object.assign({},rt.stats);record.endedAt=new Date().toISOString();
   try{await rt.close();}catch(e){record.cleanupError=e.message;failure=failure||e;}
   try{if(connected)await this.route.release();}catch(e){record.cleanupError=e.message;failure=failure||e;}
   this.runtime=null;if(failure)throw failure;
  }
 }
 async finishSession(){if(this.pending())throw Error('Audio busy; wait for voice and beeper');if(this.running)await this.running;}
 async close(){this.closed=true;this.voice.fail('Audio service stopped');this.beep.fail('Audio service stopped');if(this.runtime)await this.runtime.close();if(this.running)await this.running;}
}
function createPulseOutput(s,o){return require('./music-ducker').wrapOutput(new PulseOutput(s,o),s,o);}
async function testPulseOutput(s,o,alive){
 const out=createPulseOutput(s,o),owner={},deadline=Date.now()+30000;let timer=null,beatError=null;
 const live=()=>alive()&&Date.now()<deadline&&!beatError;
 const beat=()=>{if(live())try{out.set({cameraId:'pulse-test',intervalMs:700,volume:40},owner);}catch(e){beatError=e;}};
 try{
  beat();timer=setInterval(beat,400);
  const result=await out.speak('camera-500.m4a',40,{live});if(!result.ok)throw Error(result.error||'PulseAudio cancelled');
  await (o.sleep||sleep)(1000);clearInterval(timer);timer=null;out.clear(owner);if(out.running)await out.running;
  if(beatError)throw beatError;if(!live())throw Error('PulseAudio test cancelled');if(s.lastError)throw Error(s.lastError);
  const p=out.route.profile;return {sourceID:p.sourceID,sinkID:p.sinkID,stream:s.pulseDiagnostics,outputMechanism:'private-pulseaudio-two-streams'};
 }finally{if(timer)clearInterval(timer);await out.close();}
}
module.exports={PulseOutput,createPulseOutput,testPulseOutput};
