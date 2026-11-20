'use strict';
const fs=require('fs'),path=require('path');
const DEFAULTS=Object.freeze({voice:100,beeper:100,duck:25,musicDuck:true});
function validate(v){if(!v||!['voice','beeper'].every(k=>Number.isInteger(v[k])&&v[k]>=0&&v[k]<=100&&v[k]%20===0)||![10,25,50,75,100].includes(v.duck))throw Error('Invalid mixer settings');if(v.musicDuck!==undefined&&typeof v.musicDuck!=='boolean')throw Error('Invalid music duck setting');return {voice:v.voice,beeper:v.beeper,duck:v.duck,musicDuck:v.musicDuck===undefined?DEFAULTS.musicDuck:v.musicDuck};}
function get(service,options){return options&&options.getMix?options.getMix():service&&service.audioMix||DEFAULTS;}
function fileVolume(volume,config){const v=volume*config.voice/100;return v===0?0:Math.max(10,Math.min(100,Math.round(v/10)*10));}
class MixerSettings {
 constructor(d,o){this.d=d;this.o=o||{};this.file=this.o.mixerFile||'/var/opt/bmwcaminfo-voice/audio-mixer.json';this.values=Object.assign({},DEFAULTS);try{const r=JSON.parse(fs.readFileSync(this.file,'utf8'));if(r.version!==1)throw Error('Unknown mixer settings version');this.values=validate(r.values);}catch(e){if(e.code!=='ENOENT')this.loadError=e.message;}d.s.audioMix=this.values;}
 snapshot(){return {ok:true,mixerProtocol:1,musicDuckProtocol:1,musicDucking:this.duckStatus(),values:Object.assign({},this.values),defaults:Object.assign({},DEFAULTS),loadError:this.loadError||null,backend:this.d.s.fileFallback?'file':this.d.s.audioBackend,overlay:!!this.d.s.audioOverlay};}
 duckStatus(){return this.d.s.musicDucker?this.d.s.musicDucker.snapshot():{state:'not-tested',apiConfirmed:false,audibleConfirmed:false};}
 busy(){const d=this.d,s=d.s;if(d.busy||s.speechPending||s.musicDucker&&s.musicDucker.pending||s.mixer&&s.mixer.running)throw Error('Audio busy; wait for the current warning');}
 save(v){this.busy();const values=validate(v),folder=path.dirname(this.file);if(!fs.existsSync(folder))fs.mkdirSync(folder);fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:1,values})+'\n',{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.values=values;this.d.s.audioMix=values;this.loadError=null;return this.snapshot();}
 async listen(r,alive){
  this.busy();const values=validate(r.values),volume=r.volume===undefined?40:r.volume;if(!Number.isInteger(volume)||volume<0||volume>100||volume%20)throw Error('Invalid preview volume');
  const d=this.d,s=d.s;d.busy=true;s.diagnosticBusy=true;d.cancelled=false;let output=null,timer=null,error=null;const owner={},live=()=>!d.cancelled&&(!alive||alive());
  try{
   if(s.fileFallback){const result=await s.play('camera-500.m4a',volume,{live},{diagnostic:true,mixConfig:values});if(!result.ok)throw Error(result.error||'Preview cancelled');return {ok:true,mixerProtocol:1,voiceOnly:true,values,musicDuckProtocol:1,musicDucking:this.duckStatus()};}
   output=new (require('./audio-output').AudioOutput)(s,Object.assign({},this.o,{getMix:()=>values}));
   const beat=()=>{if(!live())return;try{output.set({cameraId:'mixer-preview',intervalMs:700,volume:volume||10},owner);}catch(e){error=e;}};
   if(volume){beat();timer=setInterval(beat,400);}
   await (this.o.sleep||sleep)(600);if(!live()||error)throw error||Error('Preview cancelled');
   const result=await output.speak('camera-500.m4a',volume,{live});if(!result.ok)throw Error(result.error||'Preview cancelled');
   await (this.o.sleep||sleep)(900);clearInterval(timer);timer=null;output.clear(owner);
   if(s.audioBackend==='converter-hold')await output.releaseIdle();else if(output.running)await output.running;if(s.lastError)throw Error(s.lastError);if(!live()||error)throw error||Error('Preview cancelled');
   return {ok:true,mixerProtocol:1,voiceOnly:false,values,musicDuckProtocol:1,musicDucking:this.duckStatus()};
  }finally{clearInterval(timer);try{if(output){output.clear(owner);await output.close();}}finally{d.busy=false;s.diagnosticBusy=false;}}
 }
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports={MixerSettings,DEFAULTS,validate,get,fileVolume};
