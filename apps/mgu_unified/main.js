'use strict';
// Native OAP entry. One Car, shared diagnostics and an explicit confirmed DTC-clear adapter.
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const Core = require('./core');
const Renderer = require('./renderer');
const ImageRegistry = require('./kit/record');
const Store = require('./kit/store');
const Dynamics = require('./dynamics');
const Telemetry = require('./telemetry');
const clock = require('./kit/clock');
const SignalPool = require('./signal-pool');
const ExtraTelemetry = require('./telemetry-extra');
const DiagnosticRead = require('./diagnostic-read');
const CheckControl = require('./check-control');
const ServiceRead = require('./service-read');
const EnergyRead = require('./energy-read');
const EnergyComfort = require('./energy-comfort');
const Energy = require('./energy');
const VitalsRead = require('./vitals-read');
const DoomSession = require('./doom-session');
const DiagnosticClear = require('./diagnostic-clear');
const CbsReset = require('./cbs-reset');
const ControllerRouter = require('./controller-router');
const ShellInput = require('./shell-input');
const EdriveWidget = require('./edrive-widget');
const Operations = require('./operations-log');
const AmbientSession = require('./ambient-session');
const LegacySource = require('./legacy-source');
const License = require('./license-core');
const EmbeddedHost=require('./embedded-host');
const WidgetMux=require('./widget-mux');
const TouchRouter=require('./touch-router');
const path = require('path');
mgu.run({ async start(ctx) {
    const feed = new Core.Feed();
    // kit strips signals from runtime app-spec; build generates this companion
    // from the same native/app.json that supplies installation-time permissions.
    const signalSpec=require('./signal-spec'),pool=SignalPool(ctx.signals,signalSpec),sourceContext=Object.assign({},ctx,{signals:pool});
    // Engine profile (diesel / petrol; upstream kit/engine.js, M Vitals 2.14.0 / Redline 1.9.0 / Dyno 1.3.0 /
    // Warm-Up 1.5.0): Vehicle2.statusVehiclePartType rides on the Car's own Vehicle2 watch, one subscription per
    // interface. The last valid type is kept in data/engine.json through kit/store (atomic; a corrupt file is moved
    // aside), so the first frames after a start already use it. An unknown or invalid type never clears it.
    const V2='de.bmw.infotainment.vehicle.Vehicle2',engineFile=path.join(ctx.dataDir,'engine.json');
    const engineRead=Store.read(engineFile,{log:ctx.log,fallback:null,valid:v=>!!v&&typeof v==='object'&&(v.type==='diesel'||v.type==='petrol')});
    let engineType=engineRead.value?engineRead.value.type:null,engineLogged=false;
    const onEngineType=v=>{
        const raw=v!==null&&typeof v==='object'?v.typeEngine:undefined,type=Telemetry.engineType(raw);
        // the raw value is logged once, and again with each type taken (once per car, as a rule)
        if(!engineLogged||type&&type!==engineType){engineLogged=true;ctx.log.info('engine type: '+JSON.stringify(raw)+' -> '+(type||'unknown'));}
        if(!type||type===engineType)return;
        engineType=type;
        if(!Store.save(engineFile,{type},{log:ctx.log}))ctx.log.warn('engine type '+type+' not saved; used for this start only');
        if(app)app.engineDetected(type);
    };
    // only with the field declared in this build: the pool refuses a watch with an undeclared field (speed too)
    const engineField=!!(signalSpec.signals[V2]&&signalSpec.signals[V2].statusVehiclePartType);
    const car = new Car(sourceContext, ['rpm', 'speed', 'temps', 'gear', 'accel', 'torque'], engineField?{extra:{[V2]:{statusVehiclePartType:onEngineType}}}:{});
    const extra=new ExtraTelemetry(sourceContext);
    const diagnostic=DiagnosticRead(Object.assign({},ctx,{Diag:require('./embedded-diag').Diag}));
    const checkControl=new CheckControl(sourceContext);
    const service=new ServiceRead(sourceContext);
    const comfort=new EnergyComfort(sourceContext);
    const energyRead=new EnergyRead(diagnostic.queue,{prefs:()=>app&&app.settings.modules.edrive,persist:value=>{if(!Store.save(path.join(ctx.dataDir,'battery-readings.json'),value,{log:ctx.log}))throw Error('Battery log not saved');}});
    const vitalsRead=new VitalsRead(diagnostic.queue,{persist:value=>{if(!Store.save(path.join(ctx.dataDir,'vitals-readings.json'),value,{log:ctx.log}))throw Error('Vitals log not saved');}});
    const energyFile=path.join(ctx.dataDir,'energy-history.json'),energySaved=Store.read(energyFile,{log:ctx.log,fallback:Energy.empty(),valid:Energy.valid});
    const prefFile = path.join(ctx.dataDir, 'module-settings.json');
    const modulePrefs = Store.load(prefFile, {log:ctx.log,fallback:{},valid:v=>v && typeof v==='object' && !Array.isArray(v)});
    // Deleted modules (hidden from the menus); data/settings of a hidden module are kept on disk.
    const hiddenFile = path.join(ctx.dataDir, 'hidden-modules.json');
    const hiddenRead = Store.read(hiddenFile, {log:ctx.log,fallback:[],valid:v=>Array.isArray(v)});
    const recordsFile = path.join(ctx.dataDir,'measurements.json');
    const recordRead = Store.read(recordsFile,{log:ctx.log,fallback:Dynamics.emptyHistory(),valid:Dynamics.validHistory});
    // G-Force all-time records (apps/gforce gforce_records.json): saved at most every 5 s and on exit.
    const gforceFile=path.join(ctx.dataDir,'gforce-records.json'),gforceRead=Store.read(gforceFile,{log:ctx.log,fallback:{},valid:Telemetry.validRecords});
    let gforcePending=null,gforceTimer=null;
    const flushGforce=()=>{if(gforceTimer){clock.clearTimeout(gforceTimer);gforceTimer=null;}if(gforcePending===null)return;const value=gforcePending;gforcePending=null;if(app)app.gforceSaveError=Store.save(gforceFile,value,{log:ctx.log})?'':'Рекорды не сохранены';};
    let app;
    // Settings of the separate apps: data/legacy-import.json, or the copy the PC installer built into
    // this package from the verified backup of this car (legacy_import_data.js, absent otherwise).
    const fs=require('fs');
    const legacySource=LegacySource(ctx.dataDir,{fs,Store,log:ctx.log,bundled:()=>{try{return require('./legacy_import_data');}catch(e){if(e&&e.code==='MODULE_NOT_FOUND')return null;throw e;}}});
    const legacyImport={
        read:()=>legacySource.read(),
        backup:()=>{const dir=path.join(ctx.dataDir,'backups','before-import-'+Date.now());[path.dirname(dir),dir].forEach(d=>{if(!fs.existsSync(d))fs.mkdirSync(d);});
            ['module-settings.json','gforce-records.json'].forEach(n=>{const src=path.join(ctx.dataDir,n);if(fs.existsSync(src)&&!Store.save(path.join(dir,n),JSON.parse(fs.readFileSync(src,'utf8')),{log:ctx.log}))throw Error('backup '+n);});
            if(!Store.save(path.join(dir,'settings-shell.json'),{units:ctx.settings.get('units'),overview:ctx.settings.get('overview'),language:ctx.settings.get('language'),engine:ctx.settings.get('engine')},{log:ctx.log}))throw Error('backup shell');return dir;},
        finish:kind=>legacySource.finish(kind)
    };
    // DTC clear = upstream Fault Scanner's (5 s double-press, functional clear, clearUnit, then a rescan): its
    // checks only, none of MGU Tools' own (no parked / scan-age / grant gate). report and rescan reach the shared
    // Diagnostics model; reading() is true while a scan runs (upstream's "busy" - a press then does nothing).
    const clearFaults=new DiagnosticClear(sourceContext,diagnostic,{
        mode:()=>feed.mode,report:()=>app&&app.diagnostics.report,
        reading:()=>!!(app&&app.diagnostics.phase==='reading'),
        rescan:()=>app?app.diagnostics.scan(feed):null
    });
    // Service reset: original resetOn/KOMBI permission/one-use grant, plus the unified parked check.
    const cbsReset=new CbsReset(sourceContext,diagnostic,{
        mode:()=>feed.mode,source:()=>feed.mode+':'+feed.revision,
        enabled:()=>!!(app&&app.settings.modules.service&&app.settings.modules.service.resetOn===true),
        names:()=>{const names={},s=service.snapshot();(s.list||[]).forEach(i=>{names[i.id]=i.name;});return names;},
        visible:()=>!!(app&&app.route.page==='module'&&app.route.id==='service'&&app.route.tab===0&&ctx.ui.isVisible&&ctx.ui.isVisible('MAIN')&&(!ctx.ui.hasFocus||ctx.ui.hasFocus('MAIN')))
    });
    // One owner of kit's controller slot: DOOM and the shell get separate ports; the grab follows
    // the visible, focused screen and is dropped on popup/hide/error (see controller-router.js).
    const router=new ControllerRouter(ctx);
    const shownWithFocus=name=>!!(ctx.ui.isVisible&&ctx.ui.isVisible(name)&&(!ctx.ui.hasFocus||ctx.ui.hasFocus(name)));
    let releaseGameKeys=()=>{};
    const gameContext=Object.assign({},sourceContext,{controller:router.port('doom',{eligible:()=>shownWithFocus('DOOM_GAME'),onRelease:()=>releaseGameKeys()})});
    const gameSession=new DoomSession(gameContext,{mode:()=>feed.mode,prefs:()=>app.game.prefs});
    // Lost grab (popup, hidden, error): release keys the game may still hold.
    releaseGameKeys=()=>{if(gameSession.ctl)gameSession.ctl.enable(false);};
    const gamePrefs=Store.load(path.join(ctx.dataDir,'game-settings.json'),{log:ctx.log,fallback:{},valid:v=>v&&typeof v==='object'&&!Array.isArray(v)});
    // Offline licence check — observe mode per licensing/LICENSING_CONTRACT.md: verify and surface the
    // status, never block. Publisher public keys are owner-provisioned in native/license-keys.json
    // (absent -> none configured). The licence file is data/license.mgulic, or a bundled license_data.
    const licenseStatus=(()=>{
        let keys={};try{keys=License.loadKeys(require('./license-keys.json'));}catch(e){keys={};}
        let text=null;try{text=fs.readFileSync(path.join(ctx.dataDir,'license.mgulic'),'utf8');}catch(e){}
        if(text===null)try{text=require('./license_data');}catch(e){if(!(e&&e.code==='MODULE_NOT_FOUND'))throw e;}
        if(text===null)return {state:'none',reason:'no-license',mode:'observe'};
        const clockFile=path.join(ctx.dataDir,'license-clock.json');
        const clock=Store.read(clockFile,{log:ctx.log,fallback:{seen:0},valid:v=>v&&typeof v==='object'&&typeof v.seen==='number'});
        const seen=clock.value&&clock.value.seen||0,now=Math.floor(Date.now()/1000);
        const r=License.verify(text,keys,now,null,seen);
        if(now>seen&&r.reason!=='clock-rollback')Store.save(clockFile,{seen:now},{log:ctx.log});
        return {state:r.valid?'ok':'problem',reason:r.reason,mode:'observe',
            licensee:r.claims&&r.claims.licensee||'',features:r.claims&&r.claims.features||[],expires:r.claims?r.claims.expires_at:null};
    })();
    const widgets=WidgetMux(ctx.widget,()=>ctx.settings.get('homeWidget')||'edrive',ctx.log);
    // Page touch (renderer 2.x where the kit runs the screen): one owner of the kit's slots for MAIN and the
    // embedded modules' screens; each event goes to the screen shown and in front (touch-router.js).
    const touch=new TouchRouter(ctx);
    const embedded=new EmbeddedHost(ctx,{router,touch,widgets,currentId:()=>app&&app.route.page==='module'?app.route.id:null});
    app = new Core.App({ feed, embedded, now:clock.now, license:licenseStatus, records:recordRead.value,gforceRecords:gforceRead.value,persistGforce:value=>{gforcePending=value;if(!gforceTimer)gforceTimer=clock.setTimeout(flushGforce,5000);},gameAdapter:gameSession,clearFaults,cbsReset,legacyImport,serviceHint:id=>service.hint(id),operations:()=>Operations(ctx.dataDir,40),
        energy:energySaved.value,persistEnergy:value=>{if(!Store.save(energyFile,value,{log:ctx.log}))throw Error('Energy history not saved');},
        scanFaults:(...args)=>clearFaults.state==='clearing'||cbsReset.state==='resetting'?Promise.reject(Error('Дождитесь завершения стирания')):diagnostic.scan(...args),
        persistScan:value=>{if(!Store.save(path.join(ctx.dataDir,'fault-scan.json'),value,{log:ctx.log}))throw new Error('Не удалось записать fault-scan.json');},
        persistRecords:value=>{if(!Store.save(recordsFile,value,{log:ctx.log}))throw new Error('Measurements not saved');},
        engineType,onEngine:limits=>{if(typeof car.setRedline==='function')car.setRedline(limits.redline.redline);},   // DEMO drive revs to the Tachometer redline
        settings: { units: ctx.settings.get('units'), overview: ctx.settings.get('overview'), language: ctx.settings.get('language'), engine: ctx.settings.get('engine'), modules:modulePrefs,game:gamePrefs,hidden:hiddenRead.value },
        persist: value => {
            ctx.settings.set('units',value.units);ctx.settings.set('overview',value.overview);ctx.settings.set('language',value.language==='en'?'en':'ru');
            ctx.settings.set('engine',Telemetry.ENGINE_SETTINGS.indexOf(value.engine)>=0?value.engine:'auto');
            if(!Store.save(prefFile,value.modules,{log:ctx.log}))throw new Error('Module settings not saved');
            if(!Store.save(path.join(ctx.dataDir,'game-settings.json'),value.game,{log:ctx.log}))throw new Error('Game settings not saved');
            if(!Store.save(hiddenFile,Array.isArray(value.hidden)?value.hidden:[],{log:ctx.log}))throw new Error('Hidden modules not saved');
        } });
    if(recordRead.state!=='ok'&&recordRead.state!=='missing')app.dynamics.saveError='Прежняя история не прочитана; подробности в журнале';
    if(gforceRead.state!=='ok'&&gforceRead.state!=='missing')app.gforceSaveError='Прежние рекорды не прочитаны; подробности в журнале';
    if(energySaved.state!=='ok'&&energySaved.state!=='missing')app.energy.error='Прежняя история eDrive не прочитана; подробности в журнале';
    // «Тип двигателя» is also in the kit settings list (app.json "settings"): a change there reaches the shell
    if(ctx.settings.onChange)ctx.settings.onChange(key=>{if(key==='engine'&&ctx.settings.get('engine')!==app.settings.engine)app.setting('engine',ctx.settings.get('engine'));});
    const originalMode = app.mode.bind(app);
    app.mode = mode => { ctx.settings.set('demo', mode === 'demo' ? 'on' : 'off'); originalMode(mode === 'demo' ? 'demo' : 'vehicle'); };
    feed.setMode(ctx.settings.get('demo') === 'on' ? 'demo' : 'vehicle');
    let lastCabinPixels = null;
    const sync = data => {
        feed.setMode(data.demo ? 'demo' : 'vehicle');
        ['rpm', 'speed', 'oil', 'coolant', 'gear', 'gLong', 'gLat', 'torque'].forEach(key => {
            const sample = car.sample(key), quality = data.quality[key] || 'unavailable';
            feed.put(key, data[key], quality, sample.received_at_monotonic || 0, sample.source || 'car');
        });
        extra.copyTo(feed);
        vitalsRead.copyTo(feed,clock.now());VitalsRead.demo(feed,clock.now());app.vitalsReadError=vitalsRead.error;
        app.vitalsMisfires={revision:feed.revision,data:vitalsRead.misfires.view(clock.now())};
        comfort.copyTo(feed,clock.now());energyRead.copyTo(feed,clock.now());
        app.energyCells={revision:feed.revision,mode:feed.mode,data:feed.mode==='vehicle'?energyRead.cells(clock.now()):null};
        app.energyComfort={revision:feed.revision,mode:feed.mode,data:feed.mode==='vehicle'?comfort.snapshot():null};
        Energy.Energy.demo(feed,clock.now());app.energyReadError=energyRead.error;
        app.diagnostics.checkControl(feed,checkControl.snapshot());
        app.serviceSnapshot={revision:feed.revision,mode:feed.mode,data:service.snapshot()};
        ambient.copyTo(feed,clock.now());app.ambientSnapshot={revision:feed.revision,mode:feed.mode,data:ambient.snapshot()};
    };
    car.onSample((data,t) => {sync(data);app.sample(t);}, () => {sync(car.data());app.telemetry.source(feed);});
    car.onUpdate(data => {sync(data);app.tick(clock.now());});
    // Source freshness and standstill arming must also advance with the screen hidden.
    // Ambient 0.2.2: the original PC-confirmed mailbox is the only lighting write path (no HU apply button).
    const ambient=new AmbientSession(ctx);
    // Home-screen widget (apps/edrive startWidget). While it is shown the battery is read as for the page.
    const widget=new EdriveWidget(Object.assign({},ctx,{widget:widgets.port('edrive')}),{fps:()=>app.settings.modules.edrive.widgetFps,view:()=>{
        sync(car.data());const p=app.settings.modules.edrive,f=p.tempUnit==='f',e=app.energy.view(feed),t=feed.read('batteryTemp').value;
        return {demo:feed.mode==='demo',kw:feed.read('hvPower').value,soc:feed.read('soc').value,v:feed.read('hvVoltage').value,a:feed.read('hvCurrent').value,
            temp:t===null?null:f?t*9/5+32:t,tempUnit:f?'°F':'°C',net:e.trip.seconds?e.trip.used-e.trip.received:null,received:e.trip.seconds?e.trip.received:null,gaugeKw:p.gaugeKw};
    }});
    const measureTimer=clock.setInterval(()=>{
        sync(car.data());app.tick(clock.now());
        gameSession.sync();
        clearFaults.sync();
        cbsReset.sync();
        router.sync();
        const visible=ctx.ui.isVisible&&ctx.ui.isVisible('MAIN'),shown=app.route.page==='module'&&app.route.id==='edrive'||app.route.page==='overview'&&app.settings.overview==='edrive';
        energyRead.poll(feed,!!visible&&shown||widget.active(),clock.now());
        vitalsRead.poll(feed,visible&&app.route.page==='module'&&app.route.id==='car_vitals'?app.route.tab:null,clock.now());
    },50);
    // RHMI button labels follow the shell language (kit ui.text), set once per change.
    const I18n=require('./i18n');let labelled=null;
    const labels=()=>{if(labelled===app.settings.language||!ctx.ui.text)return;labelled=app.settings.language;I18n.setLanguage(labelled);
        [['BTN_PREV','Назад по меню'],['BTN_NEXT','Далее'],['BTN_SELECT','Выбрать'],['BTN_BACK','Назад']].forEach(b=>Promise.resolve(ctx.ui.text(b[0],I18n.tr(b[1]))).catch(()=>{}));};
    const render = async () => {
        sync(car.data());labels();
        const cv = ctx.canvas(1600, 520);
        if (cv.recording) cv.drawImage = (pixels, sw, sh, x, y, w, h) => {
            if (lastCabinPixels !== pixels) {
                ImageRegistry.setImage(70001, sw, sh, pixels); lastCabinPixels = pixels;
            }
            cv.image(70001, x, y, w, h);
        };
        Renderer.render(cv, app); await ctx.ui.image('MAIN_GFX', cv);
    };
    ctx.ui.onClick('BTN_PREV', () => { app.rotate(-1); return render(); });
    ctx.ui.onClick('BTN_NEXT', () => { app.rotate(1); return render(); });
    ctx.ui.onClick('BTN_SELECT', () => { app.activate(); return render(); });
    ctx.ui.onClick('BTN_BACK', () => { app.back(); return render(); });
    // Touch where the kit runs MAIN (renderer 2.x, full-screen layout; never in software, the standard layout
    // or on an older renderer): a tap does what the controller does on the control under the finger (App.tap:
    // its focus, then one press; two-press confirmations stay two taps), a drag turns a paged list as its page
    // button does (App.scroll). The page's own buttons (in-page back arrow, tabs, bottom navigation) take the
    // place of the bar's controller stand-ins there, so the kit's bar goes and the whole page shows; BTN_PREV is
    // the kit's pager and leaves it by itself. The RHMI buttons stay for every other path.
    touch.screen('MAIN',{
        tap:(x,y)=>{const hit=app.hit(x,y);if(!app.tap(x,y))return;if(ctx.log.debug)ctx.log.debug('MAIN tap: '+(hit?hit.id:'-'));return render();},
        scroll:dy=>{const moved=app.scroll(dy);if(moved)render().catch(e=>ctx.log.warn('render: '+e.message));return moved;}
    });
    if(typeof ctx.hideButton==='function')['BTN_NEXT','BTN_SELECT','BTN_BACK'].forEach(b=>ctx.hideButton(b));
    // Direct controller on the shell (GPU renderer + mgu-inputgate only); RHMI buttons stay the fallback.
    const shellInput=new ShellInput();
    const shellPort=router.port('shell',{eligible:()=>shownWithFocus('MAIN'),onRelease:()=>shellInput.reset()});
    shellPort.onInput(v=>{if(ShellInput.apply(app,shellInput.feed(v)))render().catch(e=>ctx.log.warn('render: '+e.message));});
    shellPort.grab(true);
    ctx.loop('MAIN', 4, render);
    process.once('exit', () => {clock.clearInterval(measureTimer);flushGforce();touch.close();embedded.close();clearFaults.close();cbsReset.close();gameSession.close();router.close();ambient.close();vitalsRead.close();energyRead.close();comfort.close();car.close();extra.close();checkControl.close();service.close();pool.close();diagnostic.close();});
    if(ctx.settings.get('homeWidget')==='live_data')embedded.start('live_data').catch(e=>ctx.log.error(e));
    await render();
} });
