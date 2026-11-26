'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');

const SOCKET = '/run/bmwcaminfo-voice/ctl.sock';
const ROOT = '/var/opt/bmwcaminfo-voice/current';
const SRC_ID = 1046;
const SINK_ID = 1024;
const LANG = 7695972;
const SERVICE_VERSION='0.1.52';
const ASSETS = require('./audio-manifest.json');
const ALLOWED = Object.create(null);
Object.keys(ASSETS).forEach(function (file) {
  var duration = ASSETS[file].durationSeconds;
  if (!/^[a-z0-9-]+\.m4a$/.test(file) || typeof duration !== 'number' || !(duration > 0 && duration < 20)) {
    throw new Error('Invalid voice asset manifest: ' + file);
  }
  // Hold the BMW audio route for the full recording, including startup margin.
  ALLOWED[file] = Math.max(file === 'camera-200.m4a' ? 6500 : 4000, Math.ceil(duration * 1000) + 1000);
});

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function log(message) {
  console.log(new Date().toISOString() + ' ' + message);
}

function VoiceService() {
  this.cc = null;
  this.mp = null;
  this.queue = Promise.resolve();
  this.ready = false;
  this.lastError = null;
  this.ccAvailable = false;
  this.mpAvailable = false;
  this.connectionId = null;
  this.previousConnections = [];
  this.previousPlayerState = null;
  this.playerState = null;
}

