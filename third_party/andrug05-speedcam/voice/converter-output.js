'use strict';
const {AlsaOutput}=require('./alsa-output');
const {readList}=require('./command-control');
const connected=c=>c&&['CS_CONNECTED',2].includes(c.connectionState);
// Both the saved runtime and its engineering test construct exactly this output.
// The test schedules events; it does not implement another PCM writer or route.
function createConverterOutput(service,options,overlay){
 const o=Object.assign({},options||{},{converter:true,overlay:!!overlay});
 if(overlay)o.route=new (require('./overlay-output').OverlayOutput)(service,o);
 const output=o.stable?new (require('./stable-output').StableOutput)(service,o):new AlsaOutput(service,o);
 return require('./music-ducker').wrapOutput(output,service,o);
}
async function testConverterOutput(service,options,alive){
 const o=options||{},output=createConverterOutput(service,Object.assign({},o,{diagnosticOrigin:'probe'}),true),owner={};
 const sleep=o.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
 let timer=null,watch=null,failure=null,checking=false,stopped=false;
 const live=()=>!failure&&!stopped&&alive();
 const fail=e=>{if(!failure)failure=e;output.close().catch(()=>{});};
 const beat=()=>{try{if(!live())throw Error('Converter test cancelled');output.set({cameraId:'converter-test',intervalMs:700,volume:40},owner);}catch(e){fail(e);}};
 try{
  if(o.kind!=='voice'){beat();timer=setInterval(beat,400);}
  watch=setInterval(async()=>{
   if(checking||stopped)return;checking=true;
   try{
    if(!live())throw failure||Error('Converter test cancelled');
    const p=output.route.profile;
    if(p){const rows=await readList(service.cc,'listOfMainConnections');if(stopped)return;
     const music=p.before.filter(c=>p.carplay.includes(c.sourceID)&&c.sinkID===p.sinkID&&connected(c));
     if(!music.every(c=>rows.some(r=>r.mainConnectionID===c.mainConnectionID&&r.sourceID===c.sourceID&&r.sinkID===c.sinkID&&connected(r))))throw Error('CarPlay route changed during Converter test');
    }
   }catch(e){if(!stopped)fail(e);}finally{checking=false;}
  },250);
  await sleep(1000);
  if(!live())throw failure||Error('Converter test cancelled');
  const rounds=o.profile?3:1;
  for(let i=0;i<rounds;i++){
   if(i&&o.kind!=='voice'){beat();timer=setInterval(beat,400);}
   if(!live())throw failure||Error('Converter test cancelled');
   const spoken=await output.speak('camera-500.m4a',40,{live});
   if(!spoken.ok)throw Error(spoken.error||'Converter voice skipped');
   await sleep(o.profile?350:1500);
   clearInterval(timer);timer=null;output.clear(owner);
   if(o.profile==='converter-hold')await sleep(650);
   else if(output.running)await output.running;
   if(i+1<rounds)await sleep(400);
  }
  if(o.profile==='converter-hold')await output.finishSession();
  if(output.running)await output.running;
  if(failure)throw failure;
  if(!alive())throw Error('Converter test cancelled');
  if(service.lastError)throw Error(service.lastError);
  if(!output.lastStream)throw Error('Converter stream completion missing');
  const p=output.route.profile;
  return {sourceID:p.sourceID,sinkID:p.sinkID,stream:output.lastStream,bufferRecordId:output.telemetryRecord&&output.telemetryRecord.id};
 }finally{
  stopped=true;clearInterval(timer);clearInterval(watch);output.clear(owner);
  await output.close();
  if(output.route.uncertain)throw Error('Converter Overlay route cleanup uncertain; restart sound service');
 }
}
module.exports={createConverterOutput,testConverterOutput};
