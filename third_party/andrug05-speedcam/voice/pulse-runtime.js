'use strict';
// A private server, never the vehicle's default PulseAudio instance.
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const DEVICE='plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function config(socket,cookie){
 if(!/^\/[a-zA-Z0-9_/.:-]+$/.test(socket))throw Error('Unsafe PulseAudio socket path');
 if(!/^\/[a-zA-Z0-9_/.:-]+$/.test(cookie||''))throw Error('Unsafe PulseAudio cookie path');
 return '.fail\nload-module module-alsa-sink sink_name=speedcam_overlay device='+DEVICE+' format=s16le rate=24000 alternate_rate=24000 channels=1 channel_map=mono tsched=0 mmap=0 fragments=8 fragment_size=1200 deferred_volume=0\n'+
 'load-module module-native-protocol-unix socket='+socket+' auth-anonymous=0 auth-cookie-enabled=1 auth-cookie='+cookie+'\nset-default-sink speedcam_overlay\n';
}
class PulseRuntime {
 constructor(options){this.o=options||{};this.root=path.join(this.o.root||'/var/opt/bmwcaminfo-voice/current','pulse');this.exec=this.o.pulseExec||cp.execFile;this.spawn=this.o.pulseSpawn||cp.spawn;this.children=[];this.error=null;this.log='';this.closing=false;this.stats={protocol:1,experimental:true,device:DEVICE,rate:24000,channels:1,format:'s16le',requestedSinkMs:200,requestedClientMs:200,tsched:false,mmap:false,streams:2,stderr:''};}
 env(){return Object.assign({},process.env,{LD_LIBRARY_PATH:[path.join(this.root,'lib'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),PULSE_RUNTIME_PATH:this.dir||'/run/bmwcaminfo-voice',PULSE_STATE_PATH:this.dir||'/run/bmwcaminfo-voice',PULSE_CONFIG_PATH:this.dir||'/run/bmwcaminfo-voice',PULSE_CLIENTCONFIG:this.dir?path.join(this.dir,'client.conf'):'/dev/null',PULSE_COOKIE:this.cookie||'/dev/null',PULSE_SERVER:this.socket?'unix:'+this.socket:'unix:/run/bmwcaminfo-voice/no-default-pulse',LC_ALL:'C'});}
 command(bin,args){return new Promise((resolve,reject)=>this.exec(path.join(this.root,'bin',bin),args,{env:this.env(),timeout:2500,maxBuffer:16384},(e,out,err)=>e?reject(Error('PulseAudio '+bin+': '+String(err||e.message).slice(-700))):resolve(String(out))));}
 async check(){
  if((this.o.platform||process.platform)!=='linux'||(this.o.arch||process.arch)!=='x64')throw Error('PulseAudio: нужен Linux x86_64 MGU; Windows-эмулятор не проверяет аудиотракт');
  for(const name of ['bin/pulseaudio','bin/pacat','bin/pactl','lib/module-alsa-sink.so','lib/module-native-protocol-unix.so'])if(!fs.existsSync(path.join(this.root,name)))throw Error('PulseAudio: отсутствует '+name+'. Установите экспериментальный звуковой компонент');
  const version=(await this.command('pulseaudio',['--version'])).trim();
  if(!/^pulseaudio 5\.0\b/.test(version))throw Error('PulseAudio: непроверенная версия '+version);
  await this.command('pacat',['--version']);await this.command('pactl',['--version']);
  this.stats.version=version;return Object.assign({},this.stats,{available:true,hardwareTested:false});
 }
 child(bin,args){
  const p=this.spawn(path.join(this.root,'bin',bin),args,{env:this.env(),stdio:['pipe','ignore','pipe']});
  const entry={p,bin,done:false,draining:false,code:null};this.children.push(entry);
  p.on('error',e=>{entry.done=true;this.error=Error('PulseAudio '+bin+': '+e.message);});
  p.stdin.on('error',e=>{if(!this.closing)this.error=Error('PulseAudio stream: '+e.message);});
  p.stderr.on('data',b=>{this.log=(this.log+bin+': '+String(b)).slice(-4096);this.stats.stderr=this.log;});
  entry.exit=new Promise(resolve=>{p.on('close',(code,signal)=>{entry.done=true;entry.code=code;if(!this.closing&&(code!==0||!entry.draining))this.error=Error('PulseAudio '+bin+' exited: '+code+' '+(signal||'')+' '+this.log.slice(-600));resolve();});p.on('error',resolve);});
  return entry;
 }
 assert(){if(this.error)throw this.error;if(this.closing)throw Error('PulseAudio stopping');}
 async start(live){
  if(!this.stats.version)await this.check();if(!live())throw Error('PulseAudio cancelled');
  const base=this.o.pulseRunDir||'/run/bmwcaminfo-voice';
  this.dir=fs.mkdtempSync(path.join(base,'pulse-'));fs.chmodSync(this.dir,0o700);this.socket=path.join(this.dir,'native');
  this.cookie=path.join(this.dir,'cookie');this.stats.stage='private-cookie';
  // PA 5.0 loads a cookie even with auth-anonymous=1. Never depend on /root.
  fs.writeFileSync(this.cookie,crypto.randomBytes(256),{mode:0o600,flag:'wx'});
  this.stats.authentication='private-cookie';
  fs.writeFileSync(path.join(this.dir,'client.conf'),'autospawn = no\nenable-shm = no\ncookie-file = '+this.cookie+'\n',{mode:0o600});
  fs.writeFileSync(path.join(this.dir,'daemon.conf'),'flat-volumes = no\nrealtime-scheduling = no\nhigh-priority = no\ndefault-sample-format = s16le\ndefault-sample-rate = 24000\nalternate-sample-rate = 24000\ndefault-sample-channels = 1\ndefault-channel-map = mono\nresample-method = trivial\nenable-shm = no\n',{mode:0o600});
  fs.writeFileSync(path.join(this.dir,'private.pa'),config(this.socket,this.cookie),{mode:0o600});
  this.stats.stage='daemon-start';
  this.server=this.child('pulseaudio',['-n','--file='+path.join(this.dir,'private.pa'),'--daemonize=no','--use-pid-file=no','--system=no','--disable-shm=yes','--exit-idle-time=-1','--disallow-exit=yes','--disallow-module-loading=yes','--dl-search-path='+path.join(this.root,'lib'),'--log-target=stderr','--log-level=notice']);
  const deadline=Date.now()+8000;let last='';
  while(Date.now()<deadline){
   this.assert();if(!live())throw Error('PulseAudio cancelled');
   try{const sinks=await this.command('pactl',['--server=unix:'+this.socket,'list','short','sinks']);
    const rows=sinks.trim().split('\n').filter(Boolean);if(rows.length!==1||!/^\d+\s+speedcam_overlay\s+module-alsa-sink\.c\s+s16le 1ch 24000Hz\s/.test(rows[0]))throw Error('Unexpected PulseAudio sink: '+sinks.slice(0,500));
    this.stats.sink=sinks.trim();this.stats.stage='sink-ready';break;
   }catch(e){last=e.message;await sleep(100);}
  }
  if(!this.stats.sink)throw Error('PulseAudio sink not ready: '+last+' '+this.log.slice(-600));
  this.streams=['voice','beeper'].map(name=>this.child('pacat',['--server=unix:'+this.socket,'--device=speedcam_overlay','--playback','--raw','--format=s16le','--rate=24000','--channels=1','--channel-map=mono','--latency-msec=200','--process-time-msec=20','--client-name=SpeedCAM-'+name,'--stream-name='+name]));
  this.stats.stage='streams-started';
 }
 write(entry,buffer){this.assert();return new Promise((resolve,reject)=>{let done=false;const finish=e=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve();};const timer=setTimeout(()=>finish(Error('PulseAudio stream backpressure timeout')),1500);try{entry.p.stdin.write(buffer,finish);}catch(e){finish(e);}});}
 async writePair(voice,beeper){this.assert();await Promise.all([this.write(this.streams[0],voice),this.write(this.streams[1],beeper)]);}
 async drain(){
  this.assert();this.streams.forEach(e=>{e.draining=true;e.p.stdin.end();});
  let timer;try{await Promise.race([Promise.all(this.streams.map(e=>e.exit)),new Promise((r,j)=>{timer=setTimeout(()=>j(Error('PulseAudio drain timeout')),4000);})]);this.assert();this.stats.drained=true;}finally{clearTimeout(timer);}
 }
 close(){if(!this.closeTask)this.closeTask=this.closeOwned();return this.closeTask;}
 async closeOwned(){
  this.closing=true;
  // Only child PIDs owned by this instance. Never pulseaudio -k or killall.
  for(const e of this.children)if(!e.done)e.p.kill('SIGTERM');
  const waitAll=Promise.all(this.children.map(e=>e.exit));let timer;
  try{await Promise.race([waitAll,new Promise(r=>{timer=setTimeout(r,1500);})]);}finally{clearTimeout(timer);}
  for(const e of this.children)if(!e.done)e.p.kill('SIGKILL');
  let killTimer;try{await Promise.race([waitAll,new Promise(r=>{killTimer=setTimeout(r,1000);})]);}finally{clearTimeout(killTimer);}
  if(this.children.some(e=>!e.done))throw Error('PulseAudio child cleanup uncertain');
  if(this.dir){for(const name of fs.readdirSync(this.dir)){const p=path.join(this.dir,name);if(!fs.lstatSync(p).isDirectory())try{fs.unlinkSync(p);}catch(e){}}try{fs.rmdirSync(this.dir);}catch(e){}}
 }
}
module.exports={PulseRuntime,config,DEVICE};
