'use strict';
const fs=require('fs'),path=require('path');
const choices=Array.from({length:8},(_,i)=>({id:String(i+1),label:'Бипер '+(i+1)}));
function valid(id){if(typeof id!=='string'||!choices.some(c=>c.id===id))throw Error('Invalid beeper sound');return id;}
function owner(service){return service&&service.s||service;}
function pulse(service,read){const s=owner(service)||{},id=valid(s.beeperSound||'1');if(!s.beeperAsset||s.beeperAsset.id!==id){const pcm=read('beeper-choice-'+id+'.pcm');if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2||pcm.length>96000)throw Error('Invalid beeper PCM');s.beeperAsset={id,pcm};}return s.beeperAsset.pcm;}
class BeeperSounds {
 constructor(d,o){this.d=d;this.o=o||{};this.file=this.o.beeperFile||'/var/opt/bmwcaminfo-voice/beeper-sound.json';this.id='1';try{const v=JSON.parse(fs.readFileSync(this.file,'utf8'));if(v.version!==1)throw Error('Unknown beeper settings version');this.id=valid(v.id);}catch(e){if(e.code!=='ENOENT')this.loadError=e.message;}d.s.beeperSound=this.id;}
 snapshot(){return {ok:true,beeperSoundsProtocol:1,id:this.id,choices,loadError:this.loadError||null};}
 save(id){valid(id);this.d.mix.busy();const read=this.o.read||(n=>fs.readFileSync(path.join(this.o.root||'/var/opt/bmwcaminfo-voice/current','pcm',n)));pulse({beeperSound:id},read);const folder=path.dirname(this.file);if(!fs.existsSync(folder))fs.mkdirSync(folder);fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:1,id})+'\n',{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.id=id;this.d.s.beeperSound=id;this.d.s.beeperAsset=null;this.loadError=null;return this.snapshot();}
 async listen(r,alive){
  const id=valid(r.id),d=this.d,s=d.s;d.mix.busy();const volume=r.volume===undefined?40:r.volume;if(!Number.isInteger(volume)||volume<0||volume>100||volume%20)throw Error('Invalid preview volume');
  d.busy=true;s.diagnosticBusy=true;d.cancelled=false;const previous=s.beeperSound,previousAsset=s.beeperAsset,live=()=>!d.cancelled&&(!alive||alive());let output,timer,error;const who={};
  try{
   s.beeperSound=id;s.beeperAsset=null;
   if(s.fileFallback){const mix=Object.assign({},s.audioMix||require('./mixer-settings').DEFAULTS);mix.voice=mix.beeper;const result=await s.play('beeper-choice-'+id+'.m4a',volume,{live},{diagnostic:true,mixConfig:mix});if(!result.ok)throw Error(result.error||'Preview cancelled');}
   else{
    output=this.o.makeBeeperOutput?this.o.makeBeeperOutput(s):new (require('./audio-output').AudioOutput)(s,this.o);
    const beat=()=>{if(live()&&volume)try{output.set({cameraId:'beeper-choice-preview',intervalMs:1300,volume},who);}catch(e){error=e;}};beat();timer=setInterval(beat,400);
    await (this.o.sleep||sleep)(1800);clearInterval(timer);timer=null;output.clear(who);
    if(s.audioBackend==='converter-hold')await output.releaseIdle();else if(output.running)await output.running;
    if(error||s.lastError)throw error||Error(s.lastError);
   }
   if(!live())throw Error('Preview cancelled');return {ok:true,beeperSoundsProtocol:1,preview:id};
  }finally{clearInterval(timer);try{if(output){output.clear(who);await output.close();}}finally{s.beeperSound=previous;s.beeperAsset=previousAsset;d.busy=false;s.diagnosticBusy=false;}}
 }
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports={BeeperSounds,choices,valid,pulse};
