'use strict';
// Explicit engineering experiment only. Never used as an automatic voice backend.
const path=require('path');
const {isProfile}=require('./audio-profiles');
const {readList}=require('./command-control');
const {MixedOutput}=require('./pcm-output');
const ok=r=>r&&(r.amError==='E_OK'||r.amError===0);
const connected=c=>c&&['CS_CONNECTED',2].includes(c.connectionState);
const valid=n=>Number.isInteger(n)&&n>0&&n<=65535;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class OverlayProbe {
 constructor(service,options){this.s=service;this.o=options||{};this.sleep=this.o.sleep||sleep;this.last=null;this.uncertain=false;}
 async inventory(){
  await this.s.init();if(this.s.inventoryError)throw Error(this.s.inventoryError);
  const lists=await Promise.all(['listOfMainSources','listOfMainSinks','listOfMainConnections'].map(k=>readList(this.s.cc,k)));
  const sources=lists[0].filter(s=>/^OAPGenericOverlay$/i.test(s.name||''));
  const sinks=lists[1].filter(s=>s.name==='MediaSink_Front');
  if(sources.length!==1||!valid(sources[0].sourceID))throw Error('OapGenericOverlay source is not uniquely advertised');
  if(sinks.length!==1||!valid(sinks[0].sinkID))throw Error('MediaSink_Front is not uniquely advertised; no output guessed');
  const source=sources[0],sink=sinks[0];
  if(!source.availability||!['A_AVAILABLE',1].includes(source.availability.availability))throw Error('OapGenericOverlay source unavailable; availability was not changed');
  if(lists[2].some(c=>c.sourceID===source.sourceID))throw Error('OapGenericOverlay is busy; existing route left untouched');
  const carplay=lists[0].filter(s=>/^CarPlayMedia$/i.test(s.name||'')).map(s=>s.sourceID);
  return {sourceID:source.sourceID,sinkID:sink.sinkID,before:lists[2],carplay};
 }
 async scan(backend){
  if(backend&&!['pulse','pcm','converter','converter-stable','converter-hold','converter-reset','converter-period','alsa','file'].includes(backend))throw Error('Invalid Overlay backend');
  const p=await this.inventory();let mp;
  if(backend==='pulse'){
   const record=this.s.pulseDiagnostics={at:new Date().toISOString(),backend,experimental:true,stage:'preflight',accepted:false,hardwareAudibilityConfirmed:false};
   try{await this.o.alsa.checkConverterStream();const runtime=new (require('./pulse-runtime').PulseRuntime)(this.o);const pulse=await runtime.check();record.runtime=pulse;record.stage='preflight-passed';return {ok:true,overlayProtocol:2,pulseProtocol:1,backend,sourceID:p.sourceID,sinkID:p.sinkID,pulse,carplayConnected:p.before.some(c=>p.carplay.includes(c.sourceID)&&connected(c)),duckingConfirmed:false};}
   catch(e){record.error=e.message;record.stage='preflight-failed';throw e;}
  }
  try{
   let alsa=null;if(backend==='converter'||backend==='converter-stable'||isProfile(backend)){alsa={available:true,profile:await this.o.alsa.checkConverterStream()};if(isProfile(backend)&&alsa.profile.converterProfilesProtocol!==1)throw Error('Обновите звуковой компонент: профили Converter отсутствуют');if(backend==='converter-stable'&&alsa.profile.stableMixerProtocol!==1)throw Error('Обновите звуковой компонент: тестовый нативный микшер отсутствует');}else if(backend==='alsa'){alsa=await this.o.alsa.scanOverlay();if(!alsa.available)throw Error(alsa.error);}else mp=await this.s.createOverlayPlayer();
   return {ok:true,overlayProbeSupported:true,overlayProtocol:2,converterProfilesProtocol:1,backend:backend||'file',sourceID:p.sourceID,sinkID:p.sinkID,instance:'OapGenericOverlay',alsa,carplayConnected:p.before.some(c=>p.carplay.includes(c.sourceID)&&connected(c)),duckingConfirmed:false};
  }
  finally{await this.dispose(mp);}
 }
 async dispose(mp){if(mp&&typeof mp.shutdown==='function'){try{await mp.shutdown();}catch(e){}}}
 async testConverter(alive){
  this.last=null;
  const record=this.lastConverter={at:new Date().toISOString(),probeProfile:'media-overlay-converter',backend:'alsa',kind:'both',stage:'discovery',accepted:false,audibleConfirmed:false,duckingConfirmed:false};
  try{
   record.discovery=await this.o.alsa.checkConverter();
   if(!alive())throw Error('Overlay test cancelled');
   record.stage='route-and-playback';
   const result=await this.test(alive,{backend:'alsa',kind:'both',probeProfile:'media-overlay-converter'});
   Object.assign(record,result.overlay,{stage:'completed'});
   return Object.assign({},result,{converterProtocol:1,overlaySaveSupported:false});
  }catch(e){
   if(this.last&&this.last.probeProfile==='media-overlay-converter')Object.assign(record,this.last);
   record.error=e.message;record.stage='failed';throw e;
  }
 }
 async test(alive,request){
  const backend=request&&request.backend||'file',combined=!!request;
  const converter=backend==='converter'||backend==='converter-stable'||isProfile(backend)||request&&request.probeProfile==='media-overlay-converter';
  const comparison=request&&['smartx-direct','plug-stable'].includes(request.probeProfile)&&backend==='converter-stable';
  if(request&&request.probeProfile&&!comparison&&(!converter||backend!=='alsa'))throw Error('Invalid experimental profile');
  if(!['pulse','pcm','converter','converter-stable','converter-hold','converter-reset','converter-period','alsa','file'].includes(backend)||combined&&request.kind!=='both'&&!(comparison&&request.kind==='voice'))throw Error('Invalid combined Overlay test');
  if(backend==='pulse')return this.testPulse(alive);
  if(converter)return this.testUnifiedConverter(alive,backend,comparison?request:null);
  if(backend==='converter')await this.o.alsa.checkConverterStream();
  if(backend==='alsa'){if(converter)await this.o.alsa.checkConverter();else await this.o.alsa.checkOverlay();}
  const permit=alive,deadline=Date.now()+20000;alive=()=>permit()&&Date.now()<deadline;
  if(this.uncertain)throw Error('Previous Overlay route cleanup is uncertain; restart the sound service before another probe');
  this.last=null;
  const p=await this.inventory();if(!alive())throw Error('Overlay test cancelled');
  // This experiment needs ongoing CarPlay playback; route presence is necessary,
  // but the user still confirms that the phone was actually playing music.
  const music=p.before.filter(c=>p.carplay.includes(c.sourceID)&&c.sinkID===p.sinkID&&connected(c));
  if(!music.length)throw Error('No connected CarPlayMedia route on MediaSink_Front. Start CarPlay music first');
  let mp,connection=null,pendingConnect=false,failure=null,cleanup=null,observedPause=false,routePreserved=true,accepted=false,streamResult=null;
  const sample=()=>readList(this.s.cc,'listOfMainConnections');
  const sameMusic=routes=>music.every(c=>routes.some(r=>r.mainConnectionID===c.mainConnectionID&&r.sourceID===c.sourceID&&r.sinkID===c.sinkID&&connected(r)));
  try{
   if(backend!=='alsa'&&backend!=='converter')mp=await this.s.createOverlayPlayer();if(!alive())throw Error('Overlay test cancelled');
   pendingConnect=true;
   const r=await this.s.cc.callMethod('connect',{sourceID:p.sourceID,sinkID:p.sinkID},3000);
   pendingConnect=false;
   if(ok(r)&&!valid(r.mainConnectionID)){this.uncertain=true;throw Error('BMW accepted Overlay without a usable connection ID; restart sound service before retry');}
   if(!ok(r))throw Error('BMW rejected Overlay route: '+String(r&&r.amError));
   connection=r.mainConnectionID;
   let ready=false;
   for(let i=0;i<15&&alive();i++){
    const routes=await sample();routePreserved=routePreserved&&sameMusic(routes);
    if(!routePreserved){observedPause=true;throw Error('CarPlay route changed during Overlay connection; probe aborted');}
    if(routes.some(c=>c.mainConnectionID===connection&&c.sourceID===p.sourceID&&c.sinkID===p.sinkID&&connected(c))){ready=true;break;}
    await this.sleep(150);
   }
   if(!ready||!alive())throw Error('Overlay route did not become ready or test cancelled');
   if(backend==='file'){
   const file=path.join(this.o.root||'/var/opt/bmwcaminfo-voice/current',combined?'diagnostics/'+require('./speech-language').file('both.m4a'):'audio/volume-40/'+require('./speech-language').file('strelka.m4a'));
   const played=await mp.callMethod('playFile',{path:file,languageCode:7695972},3000);
   if(!played||played.EntError!=='OK')throw Error('Overlay MediaPlayer rejected test phrase');
   accepted=true;
   const manifest=require('./audio-manifest');
   const duration=combined?6:manifest[require('./speech-language').file('strelka.m4a')]&&manifest[require('./speech-language').file('strelka.m4a')].durationSeconds;
   if(!(duration>0&&duration<10))throw Error('Invalid Overlay sample duration');
   // Permit decoder startup and the complete short phrase. No global STOP/PLAY.
   const ticks=Math.ceil((duration*1000+1800)/250);
   for(let i=0;i<ticks;i++){
    if(!alive())throw Error('Overlay test cancelled');
    await this.sleep(250);
    const routes=await sample();routePreserved=routePreserved&&sameMusic(routes);
    if(!routePreserved){observedPause=true;throw Error('CarPlay route changed during phrase; probe aborted');}
   }
   }else{
    // Separate player/route adapter: never overwrite the regular M4A service.
    let active=true,monitorError=null,monitor=null,mixer=null,timer=null;
    const live=()=>active&&alive()&&!monitorError;
    const watch=async()=>{while(active){await this.sleep(250);if(!active)break;try{routePreserved=routePreserved&&sameMusic(await sample());if(!routePreserved){observedPause=true;throw Error('CarPlay route changed during stream');}if(!alive())throw Error('Overlay test cancelled');}catch(e){monitorError=e;active=false;if(mixer)await mixer.close();if(backend==='alsa'||backend==='converter')this.o.alsa.stop();}}};
    try{
     monitor=watch();
     if(backend==='alsa'||backend==='converter'){streamResult=await this.o.alsa.stream('both',live,converter?'converter':true);accepted=true;}
     else{
      const adapter={mp,waitAvailable:async()=>{if(!live())throw Error('Overlay test cancelled');},connectAudio:async()=>{},release:async()=>{}};
      mixer=this.o.makeMixer?this.o.makeMixer(adapter):new MixedOutput(adapter);
      const owner={},beat=()=>{if(live())mixer.set({cameraId:'overlay-pcm-test',intervalMs:700,volume:40},owner);};
      beat();timer=setInterval(()=>{try{beat();}catch(e){monitorError=e;}},400);
      const spoken=await mixer.speak('camera-500.m4a',40,{live});
      if(!spoken.ok)throw Error(spoken.error||'Overlay PCM test failed');
      await this.sleep(1200);clearInterval(timer);timer=null;mixer.clear(owner);
      if(mixer.running)await mixer.running;
      if(adapter.lastError)throw Error(adapter.lastError);
      accepted=true;
     }
     if(monitorError)throw monitorError;if(!alive())throw Error('Overlay test cancelled');
    }finally{active=false;if(timer)clearInterval(timer);if(mixer)await mixer.close();if(backend==='alsa'||backend==='converter')this.o.alsa.stop();if(monitor)await monitor;}
   }
  }catch(e){failure=e;}
  finally{
   if(pendingConnect){this.uncertain=true;cleanup='Overlay connect timed out: ownership unknown; no unrelated route touched';}
   if(connection!==null){
    try{
     const routes=await sample(),own=routes.find(c=>c.mainConnectionID===connection);
     if(own){
      if(own.sourceID!==p.sourceID||own.sinkID!==p.sinkID)throw Error('Overlay connection ID changed owner');
      const r=await this.s.cc.callMethod('disconnect',{mainConnectionID:connection},3000);if(!ok(r))throw Error('BMW did not confirm Overlay disconnect');
     }
     let after=await sample();
     for(let i=0;i<10&&after.some(c=>c.mainConnectionID===connection&&c.sourceID===p.sourceID);i++){await this.sleep(100);after=await sample();}
     if(after.some(c=>c.mainConnectionID===connection&&c.sourceID===p.sourceID))throw Error('Overlay connection still present after disconnect');
     routePreserved=routePreserved&&sameMusic(after);
    }catch(e){cleanup=e.message;this.uncertain=true;}
   }
   await this.dispose(mp);
  }
  this.last={at:new Date().toISOString(),instance:'OapGenericOverlay',backend,kind:combined?'both':'voice',sourceID:p.sourceID,sinkID:p.sinkID,accepted,carplayRoutePreserved:routePreserved,routeInterruptionObserved:observedPause,duckingConfirmed:false,audibleConfirmed:false,error:failure&&failure.message,cleanupError:cleanup};
  if(converter){this.last.probeProfile='media-overlay-converter';this.last.stream=streamResult;}
  console.log('OVERLAY_PROBE '+JSON.stringify(this.last));
  if(failure||cleanup)throw Error([failure&&failure.message,cleanup].filter(Boolean).join('; '));
  return {ok:true,overlayProtocol:2,overlay:this.last,requiresListening:true};
 }
 async testPulse(alive){
  if(this.uncertain)throw Error('Previous Overlay route cleanup is uncertain');
  this.last={at:new Date().toISOString(),backend:'pulse',kind:'both',accepted:false,audibleConfirmed:false,duckingConfirmed:false};
  try{const run=this.o.testPulseOutput||require('./pulse-output').testPulseOutput;const result=await run(this.s,this.o,alive);Object.assign(this.last,result,{accepted:true});return {ok:true,overlayProtocol:2,pulseProtocol:1,overlay:this.last,requiresListening:true};}
  catch(e){this.last.error=e.message;if(/cleanup uncertain|ownership uncertain|still present/.test(e.message)){this.uncertain=true;this.last.cleanupError=e.message;}throw e;}
 }
 async testUnifiedConverter(alive,backend,comparison){
  if(this.uncertain)throw Error('Previous Overlay route cleanup is uncertain; restart sound service before another probe');
  this.last={at:new Date().toISOString(),instance:'OapGenericOverlay',backend,kind:'both',probeProfile:'media-overlay-converter',outputMechanism:'shared-runtime-converter',accepted:false,audibleConfirmed:false,duckingConfirmed:false};
  if(comparison)Object.assign(this.last,{kind:comparison.kind,probeProfile:comparison.probeProfile,outputMechanism:'native-stable-'+comparison.probeProfile});
  else if(backend==='converter-stable')this.last.outputMechanism='native-stable-plug';
  else if(isProfile(backend))Object.assign(this.last,{probeProfile:backend,outputMechanism:'shared-converter-profile',profile:backend});
  const deadline=Date.now()+(isProfile(backend)?60000:20000),live=()=>alive()&&Date.now()<deadline;
  try{
   const p=await this.inventory();
   if(!isProfile(backend)&&!p.before.some(c=>p.carplay.includes(c.sourceID)&&c.sinkID===p.sinkID&&connected(c)))throw Error('No connected CarPlayMedia route on MediaSink_Front. Start CarPlay music first');
   if(!live())throw Error('Converter test cancelled');
   const run=this.o.testConverterOutput||require('./converter-output').testConverterOutput;
   const result=await run(this.s,Object.assign({},this.o,{profile:isProfile(backend)?backend:null,stable:backend==='converter-stable'||isProfile(backend),direct:backend==='smartx'||!!comparison&&comparison.probeProfile==='smartx-direct',kind:comparison?comparison.kind:'both'}),live);
   Object.assign(this.last,result,{accepted:true,carplayRoutePreserved:true,routeInterruptionObserved:false,error:null,cleanupError:null});
   return {ok:true,overlayProtocol:2,overlay:this.last,requiresListening:true};
  }catch(e){this.last.error=e.message;if(/cleanup uncertain/.test(e.message)){this.uncertain=true;this.last.cleanupError=e.message;}throw e;}
  finally{if(comparison){if(!this.s.audioComparisons)this.s.audioComparisons=[];this.s.audioComparisons.push(JSON.parse(JSON.stringify(this.last)));if(this.s.audioComparisons.length>12)this.s.audioComparisons.shift();}console.log('OVERLAY_PROBE '+JSON.stringify(this.last));}
 }
}
module.exports={OverlayProbe};
