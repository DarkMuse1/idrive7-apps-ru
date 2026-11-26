'use strict';
const fs=require('fs'),path=require('path');
const {readList}=require('./command-control');
const {OverlayOutput}=require('./overlay-output');
const connected=c=>c&&['CS_CONNECTED',2].includes(c.connectionState);
const valid=n=>Number.isInteger(n)&&n>0&&n<=65535;
class CarplayDuckProbe {
 constructor(service,options){
  this.s=service;this.o=options||{};this.sleep=this.o.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
  this.journal=this.o.duckJournal||'/var/opt/bmwcaminfo-voice/carplay-duck-pending.json';
  this.reportFile=this.o.duckReport||'/var/opt/bmwcaminfo-voice/carplay-duck-last.json';this.busy=false;
 }
 persist(file,data){const dir=path.dirname(file);if(!fs.existsSync(dir))fs.mkdirSync(dir);fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);}
 async identity(){
  const sources=await readList(this.s.cc,'listOfMainSources'),p=sources.filter(x=>x.name==='CarPlayMedia');
  if(p.length!==1||!valid(p[0].sourceID))throw Error('CarPlayMedia is not uniquely advertised');return p[0].sourceID;
 }
 async value(control,id,property){const p=(await control.read(id)).filter(x=>x.type===property.type);if(p.length!==1)throw Error('Source offset is missing or ambiguous');return p[0].value;}
 async restore(control){
  if(!fs.existsSync(this.journal))return 'not-needed';
  const j=JSON.parse(fs.readFileSync(this.journal,'utf8')),p=j.property;
  if(j.schema!==1||!valid(j.sourceID)||!p||!control.candidates.some(c=>c.name===p.name&&c.type===p.type&&c.units===p.units)||!Number.isInteger(j.original)||!Number.isInteger(j.applied)||j.original-j.applied!==6*p.units||j.applied<-60*p.units||j.original>12*p.units)throw Error('Invalid pending ducking recovery record');
  if(await this.identity()!==j.sourceID)throw Error('CarPlay identity changed; recovery pending');
  let current=await this.value(control,j.sourceID,p),result='already-restored';
  if(current===j.applied){
   await control.write(j.sourceID,p,j.original);
   if(await this.value(control,j.sourceID,p)!==j.original)throw Error('BMW did not confirm restored CarPlay offset');
   result='restored';
  }else if(current!==j.original)result='external-change-preserved';
  // A timed-out write can still arrive late. Keep the record for a later
  // recovery pass until a restore is acknowledged or an external change seen.
  if(j.uncertain&&result==='already-restored')throw Error('Previous offset write outcome unknown; recovery pending');
  fs.unlinkSync(this.journal);return result;
 }
 async run(live,recoveryOnly){
  if(this.busy)throw Error('CarPlay ducking test busy');this.busy=true;
  const report={at:new Date().toISOString(),duckProtocol:1,backend:'file',overlay:true,attenuationDb:6,apiConfirmed:false,audibleConfirmed:false,duckingConfirmed:false,continuousBeeper:false,restoration:'not-needed',properties:[]};
  let control,output,changed=false,writeConfirmed=false,deadline=Date.now()+20000;
  const alive=()=>Date.now()<deadline&&(!live||live());
  const guard=()=>{if(!alive())throw Error('CarPlay ducking test cancelled or timed out');};
  try{
   await this.s.init();guard();control=await this.s.createCarplayDuckingControl();guard();
   report.restoration=await this.restore(control);
   if(recoveryOnly){report.recoveryOnly=true;return report;}
   guard();const id=await this.identity();report.sourceID=id;
   report.properties=await control.read(id);guard();
   const candidates=control.candidates.filter(c=>report.properties.some(p=>p.type===c.type));
   if(candidates.length!==1)throw Error('No unambiguous source-only dB volume offset; no volume changed');
   const property=candidates[0],original=await this.value(control,id,property),applied=original-6*property.units;
   if(original>12*property.units||applied<-60*property.units)throw Error('Source offset outside bounded test range');
   report.property=property;report.original=original;report.applied=applied;
   output=this.o.makeDuckOutput?this.o.makeDuckOutput():new OverlayOutput(this.s,this.o);
   await output.connectAudio('file',alive);guard();
   const profile=output.profile,music=profile.before.filter(c=>c.sourceID===id&&c.sinkID===profile.sinkID&&connected(c));
   if(music.length!==1)throw Error('Start CarPlay music first; active front route required');
   const checkRoute=async()=>{const routes=await readList(this.s.cc,'listOfMainConnections');if(!music.every(m=>routes.some(c=>c.mainConnectionID===m.mainConnectionID&&c.sourceID===id&&c.sinkID===m.sinkID&&connected(c))))throw Error('CarPlay route changed; test stopped');};
   await checkRoute();guard();
   if(await this.value(control,id,property)!==original)throw Error('CarPlay offset changed before test');
   const journal={schema:1,sourceID:id,property,original,applied,uncertain:true};
   this.persist(this.journal,journal);changed=true;
   await control.write(id,property,applied);writeConfirmed=true;journal.uncertain=false;this.persist(this.journal,journal);guard();
   if(await this.value(control,id,property)!==applied)throw Error('BMW did not confirm reduced CarPlay offset');
   await checkRoute();guard();
   const file=path.join(this.o.root||'/var/opt/bmwcaminfo-voice/current','audio/volume-40/'+require('./speech-language').file('strelka.m4a'));
   const duration=require('./audio-manifest')[require('./speech-language').file('strelka.m4a')].durationSeconds;
   if(!(duration>0&&duration<10))throw Error('Invalid test phrase duration');
   const r=await output.mp.callMethod('playFile',{path:file,languageCode:7695972},3000);
   if(!r||r.EntError!=='OK')throw Error('Overlay rejected M4A test phrase');
   report.playAccepted=true;
   for(let i=0;i<Math.ceil((duration*1000+1800)/250);i++){
    guard();await this.sleep(250);guard();await checkRoute();
    if(i%2===0&&await this.value(control,id,property)!==applied)throw Error('Source offset changed externally; test stopped');
   }
   report.apiConfirmed=true;
  }catch(e){report.error=e.message;}
  finally{
   if(changed&&control)try{report.restoration=await this.restore(control);}catch(e){report.restoration='pending';report.restoreError=e.message;}
   if(output)try{await output.release();}catch(e){report.routeCleanupError=e.message;}
   if(control)try{await control.close();}catch(e){report.proxyCleanupError=e.message;}
   if(changed&&!writeConfirmed)report.writeOutcome='uncertain';
   report.recoveryPending=fs.existsSync(this.journal);this.busy=false;
   try{this.persist(this.reportFile,report);}catch(e){report.reportError=e.message;}
   this.last=report;console.log('CARPLAY_DUCK_PROBE '+JSON.stringify(report));
  }
  return report;
 }
}
module.exports={CarplayDuckProbe};
