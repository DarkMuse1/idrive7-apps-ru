'use strict';
// Music-source offsets only. Never set sink/master volume, mute or transport.
const fs=require('fs'),path=require('path'),{promisify}=require('util');
const {readList}=require('./command-control');
const {UNITS}=require('./carplay-duck-control');
const io=n=>promisify(fs[n]);
const connected=c=>c&&[2,'CS_CONNECTED'].includes(c.connectionState);
const valid=n=>Number.isInteger(n)&&n>0&&n<=65535;
// Includes the exact radio/BT/USB names observed in the user's MGU inventory.
// Announcements, telephone, navigation, generic OAP and CarLife (our ALSA route)
// are deliberately excluded; they are not unambiguously background music.
function musicName(name){return /^(carplaymedia|androidautomedia|fmdabcombined|onlineentertainment|externaldevicebt[ab]|externaldeviceusbfront[ab](?:single)?|bluetooth(?:a2dp|audio|media)?|bta2dp|a2dp|usb(?:audio|media|player)?|tuner(?:fm|am|dab)?|(?:fm|am|dab)(?:radio|tuner)?|radio|cd(?:player)?|dvd(?:player)?|musiccollection|aux(?:in)?)$/i.test(String(name||'').replace(/[ _-]/g,''));}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
class MusicDucker {
 constructor(service,options){
  this.s=service;this.o=options||{};this.now=this.o.now||Date.now;this.sleep=this.o.sleep||pause;
  this.file=this.o.musicDuckJournal||'/var/opt/bmwcaminfo-voice/music-duck-pending.json';
  this.legacyJournal=this.o.legacyDuckJournal||'/var/opt/bmwcaminfo-voice/carplay-duck-pending.json';
  this.entries=[];this.loaded=false;this.control=null;this.retryAt=0;this.ops=Promise.resolve();this.speech=Promise.resolve();this.pending=0;this.closed=false;
  this.status={state:'idle',attenuationDb:6,apiConfirmed:false,audibleConfirmed:false,recoveryPending:false,history:[]};
 }
 event(state,detail){this.status.state=state;this.status.detail=String(detail||'').slice(0,500);this.status.recoveryPending=!!this.entries.length;this.status.history.push({at:this.now(),state,detail:this.status.detail});if(this.status.history.length>24)this.status.history.shift();}
 snapshot(){return JSON.parse(JSON.stringify(this.status));}
 serial(fn){
  const p=this.ops.then(fn).catch(async e=>{
   this.event('error',e.message);
   // A proxy lost during MGU sleep must not poison every later recovery attempt.
   const c=this.control;this.control=null;if(c)try{await c.close();}catch(ignore){}
   throw e;
  });this.ops=p.catch(()=>{});return p;
 }
 async load(){
  if(this.loaded)return;
  let j;try{j=JSON.parse(await io('readFile')(this.file,'utf8'));}catch(e){if(e.code==='ENOENT'){this.loaded=true;return;}throw e;}
  if(j.schema!==2||!Array.isArray(j.entries)||j.entries.length>8||j.entries.some(e=>!valid(e.sourceID)||!musicName(e.name)||!e.property||UNITS[e.property.name]!==e.property.units||!Number.isInteger(e.property.type)||!Number.isInteger(e.original)||!Number.isInteger(e.applied)||e.original-e.applied!==6*e.property.units||e.applied<-60*e.property.units||e.original>12*e.property.units))throw Error('Invalid music recovery journal; no changes made');
  this.entries=j.entries;this.loaded=true;
 }
 async persist(){
  if(!this.entries.length){try{await io('unlink')(this.file);}catch(e){if(e.code!=='ENOENT')throw e;}this.status.recoveryPending=false;return;}
  try{await io('mkdir')(path.dirname(this.file),0o700);}catch(e){if(e.code!=='EEXIST')throw e;}
  await io('writeFile')(this.file+'.tmp',JSON.stringify({schema:2,entries:this.entries}),{mode:0o600});
  await io('rename')(this.file+'.tmp',this.file);this.status.recoveryPending=true;
 }
 async getControl(){
  if(this.control)return this.control;
  if(this.now()<this.retryAt)throw Error('Music source control unavailable; retry deferred');
  try{
   const c=await this.s.createCarplayDuckingControl();
   if(!c.candidates.length){await c.close();throw Error('Firmware exposes no source volume offset with known dB units');}
   return this.control=c;
  }catch(e){this.retryAt=this.now()+60000;throw e;}
 }
 async inventory(){
  const lists=await Promise.all(['listOfMainSources','listOfMainSinks','listOfMainConnections'].map(k=>readList(this.s.cc,k,700)));
  if(lists.some(a=>a.length>256))throw Error('Music inventory exceeds limit');
  const sinks=lists[1].filter(s=>s.name==='MediaSink_Front');
  if(sinks.length!==1||!valid(sinks[0].sinkID))throw Error('Front music sink is ambiguous');
  const sources=lists[0],routes=lists[2],active=sources.filter(s=>musicName(s.name)&&valid(s.sourceID)&&sources.filter(x=>x.sourceID===s.sourceID||x.name===s.name).length===1&&routes.some(r=>r.sourceID===s.sourceID&&r.sinkID===sinks[0].sinkID&&connected(r)));
  if(active.length>8)throw Error('Too many active music sources');
  return {sources,active};
 }
 async value(id,p){const rows=(await this.control.read(id)).filter(x=>x.type===p.type);if(rows.length!==1)throw Error('Music offset missing or ambiguous');return rows[0].value;}
 async restore(entry,sources){
  const source=sources.filter(x=>x.sourceID===entry.sourceID&&x.name===entry.name);
  if(source.length!==1)throw Error('Music source identity changed; restoration pending');
  if(!this.control.candidates.some(p=>p.name===entry.property.name&&p.type===entry.property.type&&p.units===entry.property.units))throw Error('Music property changed; restoration pending');
  const current=await this.value(entry.sourceID,entry.property);
  if(current===entry.applied){
   await this.control.write(entry.sourceID,entry.property,entry.original);
   if(await this.value(entry.sourceID,entry.property)!==entry.original)throw Error('Music restoration was not confirmed');
   this.event('restored',entry.name);
  }else if(current===entry.original&&entry.uncertain){throw Error('Timed-out music write may still arrive; recovery retained');}
  else this.event(current===entry.original?'restored':'external-change-preserved',entry.name);
  this.entries=this.entries.filter(e=>e!==entry);await this.persist();
 }
 async recover(){
  await this.load();if(!this.entries.length)return;
  await this.getControl();const sources=await readList(this.s.cc,'listOfMainSources',700);
  for(const e of this.entries.slice())await this.restore(e,sources);
 }
 async reconcile(token){
  if(fs.existsSync(this.legacyJournal))throw Error('Previous engineering ducking recovery is pending; new attenuation deferred');
  await this.load();await this.getControl();
  const inv=await this.inventory();
  for(const e of this.entries.slice()){
   if(!token.allow||e.uncertain||!inv.active.some(s=>s.sourceID===e.sourceID&&s.name===e.name))await this.restore(e,inv.sources);
   else if(await this.value(e.sourceID,e.property)!==e.applied){
    token.excluded.add(e.sourceID);await this.restore(e,inv.sources);
   }
  }
  if(!token.allow||this.closed)return;
  if(!inv.active.length){this.event('no-music','No recognized active music route');return;}
  for(const source of inv.active){
   if(!token.allow||this.closed)break;
   if(token.excluded.has(source.sourceID)||this.entries.some(e=>e.sourceID===source.sourceID))continue;
   const rows=await this.control.read(source.sourceID),candidates=this.control.candidates.filter(p=>rows.some(r=>r.type===p.type));
   if(candidates.length!==1){token.excluded.add(source.sourceID);this.event('unsupported',source.name+': no unique source dB offset');continue;}
   const property=candidates[0],original=await this.value(source.sourceID,property),applied=original-6*property.units;
   if(!Number.isInteger(original)||original>12*property.units||applied<-60*property.units){token.excluded.add(source.sourceID);this.event('unsupported',source.name+': offset out of range');continue;}
   // Recheck route and value immediately before mutation; a source switch is not a pause command.
   const check=await this.inventory();if(!check.active.some(s=>s.sourceID===source.sourceID&&s.name===source.name))continue;
   if(await this.value(source.sourceID,property)!==original)continue;
   if(!token.allow||this.closed)break;
   const entry={sourceID:source.sourceID,name:source.name,property,original,applied,uncertain:true};
   this.entries.push(entry);try{await this.persist();}catch(e){this.entries=this.entries.filter(v=>v!==entry);throw e;}
   if(!token.allow||this.closed){this.entries=this.entries.filter(e=>e!==entry);await this.persist();break;}
   await this.control.write(entry.sourceID,property,applied);entry.uncertain=false;await this.persist();
   if(await this.value(entry.sourceID,property)!==applied)throw Error('Reduced music offset was not confirmed');
   if(!token.allow||this.closed){await this.restore(entry,check.sources);break;}
   this.status.apiConfirmed=true;this.status.sources=this.entries.map(e=>e.name);this.event('ducked',source.name+' -6 dB');
  }
 }
 async withVoice(permit,run,tailMs,mix){
  if(this.closed)return {ok:false,error:'Audio service stopping'};
  if(this.pending>=2)return {ok:false,retryable:true,error:'Voice queue busy'};
  this.pending++;
  const task=this.speech.then(async()=>{
   if(this.closed||permit&&!permit.live())return {ok:false,skipped:true};
   const enabled=(mix||this.s.audioMix||{}).musicDuck!==false;
   if(!enabled){
    this.status.apiConfirmed=false;this.status.sources=[];
    // Disabling new ducking must still restore any journal left by a crash.
    await this.serial(()=>this.recover()).catch(e=>{this.event('recovery-pending',e.message);this.scheduleRecovery();});
    if(!this.entries.length)this.event('disabled','Music ducking disabled in mixer');
    if(this.closed||permit&&!permit.live())return {ok:false,skipped:true};
    return run();
   }
   clearTimeout(this.recoveryTimer);this.recoveryTimer=null;
   this.status.apiConfirmed=false;this.status.sources=[];
   const token={allow:true,excluded:new Set()};this.token=token;let poll=null,watch=null,waiting=false,budget;
   try{
    const prepare=this.serial(async()=>{await this.recover();await this.reconcile(token);}).catch(e=>{token.allow=false;this.event('unavailable',e.message);});
    // Slow/unsupported OEM control must not hold up a camera warning. A late write
    // retains its journal and is restored by the serialized recovery operation.
    await Promise.race([prepare,new Promise(r=>{budget=setTimeout(()=>{token.allow=false;this.event('unavailable','Music preparation timed out; voice continues');r();},this.o.prepareMs||800);})]);clearTimeout(budget);
    if(!token.allow)this.serial(()=>this.recover()).catch(()=>{});
    if(this.closed||permit&&!permit.live())return {ok:false,skipped:true};
    watch=setTimeout(()=>{token.allow=false;this.serial(()=>this.recover()).catch(()=>{});},25000);
    poll=setInterval(()=>{if(waiting||!token.allow)return;waiting=true;this.serial(()=>this.reconcile(token)).catch(e=>{token.allow=false;this.event('unavailable',e.message);return this.serial(()=>this.recover());}).catch(()=>{}).then(()=>{waiting=false;});},500);
    const result=await run();
    if(result&&result.ok&&tailMs)await this.sleep(tailMs); // PCM queue + device latency, not the continuing beeper.
    return result;
   }finally{
    clearTimeout(budget);clearTimeout(watch);clearInterval(poll);token.allow=false;if(this.token===token)this.token=null;
    await this.serial(()=>this.recover()).catch(e=>{this.event('recovery-pending',e.message);this.scheduleRecovery();});
   }
  });
  this.speech=task.catch(()=>{});try{return await task;}finally{this.pending--;}
 }
 scheduleRecovery(){
  if(this.closed||this.recoveryTimer)return;
  this.recoveryTimer=setTimeout(()=>{this.recoveryTimer=null;this.serial(()=>this.recover()).catch(e=>{this.event('recovery-pending',e.message);this.scheduleRecovery();});},5000);
  if(this.recoveryTimer.unref)this.recoveryTimer.unref();
 }
 startRecovery(){if(fs.existsSync(this.file))this.serial(()=>this.recover()).catch(e=>{this.event('recovery-pending',e.message);this.scheduleRecovery();});}
 async close(){this.closed=true;if(this.token)this.token.allow=false;clearTimeout(this.recoveryTimer);await this.serial(()=>this.recover()).catch(e=>this.event('recovery-pending',e.message));if(this.control)await this.control.close();}
}
function wrapOutput(output,service,options){
 const speak=output.speak.bind(output);output.speak=(file,volume,permit)=>service.musicDucker&&volume>0?service.musicDucker.withVoice(permit,()=>speak(file,volume,permit),600,require('./mixer-settings').get(service,options)):speak(file,volume,permit);
 output.musicDuckWrapped=true;return output;
}
module.exports={MusicDucker,wrapOutput,musicName};
