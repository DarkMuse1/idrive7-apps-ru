'use strict';
// Explicitly selected runtime route. Never changes music transport or availability.
const {OverlayProbe}=require('./overlay-probe');
const {readList}=require('./command-control');
const {AlsaDiagnostics}=require('./alsa-diagnostics');
const valid=n=>Number.isInteger(n)&&n>0&&n<=65535;
const ok=r=>r&&(r.amError==='E_OK'||r.amError===0);
const connected=c=>c&&['CS_CONNECTED',2].includes(c.connectionState);
class OverlayOutput {
 constructor(service,options){
  this.s=service;this.o=options||{};this.probe=new OverlayProbe(service,this.o);
  this.alsa=this.o.alsa||new AlsaDiagnostics(service,this.o);
  this.sleep=this.o.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
  this.mp=null;this.connection=null;this.uncertain=false;this.busy=false;
  this.disableFileFallback=true;this.fileFallback=false;
 }
 get audioMix(){return this.s.audioMix;}
 get lastError(){return this.s.lastError;} set lastError(v){this.s.lastError=v;}
 get ready(){return this.s.ready;} set ready(v){this.s.ready=v;}
 async waitAvailable(live){if(live&&!live())throw Error('Overlay playback cancelled');this.live=live;await this.s.init();}
 async connectAudio(backend,live){
  if(this.busy)throw Error('Overlay output busy');
  if(this.uncertain)throw Error('Overlay route ownership uncertain; restart sound service');
  live=live||this.live;this.busy=true;let pending=false;
  try{
   if(backend==='converter')await this.alsa.checkConverterStream();else if(backend==='alsa')await this.alsa.checkOverlay();
   this.profile=await this.probe.inventory();
   if(live&&!live())throw Error('Overlay playback cancelled');
   if(backend!=='alsa'&&backend!=='converter')this.mp=await this.s.createOverlayPlayer();
   if(live&&!live())throw Error('Overlay playback cancelled');
   pending=true;
   const r=await this.s.cc.callMethod('connect',{sourceID:this.profile.sourceID,sinkID:this.profile.sinkID},3000);
   pending=false;
   if(!ok(r))throw Error('BMW rejected Overlay route: '+String(r&&r.amError));
   if(!valid(r.mainConnectionID)){this.uncertain=true;throw Error('Overlay connection ID missing');}
   this.connection=r.mainConnectionID;
   for(let i=0;i<15;i++){
    if(live&&!live())throw Error('Overlay playback cancelled');
    const routes=await readList(this.s.cc,'listOfMainConnections');
    // No CarPlay dependency: warnings also work when there is no music playing.
    const music=this.profile.before.filter(c=>this.profile.carplay.includes(c.sourceID)&&connected(c)&&c.sinkID===this.profile.sinkID);
    if(!music.every(c=>routes.some(r=>r.mainConnectionID===c.mainConnectionID&&r.sourceID===c.sourceID&&r.sinkID===c.sinkID&&connected(r))))throw Error('CarPlay route changed while connecting Overlay');
    if(routes.some(c=>c.mainConnectionID===this.connection&&c.sourceID===this.profile.sourceID&&c.sinkID===this.profile.sinkID&&connected(c)))return;
    await this.sleep(150);
   }
   throw Error('Overlay route did not become ready');
  }catch(e){if(pending)this.uncertain=true;try{await this.release();}catch(cleanup){throw Error(e.message+'; '+cleanup.message);}throw e;}
 }
 async release(){
  const id=this.connection;this.connection=null;
  try{
   if(id!==null){
    let routes=await readList(this.s.cc,'listOfMainConnections');const own=routes.find(c=>c.mainConnectionID===id);
    if(own){
     if(own.sourceID!==this.profile.sourceID||own.sinkID!==this.profile.sinkID)throw Error('Overlay connection ID changed owner');
     const r=await this.s.cc.callMethod('disconnect',{mainConnectionID:id},3000);
     if(!ok(r))throw Error('BMW did not confirm Overlay disconnect');
    }
    for(let i=0;i<10;i++){
     routes=await readList(this.s.cc,'listOfMainConnections');
     if(!routes.some(c=>c.mainConnectionID===id&&c.sourceID===this.profile.sourceID))break;
     if(i===9)throw Error('Overlay route still present after disconnect');
     await this.sleep(100);
    }
   }
  }catch(e){this.uncertain=true;throw e;}
  finally{await this.probe.dispose(this.mp);this.mp=null;this.busy=false;}
 }
 async withRoute(kind,live,run){await this.connectAudio(this.o.converter?'converter':'alsa',live);try{return await run();}finally{await this.release();}}
}
module.exports={OverlayOutput};
