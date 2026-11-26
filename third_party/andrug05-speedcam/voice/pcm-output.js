'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const {PcmMixer,wavHeader,RATE}=require('./pcm-mixer');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Streaming WAV over a local FIFO: one playFile for the entire warning session.
// Support by the BMW decoder must be checked on each target firmware.
class FifoSink {
 constructor(){this.fd=null;this.file=null;this.closed=false;}
 async open(){
  const command=['/usr/bin/mkfifo','/bin/mkfifo'].find(p=>fs.existsSync(p));
  if(!command)throw Error('PCM stream: mkfifo unavailable');
  this.file='/run/bmwcaminfo-voice/mix-'+process.pid+'-'+Date.now()+'.wav';
  await new Promise((resolve,reject)=>cp.execFile(command,['-m','644',this.file],{timeout:2000},e=>e?reject(e):resolve()));
  // Nonblocking open avoids a stuck worker if MediaPlayer never opens its reader.
  this.fd=fs.openSync(this.file,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
  await this.write(wavHeader(0x7ffff000));
  await this.write(Buffer.alloc(RATE/25*2)); // 40 ms preroll, not a queued warning.
  return this.file;
 }
 async write(data){
  let pos=0;const deadline=Date.now()+1000;
  while(pos<data.length){
   if(this.closed)throw Error('PCM stream closed');
   try{pos+=fs.writeSync(this.fd,data,pos,data.length-pos);}
   catch(e){if(e.code!=='EAGAIN'&&e.code!=='EWOULDBLOCK')throw e;if(Date.now()>deadline){const error=Error('BMW decoder did not consume PCM stream');error.code='PCM_NOT_CONSUMED';throw error;}await sleep(10);}
  }
 }
 close(){this.closed=true;if(this.fd!==null){try{fs.closeSync(this.fd);}catch(e){}this.fd=null;}if(this.file){try{fs.unlinkSync(this.file);}catch(e){}this.file=null;}}
}
class MixedOutput {
 constructor(service,options){
  const o=options||{};this.service=service;this.root=o.root||'/var/opt/bmwcaminfo-voice/current';
  this.now=o.now||Date.now;this.sleep=o.sleep||sleep;this.makeSink=o.makeSink||(()=>new FifoSink());
  this.read=o.read||(name=>fs.readFileSync(path.join(this.root,'pcm',name)));
  this.core=new PcmMixer(require('./beeper-sounds').pulse(service,this.read),{now:this.now,getPulse:()=>require('./beeper-sounds').pulse(service,this.read),getMix:()=>require('./mixer-settings').get(service,o)});
  this.cache={};this.running=null;this.retryAt=0;this.closed=false;
 }
 set(request,owner){
  if(this.closed)throw Error('Audio service stopping');
  if(this.service.fileFallback)throw Error('Beeper unavailable: BMW PCM stream failed; voice uses regular files');
  if(this.now()<this.retryAt)throw Error(this.service.lastError||'PCM output retry pending');
  this.core.set(request,owner);this.kick();return {ok:true};
 }
 clear(owner){this.core.clear(owner);}
 async speak(file,volume,permit){
  file=require('./speech-language').file(file);
  if(this.closed)return {ok:false,error:'Audio service stopping'};
  if(this.now()<this.retryAt)return {ok:false,error:this.service.lastError||'PCM output retry pending'};
  const name=file.replace(/\.m4a$/,'.pcm');
  if(!this.cache[name]){const pcm=this.read(name);if(!pcm.length||pcm.length%2||pcm.length>RATE*2*20)throw Error('Invalid PCM asset');this.cache[name]=pcm;}
  const task=this.core.enqueue(this.cache[name],volume,permit);this.kick();return task;
 }
 kick(){
  if(this.running||this.closed)return;
  this.running=this.run().catch(e=>{
   this.service.lastError='PCM output: '+e.message;this.service.ready=false;
   if(e.code==='PCM_NOT_CONSUMED'&&!this.service.disableFileFallback){
    this.service.fileFallback=true;this.service.fileFallbackReason=this.service.lastError;
   }
   this.retryAt=this.now()+10000;this.core.fail(this.service.lastError);
  }).then(()=>{this.running=null;if(!this.closed&&this.core.pending()&&this.now()>=this.retryAt)this.kick();});
 }
 async run(){
  const svc=this.service;let sink=null,connected=false;
  try{
   await svc.waitAvailable(()=>!this.closed&&this.core.pending());
   // Expired queued voice is pruned by rendering; stale beeper alone never opens a route.
   if(this.closed||!this.core.pending())return;
   await svc.connectAudio();connected=true;
   if(this.closed||!this.core.pending())return;
   sink=this.makeSink();this.sink=sink;const file=await sink.open();
   let accepted=false,startError=null,settled=false;
   const startTask=svc.mp.callMethod('playFile',{path:file,languageCode:7695972},7000).then(result=>{
    accepted=!!(result&&result.EntError==='OK');if(!accepted)startError=Error('BMW MediaPlayer rejected PCM stream');settled=true;
   },e=>{startError=e;settled=true;});
   const startDeadline=this.now()+7000;
   // Feed bounded silence during decoder preroll; speech is not consumed early.
   while(!settled){
    if(this.closed)throw Error('PCM stream closed');
    if(this.now()>=startDeadline)throw Error('BMW PCM start timeout');
    await sink.write(Buffer.alloc(RATE/50*2));await this.sleep(20);
   }
   await startTask;if(startError)throw startError;
   let idle=0;
   while(!this.closed){
    if(this.core.pending())idle=0;else if(++idle>12)break;
    const start=this.now();await sink.write(this.core.render(RATE/50));this.core.acknowledge();
    await this.sleep(Math.max(0,20-(this.now()-start)));
   }
  }finally{
   if(sink)sink.close();this.sink=null;
   if(connected)await svc.release();
  }
 }
 async close(){this.closed=true;this.core.fail('Audio service stopped');if(this.sink)this.sink.close();if(this.running)await this.running;}
}
module.exports={MixedOutput,FifoSink};
