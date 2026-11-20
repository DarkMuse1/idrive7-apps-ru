'use strict';
// 24 kHz mono signed PCM. Both sources share one clock and one BMW player.
const RATE=24000, DUCK=0.25;
class PcmMixer {
 constructor(pulse,options){
  options=options||{};this.pulse=pulse;this.getPulse=options.getPulse||(()=>this.pulse);this.now=options.now||Date.now;
  this.getMix=options.getMix||(()=>require('./mixer-settings').DEFAULTS);this.diagnostics=!!options.diagnostics;this.resetSignalStats();
  this.beep=null;this.lastBeat=-Infinity;this.clock=0;this.tails=[];
  this.jobs=[];this.completed=[];this.speech=null;this.gain=1;this.limiter=1;
 }
 resetSignalStats(){this.signal={frames:0,voicePeak:0,beeperPeak:0,mixPeak:0,outputPeak:0,voiceSourceFullScaleSamples:0,beeperSourceFullScaleSamples:0,overFullScaleSamples:0,limitedSamples:0,minLimiterGain:1,outputSaturatedSamples:0,maxVoiceQueue:0,maxBeepTails:0};}
 signalStats(){return Object.assign({},this.signal);}
 set(request,owner){
  const i=request.intervalMs,v=request.volume;
  if(!Number.isInteger(i)||i<300||i>30000||i%100||!Number.isInteger(v)||v<10||v>100||v%10||typeof request.cameraId!=='string'||request.cameraId.length>200)throw Error('Invalid beeper state');
  if(!this.beep||this.beep.cameraId!==request.cameraId)this.lastBeat=-Infinity;
  this.beep={cameraId:request.cameraId,intervalMs:i,volume:v,owner,expires:this.now()+1200};
 }
 clear(owner){if(this.beep&&this.beep.owner===owner)this.beep=null;}
 live(){return !!(this.beep&&this.beep.expires>this.now());}
 enqueue(pcm,volume,permit){
  if(this.jobs.length+(this.speech?1:0)>=2)return Promise.resolve({ok:false,retryable:true,error:'Voice queue busy'});
  return new Promise(resolve=>this.jobs.push({pcm,volume,permit,resolve,pos:0,expires:this.now()+8000}));
 }
 pending(){
  this.jobs=this.jobs.filter(j=>{if(this.now()>=j.expires||(j.permit&&!j.permit.live())){j.resolve({ok:false,skipped:true});return false;}return true;});
  return this.live()||this.tails.length||this.speech||this.jobs.length;
 }
 fail(message){
  if(this.speech){this.speech.resolve({ok:false,error:message});this.speech=null;}
  this.jobs.splice(0).forEach(j=>j.resolve({ok:false,error:message}));
  this.completed.splice(0).forEach(j=>j.resolve({ok:false,error:message}));
  this.tails=[];this.beep=null;
 }
 acknowledge(){this.completed.splice(0).forEach(j=>j.resolve({ok:true,message:'PCM voice written to playback stream'}));}
 render(frames){
  const mix=this.getMix(),out=Buffer.alloc(frames*2);
  if(this.diagnostics)this.signal.maxVoiceQueue=Math.max(this.signal.maxVoiceQueue,this.jobs.length+(this.speech?1:0));
  for(let i=0;i<frames;i++,this.clock++){
   if(!this.speech){
    while(this.jobs.length){
     const j=this.jobs.shift();
     if(this.now()>=j.expires||(j.permit&&!j.permit.live())){j.resolve({ok:false,skipped:true});continue;}
     this.speech=j;if(j.permit&&j.permit.started)j.permit.started();break;
    }
   }
   const active=this.live();
   if(active&&(this.clock-this.lastBeat)*1000/RATE>=this.beep.intervalMs){
    this.lastBeat=this.clock;this.tails.push({pos:0,volume:this.beep.volume/100,pulse:this.getPulse()});
   }
   // Clearing/expiring the lease stops new pulses; already started samples
   // finish naturally. Speech still ducks those tails until their end.
   const target=active||this.tails.length?(this.speech?mix.duck/100:1):0;
   const step=1/(RATE*(target<this.gain?0.025:0.180));
   this.gain+=Math.max(-step,Math.min(step,target-this.gain));
   let b=0;
   this.tails=this.tails.filter(t=>{if(t.pos>=t.pulse.length/2)return false;const raw=t.pulse.readInt16LE(2*t.pos++);if(this.diagnostics&&Math.abs(raw)>=32767)this.signal.beeperSourceFullScaleSamples++;b+=raw/32768*t.volume*mix.beeper/100;return true;});
   let v=0;
   if(this.speech){const j=this.speech,raw=j.pcm.readInt16LE(j.pos++*2);if(this.diagnostics&&Math.abs(raw)>=32767)this.signal.voiceSourceFullScaleSamples++;v=raw/32768*j.volume/100*mix.voice/100;
    if(j.pos>=j.pcm.length/2){this.speech=null;this.completed.push(j);}
   }
   const sum=v+b*this.gain, needed=Math.min(1,0.96/Math.max(0.000001,Math.abs(sum)));
   this.limiter=Math.min(needed,this.limiter+1/(RATE*0.1));
   const sample=Math.round(sum*this.limiter*32767);
   if(this.diagnostics){const d=this.signal;d.frames++;d.voicePeak=Math.max(d.voicePeak,Math.abs(v));d.beeperPeak=Math.max(d.beeperPeak,Math.abs(b));d.mixPeak=Math.max(d.mixPeak,Math.abs(sum));d.outputPeak=Math.max(d.outputPeak,Math.abs(sample)/32768);if(Math.abs(sum)>1)d.overFullScaleSamples++;if(this.limiter<.999999)d.limitedSamples++;d.minLimiterGain=Math.min(d.minLimiterGain,this.limiter);if(Math.abs(sample)>=32767)d.outputSaturatedSamples++;d.maxBeepTails=Math.max(d.maxBeepTails,this.tails.length);}
   out.writeInt16LE(sample,i*2);
  }
  return out;
 }
}
function wavHeader(bytes){
 const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(bytes+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(RATE,24);b.writeUInt32LE(RATE*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(bytes,40);return b;
}
module.exports={PcmMixer,wavHeader,RATE,DUCK};
