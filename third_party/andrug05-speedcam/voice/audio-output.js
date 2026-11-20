'use strict';
const {isProfile}=require('./audio-profiles');
const {MixedOutput}=require('./pcm-output');
const {AlsaOutput}=require('./alsa-output');
const {createConverterOutput}=require('./converter-output');
class AudioOutput {
 constructor(service,options){this.s=service;this.options=options||{};this.profiles={};this.alsa=new AlsaOutput(service,options);this.fifo=new MixedOutput(service,options);this.converter=createConverterOutput(service,this.options,false);}
 get running(){return (this.pulse&&this.pulse.running)||Object.keys(this.profiles).map(k=>this.profiles[k].running).find(Boolean)||(this.stableConverter&&this.stableConverter.running)||this.alsa.running||this.converter.running||(this.overlayConverter&&this.overlayConverter.running)||this.fifo.running||(this.overlayAlsa&&this.overlayAlsa.running)||(this.overlayFifo&&this.overlayFifo.running);}
 get overlayRoute(){if(!this.overlayAdapter)this.overlayAdapter=new (require('./overlay-output').OverlayOutput)(this.s,this.options);return this.overlayAdapter;}
 get current(){
  if(this.s.audioBackend==='pulse'){if(!this.s.audioOverlay)throw Error('PulseAudio requires Overlay');if(!this.pulse)this.pulse=require('./pulse-output').createPulseOutput(this.s,this.options);return this.pulse;}
  if(isProfile(this.s.audioBackend)){if(!this.s.audioOverlay)throw Error('Converter profile requires Overlay');const b=this.s.audioBackend;if(!this.profiles[b])this.profiles[b]=createConverterOutput(this.s,Object.assign({},this.options,{stable:true,profile:b}),true);return this.profiles[b];}
  if(this.s.audioBackend==='converter-stable'){if(!this.s.audioOverlay)throw Error('Stable Converter requires Overlay');if(!this.stableConverter)this.stableConverter=createConverterOutput(this.s,Object.assign({},this.options,{stable:true}),true);return this.stableConverter;}
  if(!this.s.audioOverlay)return this.s.audioBackend==='converter'?this.converter:this.s.audioBackend==='alsa'?this.alsa:this.fifo;
  if(this.s.audioBackend==='converter'){if(!this.overlayConverter)this.overlayConverter=createConverterOutput(this.s,this.options,true);return this.overlayConverter;}
  if(this.s.audioBackend==='alsa'){if(!this.overlayAlsa)this.overlayAlsa=new AlsaOutput(this.overlayRoute,Object.assign({},this.options,{route:this.overlayRoute,overlay:true}));return this.overlayAlsa;}
  if(!this.overlayFifo)this.overlayFifo=new MixedOutput(this.overlayRoute,this.options);return this.overlayFifo;
 }
 set(r,owner){if(this.s.audioOverlay&&this.s.fileFallback)throw Error('Live beeper unavailable in M4A mode');return this.current.set(r,owner);}
 speak(file,volume,permit){const out=this.current,run=()=>out.speak(file,volume,permit);return !out.musicDuckWrapped&&this.s.musicDucker&&volume>0?this.s.musicDucker.withVoice(permit,run,600,require('./mixer-settings').get(this.s,this.options)):run();}
 clear(owner){[...Object.keys(this.profiles).map(k=>this.profiles[k]),this.pulse,this.stableConverter,this.alsa,this.converter,this.fifo,this.overlayAlsa,this.overlayConverter,this.overlayFifo].filter(Boolean).forEach(m=>m.clear(owner));}
 async releaseIdle(){if(this.pulse&&this.pulse.running){await this.pulse.finishSession();if(this.s.lastError)throw Error(this.s.lastError);}for(const k of Object.keys(this.profiles)){const out=this.profiles[k];if(out.running){if(out.pending())throw Error('Audio busy; wait for voice and beeper');await out.finishSession();if(out.s.lastError)throw Error(out.s.lastError);}}}
 async close(){await Promise.all([...Object.keys(this.profiles).map(k=>this.profiles[k]),this.pulse,this.stableConverter,this.alsa,this.converter,this.fifo,this.overlayAlsa,this.overlayConverter,this.overlayFifo].filter(Boolean).map(m=>m.close()));}
}
module.exports={AudioOutput};
