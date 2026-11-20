'use strict';
const fs=require('fs'),path=require('path');
const {isProfile}=require('./audio-profiles');
const {MixedOutput}=require('./pcm-output');
const {AlsaDiagnostics}=require('./alsa-diagnostics');
const {readList}=require('./command-control');
const {OverlayProbe}=require('./overlay-probe');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const validId=n=>Number.isInteger(n)&&n>0&&n<=65535;
function bounded(p,ms){return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('BMW discovery timeout')),ms);Promise.resolve(p).then(v=>{clearTimeout(t);resolve(v);},e=>{clearTimeout(t);reject(e);});});}
function rows(value,key){const a=Array.isArray(value)?value:value&&(value[key]||value.value);return Array.isArray(a)?a:[];}
class ChannelDiagnostics {
 constructor(service,options){
  this.s=service;this.o=options||{};this.file=this.o.file||'/var/opt/bmwcaminfo-voice/audio-route.json';
  this.sleep=this.o.sleep||delay;this.makeMixer=this.o.makeMixer||(s=>new MixedOutput(s));
  this.alsa=this.o.alsa||new AlsaDiagnostics(service,this.o);
  this.overlay=this.o.overlay||new OverlayProbe(service,Object.assign({},this.o,{alsa:this.alsa}));
  this.duck=this.o.duck||new (require('./carplay-duck-probe').CarplayDuckProbe)(service,this.o);
  this.report=new (require('./audio-report').AudioReport)(this,this.o);
  this.reportShare=new (require('./report-share').ReportShare)(async r=>(await this.report.run(Object.assign({},r,{screenOnly:true}))).report);
  this.mix=new (require('./mixer-settings').MixerSettings)(this,this.o);this.beeperSounds=new (require('./beeper-sounds').BeeperSounds)(this,this.o);
  this.sinks=[];this.last=null;this.busy=false;this.generation=0;this.cancelled=false;
  try{const r=JSON.parse(fs.readFileSync(this.file,'utf8'));if(validId(r.sinkID)&&['pulse','file','pcm','alsa','converter','converter-stable','smartx','converter-hold','converter-reset','converter-period'].includes(r.backend)){if(r.backend==='smartx'){r.backend='converter';r.overlay=true;r.migratedFrom='legacy-experimental';fs.writeFileSync(this.file+'.tmp',JSON.stringify(r),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}this.saved=r;this.apply(r);}}catch(e){}
 }
 apply(r){this.s.audioOverlay=r.backend==='pulse'||isProfile(r.backend)||r.backend==='converter-stable'||r.overlay===true;this.s.audioBackend=r.backend==='pulse'?'pulse':isProfile(r.backend)?r.backend:r.backend==='converter-stable'?'converter-stable':r.backend==='converter'?'converter':r.backend==='alsa'?'alsa':'pcm-fifo';this.s.routeSinkId=r.sinkID;this.s.fileFallback=r.backend==='file';this.s.fileFallbackReason=this.s.fileFallback?'Selected regular-file output':null;}
 async scan(){
  if(this.busy)throw Error('Audio test busy');
  await bounded(this.s.init(),5000);const errors={};const read=async key=>{try{if(this.s.inventoryError)throw Error(this.s.inventoryError);const list=await readList(this.s.cc,key);if(!list.length&&key!=='listOfMainConnections')throw Error('BMW returned an empty '+key);return list;}catch(e){errors[key]=e.message;return [];}};
  const results=await Promise.all(['listOfMainSources','listOfMainSinks','listOfMainConnections'].map(read));
  const clean=(list,key)=>list.filter(r=>r&&validId(r[key])).slice(0,256).map(r=>({id:r[key],name:String(r.name||r[key]).slice(0,100),availability:r.availability,volume:r.volume,muteState:r.muteState}));
  this.sinks=clean(results[1],'sinkID');this.generation++;this.last=null;
  const alsa=await this.alsa.scan();const converter=this.alsa.scanConverter?await this.alsa.scanConverter():{available:false,error:'Converter streaming unavailable'};this.converterAvailable=converter.available;this.alsaAvailable=alsa.available;return {ok:true,alsa,converter,sources:clean(results[0],'sourceID'),sinks:this.sinks,connections:results[2].slice(0,256),errors,saved:this.saved||null,active:{overlay:!!this.s.audioOverlay,backend:this.s.audioBackend==='pulse'?'pulse':isProfile(this.s.audioBackend)?this.s.audioBackend:this.s.audioBackend==='converter-stable'?'converter-stable':this.s.audioBackend==='converter'?'converter':this.s.audioBackend==='alsa'?'alsa':this.s.fileFallback?'file':'pcm',sinkID:this.s.routeSinkId||1024},sourceID:1046,generation:this.generation,
   note:'Only OapGenericMedia source 1046 can play our samples. Other sources are inventory, not playable candidates.'};
 }
 candidate(r){if(r.backend==='pulse')throw Error('PulseAudio requires Overlay');if(r.backend==='smartx')throw Error('SMARTX removed; use ALSA Converter');if(isProfile(r.backend))throw Error('Converter profile requires Overlay');if(r.backend==='converter-stable')throw Error('Stable Converter requires Overlay');if(r.backend==='converter'){if(!this.converterAvailable||r.sinkID!==1024)throw Error('Scan and select the supported Converter output first');return;}if(r.backend==='alsa'){if(!this.alsaAvailable||r.sinkID!==1024)throw Error('Scan and select the supported ALSA output first');return;}if(!validId(r.sinkID)||!this.sinks.some(s=>s.id===r.sinkID)||!['pulse','file','pcm','alsa','converter','converter-stable','smartx','converter-hold','converter-reset','converter-period'].includes(r.backend))throw Error('Scan and select an advertised output first');}
 async test(r,live){
  if(r.backend!=='alsa')this.candidate(r);if(!['voice','beeper','both'].includes(r.kind))throw Error('Invalid audio test');
  if(this.busy||this.s.speechPending||this.s.musicDucker&&this.s.musicDucker.pending||this.s.mixer&&this.s.mixer.running)throw Error('Audio busy; retry after current warning');
  this.busy=true;this.s.diagnosticBusy=true;this.cancelled=false;this.last=null;
  const original={sink:this.s.routeSinkId,fallback:this.s.fileFallback,reason:this.s.fileFallbackReason};
  let mixer=null,connected=false,timer=null;const alive=()=>!this.cancelled&&(!live||live());
  try{
   if(r.backend==='converter'){const result=await this.alsa.testConverterDirect(r.kind,alive);this.last={sinkID:1024,backend:'converter',kind:r.kind,generation:this.generation,at:Date.now()};return result;}
   if(r.backend==='alsa'){const result=await this.alsa.test(r.kind,alive);this.last={sinkID:1024,backend:'alsa',kind:r.kind,generation:this.generation,at:Date.now()};return result;}
   await bounded(this.s.init(),5000);if(!alive())throw Error('Test cancelled');
   this.s.routeSinkId=r.sinkID;
   if(r.backend==='file'){
    await this.s.connectAudio();connected=true;if(!alive())throw Error('Test cancelled');
    const file=path.join(this.o.root||'/var/opt/bmwcaminfo-voice/current','diagnostics',r.kind+'.m4a');
    const result=await this.s.mp.callMethod('playFile',{path:file,languageCode:7695972},7000);
    if(!result||result.EntError!=='OK')throw Error('BMW rejected test file');
    // A complete six-second file, at 40% digital gain. Do not send global STOP.
    await this.sleep(6700);
   }else{
    const adapter={mp:this.s.mp,waitAvailable:()=>bounded(this.s.waitAvailable(alive),5000),connectAudio:()=>this.s.connectAudio(),release:()=>this.s.release()};
    mixer=this.makeMixer(adapter);const owner={};
    const beat=()=>{if(alive())mixer.set({cameraId:'engineering-audio',intervalMs:700,volume:40},owner);};
    if(r.kind!=='voice'){beat();timer=setInterval(()=>{try{beat();}catch(e){}},400);}
    if(r.kind!=='beeper'){
     const result=await mixer.speak('camera-500.m4a',40,{live:alive});
     if(!result.ok)throw Error(result.error||'PCM test failed');
    }
    await this.sleep(r.kind==='beeper'?6000:1200);
    if(timer){clearInterval(timer);timer=null;}mixer.clear(owner);
    if(mixer.running)await mixer.running;
    if(adapter.lastError)throw Error(adapter.lastError);
   }
   if(!alive())throw Error('Test cancelled');
   this.last={sinkID:r.sinkID,backend:r.backend,kind:r.kind,generation:this.generation,at:Date.now()};
   return {ok:true,accepted:true,audibleConfirmed:false,requiresListening:true,continuousBeeper:r.backend==='pcm',message:'API accepted the test. Confirm by listening; file mix does not prove a live beeper works.'};
  }finally{
   if(timer)clearInterval(timer);
   try{if(mixer)await mixer.close();if(connected)await this.s.release();}
   catch(e){this.last=null;throw e;}
   finally{this.s.routeSinkId=original.sink;this.s.fileFallback=original.fallback;this.s.fileFallbackReason=original.reason;this.busy=false;this.s.diagnosticBusy=false;}
  }
 }
 save(r){
  if(this.busy||this.s.speechPending||this.s.musicDucker&&this.s.musicDucker.pending||this.s.mixer&&this.s.mixer.running)throw Error('Audio busy');
  if(r.backend==='pulse'&&r.overlay!==true)throw Error('PulseAudio requires Overlay');if(r.backend==='smartx')throw Error('SMARTX removed; use ALSA Converter');if(isProfile(r.backend)&&r.overlay!==true)throw Error('Converter profile requires Overlay');
  if(r.backend==='converter-stable'&&r.overlay!==true)throw Error('Stable Converter requires Overlay');if(r.overlay!==true)this.candidate(r);const t=this.last;
  if(!t||!!t.overlay!==(r.overlay===true)||(r.overlay===true&&(!validId(t.sourceID)||r.sourceID!==t.sourceID))||t.sinkID!==r.sinkID||t.backend!==r.backend||t.generation!==this.generation||Date.now()-t.at>600000||t.kind!=='both'||r.heard!==true)throw Error('Run combined test and confirm both sounds first');
  const saved={sinkID:r.sinkID,sourceID:r.overlay===true?t.sourceID:r.backend==='converter'?null:r.backend==='alsa'?287:1046,overlay:r.overlay===true,backend:r.backend,independentVolume:r.independent===true?'user-confirmed':'not-confirmed',continuousBeeper:r.backend!=='file',confirmedAt:new Date().toISOString()};
  if(!fs.existsSync(path.dirname(this.file)))fs.mkdirSync(path.dirname(this.file));fs.writeFileSync(this.file+'.tmp',JSON.stringify(saved),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);
  this.saved=saved;this.apply(saved);return {ok:true,saved};
 }
 reset(){
  if(this.busy||this.s.speechPending||this.s.musicDucker&&this.s.musicDucker.pending||this.s.mixer&&this.s.mixer.running)throw Error('Audio busy');
  // Explicit rollback, not a reset to defaults. Retain it across boots.
  const saved={sinkID:1024,sourceID:1046,backend:'file',independentVolume:'not-confirmed',continuousBeeper:false};
  if(!fs.existsSync(path.dirname(this.file)))fs.mkdirSync(path.dirname(this.file));
  fs.writeFileSync(this.file+'.tmp',JSON.stringify(saved),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);
  this.saved=saved;this.last=null;this.apply(saved);return {ok:true,saved};
 }
 async overlayAction(r,live){
  if(this.busy||this.s.speechPending||this.s.musicDucker&&this.s.musicDucker.pending||this.s.mixer&&this.s.mixer.running)throw Error('Audio busy; retry after current warning');
  this.busy=true;this.s.diagnosticBusy=true;this.cancelled=false;
  this.last=null;
  try{
   if(r.action==='audio-overlay-converter-test'){this.generation++;return await this.overlay.testConverter(()=>!this.cancelled&&(!live||live()));}
   if(r.backend==='smartx'||r.probeProfile)throw Error('Old SMARTX comparison removed; use Converter profiles');
   if(r.action==='audio-overlay-scan'){this.generation++;const scan=await this.overlay.scan(r.backend);return Object.assign({},scan,{overlaySaveSupported:true});}
   const result=await this.overlay.test(()=>!this.cancelled&&(!live||live()),r.backend?r:null),t=result.overlay;
   if(!r.probeProfile&&!this.cancelled&&(!live||live())&&result.ok&&t&&t.accepted&&!t.error&&!t.cleanupError&&t.backend===r.backend&&t.kind==='both'&&validId(t.sourceID)&&validId(t.sinkID))this.last={overlay:true,backend:t.backend,sinkID:t.sinkID,sourceID:t.sourceID,kind:t.kind,generation:this.generation,at:Date.now()};
   return Object.assign({},result,{overlaySaveSupported:true});
  }
  finally{this.busy=false;this.s.diagnosticBusy=false;}
 }
 async duckAction(r,live){
  if(this.busy||this.s.speechPending||this.s.musicDucker&&this.s.musicDucker.pending||this.s.mixer&&this.s.mixer.running)throw Error('Audio busy; retry after current warning');
  this.busy=true;this.s.diagnosticBusy=true;this.cancelled=false;this.last=null;
  try{return {ok:true,duckProtocol:1,duck:await this.duck.run(()=>!this.cancelled&&(!live||live()),r.action==='audio-carplay-duck-recover')};}
  finally{this.busy=false;this.s.diagnosticBusy=false;}
 }
 async handle(r,live){if(['beeper-sounds-save','beeper-sounds-listen','audio-mixer-save','audio-mixer-listen','audio-scan','audio-test','audio-save','audio-reset','audio-overlay-scan','audio-overlay-test','audio-overlay-converter-test','audio-carplay-duck-test'].includes(r.action)&&this.s.mixer&&this.s.mixer.releaseIdle){if(this.quiescing||this.busy||this.s.speechPending||this.s.musicDucker&&this.s.musicDucker.pending)throw Error('Audio busy');this.quiescing=true;this.s.diagnosticBusy=true;try{await this.s.mixer.releaseIdle();}finally{this.quiescing=false;this.s.diagnosticBusy=false;}}if(r.action==='beeper-sounds-get')return this.beeperSounds.snapshot();if(r.action==='beeper-sounds-save')return this.beeperSounds.save(r.id);if(r.action==='beeper-sounds-listen'){const task=this.beeperSounds.listen(r,live);this.active=task;try{return await task;}finally{if(this.active===task)this.active=null;}}if(r.action==='audio-mixer-get')return this.mix.snapshot();if(r.action==='audio-mixer-save')return this.mix.save(r.values);if(r.action==='audio-mixer-listen'){const task=this.mix.listen(r,live);this.active=task;try{return await task;}finally{if(this.active===task)this.active=null;}}if(r.action==='audio-report-share-start')return this.reportShare.start(r,live);if(r.action==='audio-report-share-status')return this.reportShare.status();if(r.action==='audio-report-share-stop')return this.reportShare.stop();if(r.action==='audio-report')return this.report.run(r);if(r.action==='audio-current')return {ok:true,carplayDuckProtocol:1,saved:this.saved||null,active:{overlay:!!this.s.audioOverlay,backend:this.s.audioBackend==='pulse'?'pulse':isProfile(this.s.audioBackend)?this.s.audioBackend:this.s.audioBackend==='converter-stable'?'converter-stable':this.s.audioBackend==='converter'?'converter':this.s.audioBackend==='alsa'?'alsa':this.s.fileFallback?'file':'pcm'}};if(r.action==='audio-scan')return this.scan();if(['audio-test','audio-overlay-scan','audio-overlay-test','audio-overlay-converter-test','audio-carplay-duck-test','audio-carplay-duck-recover'].includes(r.action)){if(this.busy)throw Error('Audio test busy');const task=r.action==='audio-test'?this.test(r,live):r.action.indexOf('audio-carplay-duck-')===0?this.duckAction(r,live):this.overlayAction(r,live);this.active=task;try{return await task;}finally{if(this.active===task)this.active=null;}}if(r.action==='audio-save')return this.save(r);if(r.action==='audio-reset')return this.reset();if(r.action==='audio-stop'){this.cancelled=true;this.alsa.stop();return {ok:true,message:'No new pulses; current short file is allowed to finish'};}throw Error('Unknown diagnostic action');}
}
module.exports={ChannelDiagnostics,rows};
