(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./color'), require('./telemetry'), require('./dynamics'), require('./diagnostics'), require('./energy'), require('./game'), require('./vitals'), require('./legacy-import'));
    else root.MguCore = factory(root.MguColor, root.MguTelemetry, root.MguDynamics, root.MguDiagnostics, root.MguEnergy, root.MguGame, root.MguVitals, root.MguLegacyImport);
}(this, function (Color, Telemetry, Dynamics, Diagnostics, Energy, Game, Vitals, Legacy) {
    'use strict';
    // Shared, Node 8 compatible state. No SDK, network, commands or vehicle writes.
    var groups = ['Двигатель', 'Динамика', 'Автомобиль', 'Сервис', 'Досуг'];
    var modules = [
        ['redline', 'Тахометр', 0, ['Обороты', 'Переключения']],
        ['car_vitals', 'Показатели', 0, ['Двигатель', 'Температуры', 'Шины', 'Топливо', 'Шасси']],
        ['warmup', 'Прогрев', 0, ['Готовность', 'Охлаждение']],
        ['draggy', 'Разгон', 1, ['0–100', '100–200', '¼ мили', 'История']],
        ['brake_test', 'Торможение', 1, ['100–0', '200–0', 'История']],
        ['gforce', 'G-Force', 1, ['Текущие', 'Максимумы', 'Рекорды']],
        ['dyno', 'Мощность', 1, ['График', 'Сравнение']],
        ['edrive', 'eDrive', 2, ['Энергия', 'Батарея', 'Зарядки', '12 V', 'Ячейки', 'Климат']],
        ['ambient_light', 'Подсветка', 2, ['Цвет', 'Состояние']],
        ['dtc_scanner', 'Диагностика', 3, ['Ошибки', 'Check Control', 'Параметры']],
        ['service', 'Интервалы', 3, ['Обслуживание', 'Сведения']],
        ['live_data', 'Live Data', 3, ['Приборы и поездки']],
        ['live_adjustments', 'Engine Config', 0, ['Управление']],
        ['zf8hp', 'Трансмиссия ZF', 2, ['Данные и адаптации']],
        ['doom', 'DOOM', 4, ['Игра', 'Управление', 'Параметры']]
    ].map(function (m) { return { id: m[0], title: m[1], group: m[2], tabs: m[3] }; });
    var validQuality = ['live', 'demo', 'stale', 'unavailable', 'invalid'];
    var defaults = { units: 'kmh', overview: 'redline', language: 'ru', engine: 'auto' };
    var moduleIdList = modules.map(function (m) { return m.id; });
    function finite(v) { return typeof v === 'number' && isFinite(v); }
    function moduleById(id) { return modules.filter(function (m) { return m.id === id; })[0]; }
    // Hidden ("deleted") modules: a saved list of module ids removed from the menus. Only known ids,
    // no duplicates; an unknown id in the saved file is ignored rather than trusted.
    function validHidden(list) {
        if (!Array.isArray(list)) return [];
        var out = [];
        list.forEach(function (id) { if (moduleIdList.indexOf(id) >= 0 && out.indexOf(id) < 0) out.push(id); });
        return out;
    }
    function Feed() { this.mode = 'offline'; this.values = {}; this.revision = 0; }
    Feed.prototype.setMode = function (mode) {
        if (['offline', 'demo', 'vehicle'].indexOf(mode) < 0) throw new Error('Unknown data mode');
        if (this.mode !== mode) { this.mode = mode; this.values = {}; this.revision++; }
    };
    Feed.prototype.put = function (key, value, quality, at, source) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) throw new Error('Invalid metric key');
        if (validQuality.indexOf(quality) < 0) quality = 'invalid';
        if ((quality === 'demo' && this.mode !== 'demo') || (quality === 'live' && this.mode !== 'vehicle')) return false;
        if (!finite(value)) { value = null; quality = quality === 'unavailable' || quality === 'stale' ? quality : 'invalid'; }
        if (!finite(at)) { value = null; quality = 'invalid'; at = 0; }
        this.values[key] = Object.freeze({ value: value, quality: quality, at: at, source: source || '' });
        return true;
    };
    Feed.prototype.read = function (key) {
        var v = this.values[key];
        if (!v) return { value: null, quality: 'unavailable', at: 0, source: '' };
        return { value: v.quality === 'live' || v.quality === 'demo' ? v.value : null,
            quality: v.quality, at: v.at, source: v.source };
    };
    Feed.prototype.demo = function (ms) {
        if (this.mode !== 'demo') return;
        var phase = ms / 3000;
        var cycle = ms % 30000, v = cycle < 1500 ? 0 : cycle < 23500 ? (cycle - 1500) / 100 : Math.max(0,220-(cycle-23500)*.044);
        var stage = v / 50, g = cycle < 1500 || cycle >= 28500 ? 0 : cycle < 23500 ? .283 : -1.246;
        // the pulls rev towards the Tachometer redline of the engine profile (App.engineUpdated; 7000 = petrol)
        var top = finite(this.demoRedline) && this.demoRedline > 2500 ? this.demoRedline : 7000;
        var data = { rpm: v < .5 ? 850 : 1800 + Math.round((stage - Math.floor(stage)) * (top - 2000)), gear: v < .5 ? 0 : 1 + Math.floor(stage), speed: v,
            oil: 65 + Math.min(ms / 120000, 1) * 30, coolant: 92, torque: 190, boost: 0.8, voltage: 14.2, intake: 29, transmission: 78,ambient:18,powerPct:45,torquePct:55,
            gLong: g, gLat: 0.08 * Math.cos(phase),
            hpfp:185,lpfp:5.2,timing:14,frontTorque:160,boostAbs:180,baro:100,
            soc: 67, hvVoltage:350, hvCurrent:-34.28, soh:95, climate:0, comfortKw:0, hvPower: 12, batteryTemp: 27, cellMin: 3.82, cellMax: 3.83,
            profile: 3, brightness: 0, lightEnabled: 1, tireFL: 2.4, tireFR: 2.4, tireRL: 2.5, tireRR: 2.5,
            tireTempFL:28,tireTempFR:29,tireTempRL:30,tireTempRR:30,tireTargetFL:2.4,tireTargetFR:2.4,tireTargetRL:2.5,tireTargetRR:2.5 };
        var self = this;
        Object.keys(data).forEach(function (key) { self.put(key, data[key], 'demo', ms, 'demo'); });
    };
    function App(options) {
        options = options || {};
        // Monotonic milliseconds for the shell's windows (two-press confirmations, digit holds, finger drags:
        // RT-12). The HU host passes kit/clock.now - its wall clock is set after start-up and can jump; the
        // browser preview has only Date.now. History entries keep wall time (they show dates).
        this.now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
        this.drag = null;
        this.embedded=options.embedded||null;this.embeddedBusy=false;
        this.feed = options.feed || new Feed(); this.persist = options.persist || function () {};
        this.settings = Object.assign({}, defaults);
        var saved = options.settings || {};
        if (saved.units === 'mph') this.settings.units = saved.units;
        if (saved.overview === 'edrive') this.settings.overview = saved.overview;
        if (saved.language === 'en') this.settings.language = 'en';
        // «Тип двигателя», one for the car: Авто = the type the car reports (engineType, kept by the host)
        if (Telemetry.ENGINE_SETTINGS.indexOf(saved.engine) >= 0) this.settings.engine = saved.engine;
        this.engineType = options.engineType === 'diesel' || options.engineType === 'petrol' ? options.engineType : null;
        this.onEngine = typeof options.onEngine === 'function' ? options.onEngine : function () {};
        this.settings.modules = Telemetry.settings(saved.modules);
        this.settings.hidden = validHidden(saved.hidden);
        this.removeArm = null;
        this.route = { page: 'overview', focus: 'nav-overview', tab: 0 };
        this.stack = []; this.history = []; this.message = ''; this.actions = [];
        this.lighting = { hue: 280, saturation: 0.75, brightness: 75, edit: null, confirmedColor: null };
        this.dynoSelection = 0;
        this.operationsAdapter=options.operations||null;this.showOperations=false;this.operationsPage=0;this.operationsList=null;
        this.ambientSnapshot=null;
        this.servicePage=0;this.serviceSnapshot=null;this.serviceDetail=null;this.serviceHintText=null;this.serviceHintAdapter=options.serviceHint||null;
        this.showMisfires=false;this.vitalsMisfires=null;
        // Licence status is evaluated by the host (native license-core, observe mode) and passed in; the
        // shell only displays it and never blocks on it. null = no licence check in this host (e.g. browser).
        this.license=options.license||null;
        var self = this;
        var onEvent = function (event) {
            event.at = Date.now(); self.history.unshift(event); self.history = self.history.slice(0, 100);
        };
        this.telemetry = new Telemetry.Telemetry(this.settings.modules, onEvent, {records:options.gforceRecords,persistRecords:options.persistGforce,profile:function(){return self.engineProfile();}});
        this.dynamics = new Dynamics.Dynamics({prefs:this.settings.modules,saved:options.records,persist:options.persistRecords,event:onEvent,units:function(){return self.settings.units;}});
        this.holds = {}; this.settingsPage = 0; this.recordsClear = null; this.blink = false; this.vitals = new Vitals.Tracker();
        this.diagnostics = new Diagnostics.Model({adapter:options.scanFaults,persist:options.persistScan,event:onEvent});
        this.energy=new Energy.Energy({saved:options.energy,persist:options.persistEnergy,prefs:function(){return self.settings.modules.edrive;}});
        this.energyCells=null;this.energyComfort=null;
        this.game=new Game.Model({adapter:options.gameAdapter,saved:saved.game,now:this.now,persist:function(value){self.settings.game=value;self.persist(JSON.parse(JSON.stringify(self.settings)));}});
        this.settings.game=this.game.prefs;
        this.clearFaults=options.clearFaults||{view:function(){return {available:false,state:'idle',armed:false,busy:false,message:'',results:[],operation:null};},press:function(){return false;},cancel:function(){}};
        this.cbsReset=options.cbsReset||{view:function(){return {available:false,state:'idle',allowed:false,reason:'Сброс CBS доступен только в приложении на HU',kombi:[],choices:[],result:null};},cancel:function(){}};
        this.legacyAdapter=options.legacyImport||null;this.legacy=null;
        if(this.legacyAdapter){try{var legacy=this.legacyAdapter.read();if(legacy){var lp=Legacy.plan(legacy,this.settings.modules,Telemetry.schema,Telemetry.validRecords,this.telemetry.records.vehicle,
            {shell:{engine:this.settings.engine},engineSettings:Telemetry.ENGINE_SETTINGS,fromOldDefault:Telemetry.fromOldDefault});this.legacy={state:lp.error?'error':lp.changes.length||lp.records?'offered':'empty',plan:lp,message:lp.error};}}catch(e){this.legacy={state:'error',plan:null,message:'Файл импорта не прочитан'};}}
        this.engineUpdated();
    }
    // Engine profile: 'diesel' / 'petrol' from the setting, else the type the car reported, else petrol.
    App.prototype.engineProfile = function () { return Telemetry.engineProfile(this.settings.engine, this.engineType); };
    App.prototype.limits = function () { return Telemetry.limits(this.settings.modules, this.engineProfile()); };
    /** A valid type from Vehicle2.statusVehiclePartType (the host keeps it across starts). true when it changed. */
    App.prototype.engineDetected = function (type) {
        if (type !== 'diesel' && type !== 'petrol' || type === this.engineType) return false;
        this.engineType = type; this.engineUpdated(); return true;
    };
    // The rpm values may have changed (profile, «Тип двигателя», an rpm setting): the DEMO drive follows them.
    App.prototype.engineUpdated = function () {
        var limits = this.limits(); this.feed.demoRedline = limits.redline.redline;
        try { this.onEngine(limits); } catch (e) { /* the host logs its own errors; the shell keeps running */ }
    };
    App.prototype.go = function (page, id) {
        if (['overview', 'modules', 'group', 'module', 'history', 'settings', 'apps'].indexOf(page) < 0) throw new Error('Invalid route');
        if (page === 'module' && !moduleById(id)) throw new Error('Unknown module');
        if (page === 'group' && (typeof id !== 'number' || !groups[id])) throw new Error('Unknown group');
        this.lighting.edit = null;
        this.removeArm = null;
        this.game.cancel();
        this.clearFaults.cancel();
        this.cbsReset.cancel();
        this.stack.push(Object.assign({}, this.route)); if (this.stack.length > 40) this.stack.shift();
        this.serviceDetail = null; this.serviceHintText = null;
        this.route = { page: page, id: id, tab: page === 'module' && id === 'car_vitals' ? Vitals.PAGES[this.settings.modules.car_vitals.page] || 0 : 0, focus: null }; this.message = ''; this.settingsPage = 0; this.recordsClear = null;
    };
    App.prototype.back = function () {
        this.game.cancel();
        if(this.clearFaults.view().state==='armed'){this.clearFaults.cancel();return;}
        if(this.cbsReset.view().state!=='idle'){this.cbsReset.cancel();return;}
        if(this.route.page==='module'&&this.route.id==='dtc_scanner'&&this.diagnostics.detail){this.diagnostics.detail=null;return;}
        if(this.route.page==='module'&&this.route.id==='service'&&this.serviceDetail){this.serviceDetail=null;this.serviceHintText=null;return;}
        if (this.lighting.edit) { this.lighting.edit = null; return; }
        this.route = this.stack.pop() || { page: 'overview', tab: 0, focus: 'nav-overview' }; this.message = '';
    };
    App.prototype.setActions = function (actions) {
        this.actions = actions;
        if (!actions.some(function (a) { return a.id === this.route.focus && !a.disabled; }, this)) {
            var first = actions.filter(function (a) { return !a.disabled; })[0]; this.route.focus = first ? first.id : null;
        }
    };
    App.prototype.rotate = function (delta) {
        if (this.lighting.edit && this.route.page === 'module' && this.route.id === 'ambient_light') {
            var sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
            if (this.lighting.edit === 'hue') this.selectColor(this.lighting.hue + sign * 3, this.lighting.saturation);
            else if (this.lighting.edit === 'saturation') this.selectColor(this.lighting.hue, this.lighting.saturation + sign * 0.025);
            else this.lighting.brightness = Color.clamp(this.lighting.brightness + sign * 2, 0, 100);
            return;
        }
        var list = this.actions.filter(function (a) { return !a.disabled; });
        if (!list.length || !delta) return;
        var i = list.map(function (a) { return a.id; }).indexOf(this.route.focus);
        this.route.focus = list[(Math.max(i, 0) + (delta > 0 ? 1 : -1) + list.length) % list.length].id;
    };
    App.prototype.activate = function (id) {
        var action = this.actions.filter(function (a) { return a.id === (id || this.route.focus); }, this)[0];
        if (!action || action.disabled) return false;
        this.route.focus = action.id; action.run(); return true;
    };
    /** The control drawn at x, y of the 1600 x 520 page in the last frame (the one drawn last wins), or null. */
    App.prototype.hit = function (x, y) {
        if (!finite(x) || !finite(y)) return null;
        for (var i = this.actions.length - 1; i >= 0; i--) {
            var a = this.actions[i];
            if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a;
        }
        return null;
    };
    /**
     * Touch on the page (renderer 2.x where the kit runs the screen; never called in software, the standard
     * layout or on an older renderer): a tap at x, y does what the controller does on the control drawn there -
     * it takes the focus and is pressed once (activate), so a two-press confirmation still needs two taps and a
     * disabled control does nothing. The colour wheel and the brightness slider take the point touched, as
     * the browser preview's pointer does (the controller turns them instead). true when something happened.
     */
    App.prototype.tap = function (x, y) {
        var a = this.hit(x, y);
        if (!a || a.disabled) return false;
        if (typeof a.point === 'function') { this.route.focus = a.id; a.point(x, y); return true; }
        return this.activate(a.id);
    };
    /**
     * A finger dragged on a page with a paged list (onScroll: dy canvas px, + = further down, the content
     * moving up) turns that list's page as its own page button ("1 / 3 · Далее") does with the controller:
     * one page per PAGE_DRAG px dragged one way within one movement, no further than the first or the last
     * page (the button wraps round, a list does not). true when a page turned.
     */
    var PAGE_DRAG = 100, DRAG_GAP_MS = 400;
    App.prototype.pager = function () {
        return this.actions.filter(function (a) { return a.pager && a.pager.pages > 1 && !a.disabled; })[0] || null;
    };
    App.prototype.scroll = function (dy, now) {
        if (!finite(dy) || !dy) return false;
        now = finite(now) ? now : this.now();
        var list = this.pager(), d = this.drag;
        // a new movement: another list, a pause, the other way, or the clock behind the last one
        if (!d || !list || d.key !== list.id || now < d.at || now - d.at > DRAG_GAP_MS || d.sum && (d.sum > 0) !== (dy > 0)) d = this.drag = { key: list ? list.id : null, sum: 0, at: now };
        d.at = now;
        if (!list) return false;
        d.sum += dy;
        if (Math.abs(d.sum) < PAGE_DRAG) return false;
        var to = list.pager.page + (d.sum > 0 ? 1 : -1);
        d.sum = 0;
        if (to < 0 || to >= list.pager.pages) return false;
        list.pager.set(to);
        return true;
    };
    App.prototype.setting = function (key, value) {
        if (key === 'units' && ['kmh', 'mph'].indexOf(value) >= 0 || key === 'overview' && ['redline', 'edrive'].indexOf(value) >= 0 || key === 'language' && ['ru', 'en'].indexOf(value) >= 0
            || key === 'engine' && Telemetry.ENGINE_SETTINGS.indexOf(value) >= 0) {
            this.settings[key] = value;
            if (key === 'units') this.dynamics.reset('draggy');
            if (key === 'engine') this.engineUpdated();
            try { this.persist(Object.assign({}, this.settings)); this.message = ''; }
            catch (e) { this.message = 'Настройки не сохранены'; }
        }
    };
    App.prototype.mode = function (mode) {
        this.feed.setMode(mode);
        this.telemetry.source(this.feed);
        this.dynamics.source(this.feed);
        this.diagnostics.source(this.feed);
        this.energy.source(this.feed);
        this.game.source(this.feed);
        this.clearFaults.cancel();
        this.cbsReset.cancel();
        this.serviceDetail = null; this.serviceHintText = null;
        this.lighting.confirmedColor = null;
        this.history.unshift({ at: Date.now(), title: mode === 'demo' ? 'Включены демонстрационные данные' : 'Источник данных изменён',
            source: mode, kind: 'source' });
        this.history = this.history.slice(0, 100);
    };
    App.prototype.openEmbedded = function(id) {
        if(!this.embedded||this.embeddedBusy)return Promise.resolve(false);
        var self=this;this.embeddedBusy=true;this.message='Запуск модуля…';
        return Promise.resolve().then(function(){return self.embedded.open(id);}).then(function(){self.message='';return true;},function(e){self.message='Модуль не открыт: '+e.message;return false;}).then(function(v){self.embeddedBusy=false;return v;});
    };
    App.prototype.requestVehicleAction = function () {
        // This shell has no write adapter. Enabling DEMO or navigating never grants permission.
        this.message = 'Управление ещё не подключено'; return { accepted: false, reason: 'adapter-unavailable' };
    };
    // Display throttle of the original speedRate/gRate settings: a digit changes at most `rate` times a second.
    App.prototype.hold = function (key, value, rate, now) {
        var h = this.holds[key]; now = finite(now) ? now : this.now();
        if (value === null || value === undefined || !finite(value)) { delete this.holds[key]; return null; }
        if (!h || now < h.at || now - h.at >= 1000 / (rate || 10)) { this.holds[key] = { v: value, at: now }; return value; }
        return h.v;
    };
    // "Delete all" records: the first press arms for 5 s, a second press clears (apps/gforce).
    App.prototype.clearGforceRecords = function (now) {
        now = finite(now) ? now : this.now();
        if (this.recordsClear === null || now - this.recordsClear > 5000 || now < this.recordsClear) { this.recordsClear = now; return false; }
        this.recordsClear = null;
        try { this.telemetry.clearRecords(this.feed.mode); this.message = ''; } catch (e) { this.message = 'Рекорды не удалены'; }
        return true;
    };
    // Draggy tab labels follow the speed unit and the distance setting (apps/draggy SPLITS/DIST).
    App.prototype.tabs = function (mod) {
        if (mod.id !== 'draggy') return mod.tabs;
        var mph = this.settings.units === 'mph', dist = { qm: '¼ мили', em: '⅛ мили', m1000: '1000 м' }[this.settings.modules.draggy.distance] || '¼ мили';
        return [mph ? '0–60' : '0–100', mph ? '60–130' : '100–200', dist, 'История'];
    };
    App.prototype.sample = function (monotonicMs) { this.telemetry.sample(this.feed, monotonicMs); this.tick(monotonicMs); };
    App.prototype.tick = function (monotonicMs) { this.dynamics.update(this.feed, monotonicMs); this.diagnostics.source(this.feed); this.energy.update(this.feed,monotonicMs); this.game.source(this.feed); if (finite(monotonicMs)) this.vitals.update(this.feed, this.settings.modules.car_vitals, monotonicMs); };
    App.prototype.serviceView=function(){
        if(this.feed.mode==='demo')return {quality:'demo',list:[{id:1,name:'Моторное масло',way:'12 300 км',date:'09/2027',colour:3},{id:3,name:'Тормозная жидкость',way:'',date:'11/2026',colour:2}],summary:{text:'Моторное масло',way:'12 300 км',date:'09/2027',colour:3},summaryQuality:'demo'};
        var s=this.serviceSnapshot;return this.feed.mode==='vehicle'&&s&&s.revision===this.feed.revision&&s.mode==='vehicle'?s.data:{quality:'unavailable',list:null,summary:null,summaryQuality:'unavailable'};
    };
    // Service item details (original BTN_DETAILS / requestCBSServiceHint). A late answer for another
    // item or source is dropped; DEMO text is labelled as such.
    App.prototype.serviceOpen=function(item){this.serviceDetail=JSON.parse(JSON.stringify(item));this.serviceHintText=null;};
    App.prototype.serviceHint=function(){
        var item=this.serviceDetail,self=this,key=this.feed.mode+':'+this.feed.revision;
        if(!item||this.serviceHintText&&this.serviceHintText.state==='loading')return false;
        if(this.feed.mode==='demo'){this.serviceHintText={id:item.id,state:'ok',text:(item.way?'Обслуживание через '+item.way+(item.date?' или до '+item.date:''):'Обслуживание до '+(item.date||'—'))+' · DEMO'};return true;}
        if(this.feed.mode!=='vehicle'||!this.serviceHintAdapter){this.serviceHintText={id:item.id,state:'error',text:'Подробности доступны только в приложении на HU'};return false;}
        this.serviceHintText={id:item.id,state:'loading',text:'Запрос к комбинации приборов…'};
        Promise.resolve().then(function(){return self.serviceHintAdapter(item.id);}).then(function(text){
            if(self.serviceDetail===item&&self.feed.mode+':'+self.feed.revision===key)self.serviceHintText={id:item.id,state:'ok',text:String(text)};
        },function(e){
            if(self.serviceDetail===item&&self.feed.mode+':'+self.feed.revision===key)self.serviceHintText={id:item.id,state:'error',text:'Подробности недоступны: '+(e&&e.message||e)};
        });
        return true;
    };
    /** Confirmed-operation journals (read-only); refreshed when the list is opened. */
    App.prototype.toggleOperations=function(){
        this.showOperations=!this.showOperations;this.operationsPage=0;
        if(this.showOperations){try{this.operationsList=this.operationsAdapter?this.operationsAdapter():{items:[],error:'Журнал операций доступен в приложении на HU'};}catch(e){this.operationsList={items:[],error:'Журнал операций не прочитан'};}}
    };
    // Explicit choice only: back up current files, then apply the offered plan; or decline it.
    App.prototype.legacyApply=function(){
        var l=this.legacy;if(!l||l.state!=='offered'||!this.legacyAdapter)return false;
        try{this.legacyAdapter.backup();}catch(e){l.message='Резервная копия не создана — импорт не выполнен';return false;}
        var self=this;l.plan.changes.forEach(function(c){if(c.shell)self.settings[c.key]=c.to;else self.settings.modules[c.module][c.key]=c.to;});
        this.engineUpdated();
        try{this.persist(JSON.parse(JSON.stringify(this.settings)));}catch(e){l.state='error';l.message='Импорт применён в памяти, но не сохранён';return false;}
        if(l.plan.records){this.telemetry.records.vehicle=JSON.parse(JSON.stringify(l.plan.records));if(this.telemetry.persistRecords)try{this.telemetry.persistRecords(JSON.parse(JSON.stringify(l.plan.records)));}catch(e){l.message='Рекорды не сохранены';}}
        try{this.legacyAdapter.finish('applied');}catch(e){}
        l.state='applied';l.message=l.message||'Импортировано: '+l.plan.changes.length+(l.plan.records?' · рекорды G-Force':'');
        this.history.unshift({at:Date.now(),title:'Импортированы настройки прежних приложений',source:this.feed.mode,kind:'import'});return true;
    };
    App.prototype.legacyDecline=function(){var l=this.legacy;if(!l||l.state!=='offered')return false;try{if(this.legacyAdapter)this.legacyAdapter.finish('declined');}catch(e){}l.state='declined';l.message='Импорт отклонён · файл сохранён как declined';return true;};
    App.prototype.ambientView=function(){
        if(this.feed.mode==='demo')return {available:true,ready:true,demo:true,state:{profile:3,enabled:true,brightnessOffset:0},raw:null,writeBlocked:false,last:null,problem:''};
        var s=this.ambientSnapshot;return this.feed.mode==='vehicle'&&s&&s.revision===this.feed.revision&&s.mode==='vehicle'?s.data:{available:false,ready:false,state:null,raw:null,writeBlocked:false,last:null,problem:this.feed.mode==='vehicle'?'Состояние подсветки ещё не прочитано':'Нет подключения к автомобилю'};
    };
    App.prototype.misfireView=function(){
        if(this.feed.mode==='demo')return {reason:'',ids:[1,2,3,4,5,6],counts:[0,0,2,0,0,0].map(function(v,i){return {cylinder:i+1,value:v};})};
        return this.feed.mode==='vehicle'&&this.vitalsMisfires&&this.vitalsMisfires.revision===this.feed.revision?this.vitalsMisfires.data:{reason:'Список цилиндров не прочитан',ids:null,counts:[]};
    };
    App.prototype.moduleSetting = function (id, key) {
        var fields = Telemetry.schema[id] || [], field = fields.filter(function (f) { return f[0] === key; })[0];
        if (!field) return false;
        var old = this.settings.modules[id][key], index = field[3].indexOf(old);
        this.settings.modules[id][key] = field[3][(index + 1) % field[3].length];
        // «Торможение сверху» only changes the drawing (apps/gforce 1.5.0): the G-Force session is kept
        if (id === 'service') this.cbsReset.cancel(); else if (!(id === 'gforce' && key === 'flipLong')) this.telemetry.reset(id);
        if(id==='draggy'||id==='brake_test'||id==='dyno')this.dynamics.reset(id);
        this.engineUpdated();
        try { this.persist(JSON.parse(JSON.stringify(this.settings))); this.message = ''; }
        catch (e) { this.message = 'Настройки не сохранены'; }
        return true;
    };
    App.prototype.resetSession = function (id) {
        if (!Telemetry.schema[id] || id === 'service' || id === 'edrive') return false;
        this.telemetry.reset(id);
        if(id==='draggy'||id==='brake_test'||id==='dyno')this.dynamics.reset(id);
        if(id==='car_vitals')this.vitals.reset();
        this.history.unshift({at:Date.now(),title:'Сброшена сессия: '+moduleById(id).title,source:this.feed.mode,kind:'reset'});
        this.history=this.history.slice(0,100); return true;
    };
    // Modules the user has NOT deleted, in catalogue order. Deletion only hides a module from the
    // menus; its stored settings and data are untouched, and it can be restored.
    App.prototype.visibleModules = function () {
        var hidden = this.settings.hidden;
        return modules.filter(function (m) { return hidden.indexOf(m.id) < 0; });
    };
    App.prototype.isHidden = function (id) { return this.settings.hidden.indexOf(id) >= 0; };
    // "Delete" arms on the first press and only removes on a second press within 5 s (apps/gforce pattern),
    // so a module is never hidden by a single accidental tap.
    App.prototype.removeArmed = function (id, now) {
        now = finite(now) ? now : this.now();
        return !!(this.removeArm && this.removeArm.id === id && now - this.removeArm.at <= 5000 && now >= this.removeArm.at);
    };
    App.prototype.removeModule = function (id, now) {
        if (!moduleById(id) || this.isHidden(id)) return false;
        now = finite(now) ? now : this.now();
        if (!this.removeArmed(id, now)) { this.removeArm = { id: id, at: now }; return false; }
        this.removeArm = null;
        this.settings.hidden = this.settings.hidden.concat([id]);
        try { this.persist(JSON.parse(JSON.stringify(this.settings))); this.message = ''; }
        catch (e) { this.settings.hidden = this.settings.hidden.filter(function (x) { return x !== id; }); this.message = 'Удаление не сохранено'; return false; }
        this.history.unshift({ at: now, title: 'Удалён раздел: ' + moduleById(id).title, source: this.feed.mode, kind: 'remove' });
        this.history = this.history.slice(0, 100);
        if (this.route.page === 'module' && this.route.id === id) this.route = { page: 'modules', tab: 0, focus: null };
        if (this.route.page === 'settings' && this.route.id === id) this.route = { page: 'settings', tab: 0, focus: null };
        return true;
    };
    App.prototype.restoreModule = function (id) {
        if (!this.isHidden(id)) return false;
        this.removeArm = null;
        this.settings.hidden = this.settings.hidden.filter(function (x) { return x !== id; });
        try { this.persist(JSON.parse(JSON.stringify(this.settings))); this.message = ''; }
        catch (e) { this.settings.hidden = this.settings.hidden.concat([id]); this.message = 'Не сохранено'; return false; }
        this.history.unshift({ at: Date.now(), title: 'Возвращён раздел: ' + moduleById(id).title, source: this.feed.mode, kind: 'restore' });
        this.history = this.history.slice(0, 100);
        return true;
    };
    App.prototype.selectColor = function (h, s) {
        if (!finite(h) || !finite(s)) return false;
        this.lighting.hue = Color.hue(h); this.lighting.saturation = Color.clamp(s, 0, 1);
        return true;
    };
    App.prototype.colorPoint = function (x, y) {
        var value = Color.fromPoint(x, y);
        if (!value) return false;
        this.lighting.edit = null;
        return this.selectColor(value.hue, value.saturation);
    };
    return { App: App, Feed: Feed, modules: modules, groups: groups, moduleById: moduleById, finite: finite, moduleSettings: Telemetry.schema, gameSettings:Game.fields, gameLabel:Game.label, Vitals: Vitals };
}));
