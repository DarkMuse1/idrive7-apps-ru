'use strict';
// Passive, bounded RAM history. No timers, filesystem writes or audio mutations.
const KEEP=16;
function clock(){const t=process.hrtime();return t[0]*1000+t[1]/1e6;}
function history(service){
 const s=service.s||service;
 if(!s.audioBufferHistory)s.audioBufferHistory={schema:2,scope:'ALSA/Converter streams; M4A and FIFO not instrumented',retention:'RAM until sound service restart',interpretation:'Write callbacks mean pipe acceptance, not speaker playback. Input/write gaps may include normal backpressure. Only native underruns confirm ALSA EPIPE. Signal peaks are normalized PCM before the driver; limiter activity or queue gaps alone do not prove audible distortion.',startedAt:new Date().toISOString(),total:0,streams:[],lastFailure:null,lastRuntime:null,lastProbe:null,lastRuntimeFailure:null,lastProbeFailure:null};
 return s.audioBufferHistory;
}
function start(service,options){
 const h=history(service),o=options||{},r={id:++h.total,origin:o.diagnosticOrigin==='probe'?'probe':'runtime',backend:o.converter?'converter':'alsa',overlay:!!o.overlay,startedAt:new Date().toISOString(),status:'active',phase:'route',requestedLatencyMs:192,chunkMs:20,chunks:0,submittedFrames:0,backpressureCount:0,maxWriteCallbackMs:0,maxPumpGapMs:0,maxRenderMs:0,writeCallbacksOver64Ms:0,pumpGapsOver64Ms:0,events:[],queueSnapshots:[],native:null};
 h.streams.push(r);while(h.streams.length>KEEP)h.streams.shift();
 h[r.origin==='runtime'?'lastRuntime':'lastProbe']=r;
 return r;
}
function event(r,type,detail){r.events.push({at:new Date().toISOString(),type,detail:String(detail||'').slice(0,300)});if(r.events.length>12)r.events.shift();}
function native(r,v){
 if(!v||typeof v!=='object')return;
 const clean={};
 ['bufferFrames','periodFrames','bufferMs','periodMs','bufferParamsKnown','xruns','underruns','suspends','recoveries','recoveryFailures','writeErrors','inputPollTimeouts','maxInputGapMs','maxWriteGapMs','maxWriteCallMs','maxReadCallMs','framesWritten','pendingFrames','rate','channels','streamCompleted','queueCapacityFrames','queueFrames','queueHighWaterFrames','queueLowWaterFrames','queueCapacityMs','prefillTargetMs','prefillWaitMs','queueEmptyEvents','maxQueueEmptyMs','maxNoProgressMs','eagainCount','waitTimeouts','waitErrors','lastWaitResult','lastAlsaError','maxWaitMs','alsaState','availableFrames','delayFrames','delayError'].forEach(k=>{if(typeof v[k]==='boolean'||typeof v[k]==='number'&&Number.isFinite(v[k]))clean[k]=v[k];});
 if(!Object.keys(clean).length)return;
 if(clean.underruns>(r.native&&r.native.underruns||0))event(r,'underrun',clean.underruns);
 if(clean.waitErrors>(r.native&&r.native.waitErrors||0))event(r,'alsa-wait-error',clean.lastAlsaError);
 if(clean.queueEmptyEvents>(r.native&&r.native.queueEmptyEvents||0))event(r,'pcm-queue-empty',clean.queueEmptyEvents);
 if(typeof clean.queueFrames==='number'){if(!r.queueSnapshots)r.queueSnapshots=[];r.queueSnapshots.push(Object.assign({at:new Date().toISOString()},clean));if(r.queueSnapshots.length>8)r.queueSnapshots.shift();}
 r.native=Object.assign({},r.native||{},clean);r.lastNativeAt=new Date().toISOString();
}
function finish(service,r,error){if(r.status!=='active')return;r.status=error?'error':'complete';r.phase='finished';r.finishedAt=new Date().toISOString();if(error){r.error=String(error.message||error).slice(0,1200);event(r,'error',r.error);const h=history(service);h.lastFailure=JSON.parse(JSON.stringify(r));h[r.origin==='runtime'?'lastRuntimeFailure':'lastProbeFailure']=h.lastFailure;}}
module.exports={start,event,native,finish,clock,history};