VoiceService.prototype.init = function () {
  if(this.cc&&this.mp)return Promise.resolve();
  if(!this.initializing)this.initializing=this.initialize().then(()=>{this.initializing=null;},e=>{this.initializing=null;throw e;});
  return this.initializing;
};
VoiceService.prototype.initialize = async function () {
  if (this.cc && this.mp) return;
  var someip = require('/usr/lib/someip.node');
  var roots = ['/usr/lib/oap-mainapp/src-gen', '/usr/lib/oap-mainapp21/src-gen'];
  var root = null;
  for (var i = 0; i < roots.length; i++) {
    if (fs.existsSync(path.join(roots[i], 'org_genivi_am_commandinterface_CommandControl.json')) &&
        fs.existsSync(path.join(roots[i], 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'))) {
      root = roots[i];
      break;
    }
  }
  if (!root) throw new Error('BMW SOME/IP definitions not found');
  this.proxyRoot=root;
  function read(name) {
    return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  }
  const schemas=require('./audio-schema');
  let command=read('org_genivi_am_commandinterface_CommandControl.json');
  this.inventoryError=null;
  try{command=schemas.extendAudioSchema(command,schemas.COMMAND,schemas.INVENTORIES);}
  catch(e){this.inventoryError=e.message;log('AUDIO_INVENTORY: '+e.message);}
  // Keep OEM connect/disconnect and MediaPlayer unchanged for saved M4A.
  var cc = await someip.buildProxy(command, '1');
  await cc.init();
  var mp = await someip.buildProxy(read('de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json'), 'OapGenericMedia');
  await mp.init();
  var self = this;
  mp.subscribe({ name: 'playerState', onReceive: function (value) {
    self.playerState = value;
    log('MediaPlayer playerState: ' + JSON.stringify(value));
  }});
  this.cc = cc;
  this.mp = mp;
  log('BMW SOME/IP proxies initialized');
};

VoiceService.prototype.waitAvailable = async function (live) {
  if(live&&!live())return false;
  await this.init();
  var deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if(live&&!live())return false;
    try {
      this.ccAvailable = await this.cc.isAvailable();
      this.mpAvailable = await this.mp.isAvailable();
    } catch (error) {
      this.ccAvailable = false;
      this.mpAvailable = false;
      this.lastError = error && error.message ? error.message : String(error);
    }
    if (this.ccAvailable && this.mpAvailable) {
      this.ready = true;
      this.lastError = null;
      log('BMW services available: CommandControl=true MediaPlayer=true');
      return;
    }
    await sleep(500);
  }
  this.ready = false;
  throw new Error('BMW audio services unavailable after 60 seconds (CommandControl=' +
    this.ccAvailable + ', MediaPlayer=' + this.mpAvailable + ')');
};

VoiceService.prototype.createRoutingObserver = async function () {
  await this.init();
  const someip=require('/usr/lib/someip.node');
  const schemas=require('./audio-schema');
  const file=path.join(this.proxyRoot,'org_genivi_am_routinginterface_RoutingControlObserver.json');
  const original=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  const definition=schemas.extendAudioSchema(original,schemas.ROUTING,['hookSourceAvailablityStatusChange']);
  const p=await someip.buildProxy(definition,'1');await p.init();
  const end=Date.now()+2500;while(!(await p.isAvailable())){if(Date.now()>end)throw Error('BMW routing observer unavailable');await sleep(100);}
  return p;
};

VoiceService.prototype.createOverlayPlayer = async function () {
  await this.init();
  const name='de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
  const definition=JSON.parse(fs.readFileSync(path.join(this.proxyRoot,name.replace(/\./g,'_')+'.json'),'utf8'));
  let declared=definition.instances||{};
  try{const c=JSON.parse(fs.readFileSync(require('./audio-schema').CATALOG,'utf8'));declared=Object.assign({},c.instanceIDs&&c.instanceIDs[name]||{},declared);}catch(e){}
  if(!Object.prototype.hasOwnProperty.call(declared,'OapGenericOverlay'))throw Error('OapGenericOverlay instance not declared in BMW catalog');
  definition.instances=declared;
  const p=await require('/usr/lib/someip.node').buildProxy(definition,'OapGenericOverlay');
  try{
    await p.init();
    if(typeof p.subscribeToAvailability==='function')p.subscribeToAvailability(()=>{});
    for(let i=0;i<15;i++){if(await p.isAvailable())return p;await sleep(150);}
    throw Error('OapGenericOverlay MediaPlayer unavailable');
  }catch(e){try{if(p.shutdown)await p.shutdown();}catch(ignore){}throw e;}
};

VoiceService.prototype.createCarplayDuckingControl = async function () {
  await this.init();
  const factory=require('./carplay-duck-control');
  const original=JSON.parse(fs.readFileSync(path.join(this.proxyRoot,'org_genivi_am_commandinterface_CommandControl.json'),'utf8'));
  const spec=factory.definition(original);
  const proxy=await require('/usr/lib/someip.node').buildProxy(spec.schema,'1');
  try{
    await proxy.init();
    if(!(await proxy.isAvailable()))throw Error('BMW source-property control unavailable');
    return factory.createControl(proxy,spec);
  }catch(e){try{if(proxy.shutdown)await proxy.shutdown();}catch(ignore){}throw e;}
};

VoiceService.prototype.play = async function (file, volume, permit, internal) {
  file=require('./speech-language').file(file);
  if(this.diagnosticBusy&&!(internal&&internal.diagnostic))return {ok:false,retryable:true,error:'Engineering audio test active'};
  if (!ALLOWED[file]) throw new Error('Unsupported voice asset');
  if(volume===undefined)volume=100;
  if(typeof volume!=='number'||!Number.isFinite(volume)||volume<0||volume>100||volume%10!==0)throw new Error('Invalid voice volume');
  if(volume===0)return {ok:true,muted:true};
  // Keep one request deadline and one started event across a failed stream
  // and the regular-file retry. Never replay expired/cancelled warnings.
  const expires=Date.now()+8000;
  const originalPermit=permit;let reportedStart=false;
  permit={live:()=>Date.now()<expires&&(!originalPermit||originalPermit.live()),started:()=>{
    if(!reportedStart){reportedStart=true;if(originalPermit&&originalPermit.started)originalPermit.started();}
  }};
  if(this.mixer&&!this.fileFallback){
    const result=await this.mixer.speak(file,volume,permit);
    if(result.ok||result.skipped||!this.fileFallback)return result;
    // MixedOutput has released the failed FIFO route before enabling fallback.
    log('PCM unavailable; retrying voice using a regular M4A file');
  }
  volume=require('./mixer-settings').fileVolume(volume,internal&&internal.mixConfig||this.audioMix||require('./mixer-settings').DEFAULTS);
  if(!volume)return {ok:true,muted:true};
  if((this.speechPending||0)>=2)return {ok:false,retryable:true,error:'Voice queue busy'};
  const live=()=>Date.now()<expires&&(!permit||permit.live());
  var self = this;
  this.speechPending=(this.speechPending||0)+1;
  var task = this.queue.then(async function () {
    if(!live())return {ok:false,skipped:true};
    const output=self.audioOverlay?self.mixer.overlayRoute:self;
    await output.waitAvailable(live);
    if(!live())return {ok:false,skipped:true};
    var audio = volume===100?path.join(ROOT,'audio',file):path.join(ROOT,'audio','volume-'+volume,file);
    if (!fs.existsSync(audio)) throw new Error((volume===100?'Voice asset missing: ':'Volume asset missing: ') + audio);
    if(!live())return {ok:false,skipped:true};
    await output.connectAudio();
    try {
      if(!live())return {ok:false,skipped:true};
      // Keep the original M4A route lifetime, but restore music after the phrase
      // plus decoder margin instead of ducking the remaining route hold silence.
      const duckHold=self.musicDucker?Math.min(ALLOWED[file],Math.ceil(ASSETS[file].durationSeconds*1000)+600):ALLOWED[file];
      const playFile=async()=>{
        if(!live())return {ok:false,skipped:true};
        if(permit&&permit.started)permit.started();
        const result=await output.mp.callMethod('playFile',{path:audio,languageCode:LANG},7000);
        log('playFile: '+JSON.stringify(result));
        if(!result||result.EntError!=='OK')throw Error('BMW MediaPlayer rejected audio: '+JSON.stringify(result));
        await sleep(duckHold);
        return {ok:true};
      };
      const played=self.musicDucker?await self.musicDucker.withVoice({live},playFile,0,internal&&internal.mixConfig||self.audioMix):await playFile();
      if(!played.ok)return played;
      if(duckHold<ALLOWED[file])await sleep(ALLOWED[file]-duckHold);
    } finally {
      await output.release();
    }
    self.lastError = null;
    return { ok: true, message: 'BMW MediaPlayer accepted playback' };
  });
  this.queue = task.catch(function (error) {
    self.lastError = error && error.message ? error.message : String(error);
    self.ready = false;
    log('PLAY_FAILED: ' + (error && error.stack || error));
    return { ok: false, error: self.lastError };
  });
  this.queue=this.queue.then(function(result){self.speechPending--;return result;});
  return this.queue;
};

VoiceService.prototype.readConnections = function () {
  if(this.inventoryError)return Promise.reject(Error(this.inventoryError));
  return require('./command-control').readList(this.cc,'listOfMainConnections');
};
VoiceService.prototype.connectAudio = async function () {
    const sinkID=this.routeSinkId||SINK_ID;
    this.ownsConnection=false;
    try {
      var existing = await this.readConnections();
      const own=(Array.isArray(existing)?existing:[]).find(c=>c&&c.sinkID===sinkID&&c.sourceID===SRC_ID);
      if(own){this.connectionId=own.mainConnectionID;this.previousConnections=[];return;}
      this.previousConnections = (Array.isArray(existing) ? existing : []).filter(function (c) {
        return c && c.sinkID === sinkID && c.sourceID !== SRC_ID;
      });
      log('audio routes before voice: ' + JSON.stringify(this.previousConnections));
    } catch (routeError) {
      if(this.diagnosticBusy)throw Error('Cannot inspect audio routes: '+routeError.message);
      this.previousConnections = [];
      this.previousPlayerState = null;
      log('could not inspect existing audio routes: ' + routeError.message);
    }
    var connected = await this.cc.callMethod('connect', { sourceID: SRC_ID, sinkID: sinkID }, 7000);
    log('connect: ' + JSON.stringify(connected));
    if (!connected || (connected.amError !== 'E_OK' && connected.amError !== 'E_ALREADY_EXISTS')) {
      throw new Error('BMW audio route failed: ' + JSON.stringify(connected));
    }
    this.ownsConnection=connected.amError==='E_OK';
    this.connectionId = connected.mainConnectionID;
};

VoiceService.prototype.release = async function () {
  this.lastRestoreError=null;
  var id = this.ownsConnection===false?null:this.connectionId;
  this.ownsConnection=false;
  this.connectionId = null;
  if (!this.mp || !this.cc) return;
  // Do not send PAUSE or STOP here. Those buttons are delivered to the generic
  // MediaPlayer and can pause the user's music as well as the short voice item.
  // Let the voice file finish, then release only our temporary AudioManager route.
  if (id !== null && id !== undefined && id !== -1) {
    try {
      var disconnected = await this.cc.callMethod('disconnect', { mainConnectionID: id }, 5000);
      log('audio route released: ' + JSON.stringify(disconnected));
      if(this.diagnosticBusy&&(!disconnected||disconnected.amError!=='E_OK'))this.lastRestoreError='BMW did not confirm route disconnect';
    } catch (e2) { this.lastRestoreError=e2.message;log('disconnect: ' + e2.message); }
  }
  await sleep(700);
  await this.restorePreviousAudio();
  if(this.diagnosticBusy&&this.lastRestoreError)throw Error('Audio restoration failed: '+this.lastRestoreError);
};

VoiceService.prototype.restorePreviousAudio = async function () {
  var previous = this.previousConnections || [];
  if (!previous.length || !this.cc) {
    this.previousConnections = [];
    this.previousPlayerState = null;
    return;
  }
  try {
    var current = await this.readConnections();
    current = Array.isArray(current) ? current : [];
    log('audio routes after voice disconnect: ' + JSON.stringify(current));
    for (var i = 0; i < previous.length; i++) {
      var wanted = previous[i];
      var present = current.some(function (c) {
        return c && c.sourceID === wanted.sourceID && c.sinkID === wanted.sinkID;
      });
      if (!present) {
        var restored = await this.cc.callMethod('connect', {
          sourceID: wanted.sourceID,
          sinkID: wanted.sinkID
        }, 7000);
        log('restore previous audio route ' + wanted.sourceID + '->' + wanted.sinkID + ': ' + JSON.stringify(restored));
        if (!restored || (restored.amError !== 'E_OK' && restored.amError !== 'E_ALREADY_EXISTS')) {
          throw new Error('could not restore previous route ' + wanted.sourceID + '->' + wanted.sinkID + ': ' + JSON.stringify(restored));
        }
      }
    }
    if (this.previousPlayerState === 'PLAYER_STATE_PLAY') {
      await sleep(350);
      var resumed = await this.mp.callMethod('sendButtonEvent', { button: 'PLAY', action: 'PRESS' }, 5000);
      log('resume previous music with PLAY: ' + JSON.stringify(resumed));
    }
  } catch (e) {
    this.lastRestoreError=e.message;
    log('RESTORE_PREVIOUS_AUDIO_FAILED: ' + (e && e.stack || e));
    this.lastError = 'Audio restore: ' + (e && e.message ? e.message : String(e));
  } finally {
    this.previousConnections = [];
    this.previousPlayerState = null;
  }
};

var voice = new VoiceService();
// New installations use PulseAudio with Overlay. ChannelDiagnostics
// applies an explicit saved route afterwards, including working M4A + Overlay.
voice.audioBackend='pulse';voice.audioOverlay=true;voice.fileFallback=false;voice.fileFallbackReason=null;
var beeper = voice.mixer = new (require('./audio-output').AudioOutput)(voice);
var diagnostics=new (require('./channel-diagnostics').ChannelDiagnostics)(voice,{serviceVersion:SERVICE_VERSION});
voice.musicDucker=new (require('./music-ducker').MusicDucker)(voice);
diagnostics.reportShare.initialize().catch(function(e){log('REPORT_NETWORK_CLEANUP: '+e.message);});
// Recover only our recorded source offset after an interrupted engineering test.
// Normal startup and the saved M4A/Overlay selection are untouched without a journal.
if(fs.existsSync(diagnostics.duck.journal))diagnostics.handle({action:'audio-carplay-duck-recover'},()=>true).then(r=>log('CARPLAY_DUCK_RECOVERY '+JSON.stringify(r)),e=>log('CARPLAY_DUCK_RECOVERY '+e.message)).then(()=>voice.musicDucker.startRecovery());
else voice.musicDucker.startRecovery();

function reply(socket, payload) {
  try { socket.write(JSON.stringify(payload) + '\n'); } catch (e) {}
}

var server = net.createServer(function (socket) {
  socket.setEncoding('utf8');
  let connected=true,activeVoice=false;
  socket.on('close',()=>{connected=false;});
  socket.on('error',()=>{connected=false;});
  socket.on('close',function(){beeper.clear(socket);});
  socket.on('error',function(){beeper.clear(socket);});
  var buffer = '';
  socket.on('data', function (chunk) {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 32768) {
      reply(socket, { ok: false, error: 'Request too large' });
      socket.destroy();
      return;
    }
    var newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      var line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      var request;
      try { request = JSON.parse(line); } catch (e) {
        reply(socket, { ok: false, error: 'Invalid JSON' });
        continue;
      }
      if(request.action==='map-storage-prepare'){
        require('./map-storage-helper').prepareAsync(request).then(r=>reply(socket,r),e=>reply(socket,{ok:false,mapStorageProtocol:1,error:e.code||e.message}));
        continue;
      }
      require('./speech-language').set(request.language);
      // GPS evidence is allowed only on read-only report requests. Other commands keep the old limit.
      if(Buffer.byteLength(line)>4096&&['audio-report','audio-report-share-start'].indexOf(request.action)<0){
        reply(socket,{ok:false,error:'Request too large'});continue;
      }
      if (['beeper-sounds-get','beeper-sounds-save','beeper-sounds-listen','audio-mixer-get','audio-mixer-save','audio-mixer-listen','audio-report-share-start','audio-report-share-status','audio-report-share-stop','audio-report','audio-current','audio-scan','audio-test','audio-save','audio-reset','audio-stop','audio-overlay-scan','audio-overlay-test','audio-overlay-converter-test','audio-carplay-duck-test','audio-carplay-duck-recover'].includes(request.action)) {
        diagnostics.handle(request,()=>connected).then(r=>reply(socket,r),e=>reply(socket,{ok:false,error:e.message}));
      } else if (request.action === 'beeper' || request.action === 'beeper-v2' || request.action === 'beeper-v3') {
        try { if(voice.diagnosticBusy)throw Error('Engineering audio test active');reply(socket,beeper.set(request,socket)); } catch(error) { reply(socket,{ok:false,error:error.message}); }
      } else if (request.action === 'play-v3') {
        if(activeVoice||typeof request.id!=='string'||request.id.length>100||!Number.isInteger(request.ttlMs)||request.ttlMs<1||request.ttlMs>8000){reply(socket,{ok:false,error:'Invalid voice request'});continue;}
        activeVoice=true;const id=request.id,deadline=Date.now()+request.ttlMs;
        const permit={live:()=>connected&&Date.now()<deadline,started:()=>reply(socket,{event:'started',id})};
        voice.play(request.file,request.volume,permit).then(result=>{activeVoice=false;reply(socket,result);},error=>{activeVoice=false;reply(socket,{ok:false,error:error.message});});
      } else if (request.action === 'status') {
        let answered=false;const send=error=>{if(answered)return;answered=true;clearTimeout(probeTimer);reply(socket,{ok:true,version:SERVICE_VERSION,speechProtocol:3,beeperProtocol:3,pulseProtocol:1,mixerProtocol:1,diagnosticProtocol:2,overlaySaveSupported:true,audioOverlay:!!voice.audioOverlay,savedAudioRoute:diagnostics.saved||null,alsaProbeSupported:true,routeSinkId:voice.routeSinkId||SINK_ID,audioBackend:voice.fileFallback?'m4a-file-fallback':voice.audioBackend||'pcm-fifo',degraded:!!voice.fileFallback,beeperAvailable:!voice.fileFallback,fallbackReason:voice.fileFallbackReason||null,ready:!error&&!voice.lastError&&voice.ccAvailable&&(voice.audioBackend==='pulse'||voice.audioBackend==='alsa'||voice.audioBackend==='converter'||voice.audioBackend==='converter-stable'||require('./audio-profiles').isProfile(voice.audioBackend)||voice.mpAvailable),independentVolume:'not-confirmed',ccAvailable:!error&&voice.ccAvailable,mpAvailable:!error&&voice.mpAvailable,lastError:error||voice.lastError});};
        const probeTimer=setTimeout(()=>send('Audio status timeout'),2000);
        voice.init().then(async()=>{voice.ccAvailable=await voice.cc.isAvailable();voice.mpAvailable=await voice.mp.isAvailable();send(null);}).catch(e=>send(e.message));
      } else if (request.action === 'play' && ALLOWED[request.file]) {
        voice.play(request.file,100,{live:()=>connected}).then(function (result) { reply(socket, result); });
      } else if (request.action === 'play-volume' && ALLOWED[request.file]) {
        voice.play(request.file,request.volume===undefined?null:request.volume,{live:()=>connected}).then(function(result){reply(socket,result);},function(error){reply(socket,{ok:false,error:error.message});});
      } else {
        reply(socket, { ok: false, error: 'Unknown action or audio file' });
      }
    }
  });
});

try { fs.unlinkSync(SOCKET); } catch (e) {}
server.listen(SOCKET, function () {
  try { fs.chownSync(SOCKET, 0, 12202); } catch (e) { log('socket chown: ' + e.message); }
  try { fs.chmodSync(SOCKET, 0o660); } catch (e2) { log('socket chmod: ' + e2.message); }
  log('control socket ready: ' + SOCKET);
});

server.on('error', function (error) {
  log('SOCKET_ERROR: ' + error.stack);
  process.exit(1);
});

process.on('SIGTERM', function () {
  var reportStopped=diagnostics.reportShare.stop().catch(function(e){log('REPORT_NETWORK_CLEANUP: '+e.message);});
  diagnostics.cancelled=true;diagnostics.alsa.stop();
  Promise.all([reportStopped,beeper.close(),voice.musicDucker.close(),Promise.resolve(diagnostics.active).catch(()=>{})]).then(function () { server.close(function () { process.exit(0); }); });
});
process.on('uncaughtException', function (error) {
  log('UNCAUGHT: ' + error.stack);
});
