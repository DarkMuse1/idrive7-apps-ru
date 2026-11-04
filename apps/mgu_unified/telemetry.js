(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MguTelemetry = factory();
}(this, function () {
    'use strict';
    // Extracted/adapted from redline, warmup and gforce main.js. Screen-independent,
    // monotonic timestamps only; no ECU commands. Thresholds are user estimates.
    var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
    var finite = function (v) { return typeof v === 'number' && isFinite(v); };
    var own = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };
    // Engine profile of M Vitals 2.14.0, Redline 1.9.0, Virtual Dyno 1.3.0 and Warm-Up 1.5.0 (upstream
    // idrive7-apps ece3506 kit/engine.js, 8de7f46, 4142a3b, 2800dc6, f89099f). The type comes from
    // Vehicle2.statusVehiclePartType.typeEngine (VehicleTypes.TypeEngine, names or wire numbers: 6 / 7 diesel,
    // 4 / 5 / 8 / 9 petrol; 0 = no information, 15 = invalid, anything else = unknown). Unknown never clears a
    // known type; nothing known = petrol. One shell-wide setting «Тип двигателя» (auto / diesel / petrol)
    // replaces the apps' own "engine" settings: it is one engine for every module of this car.
    var ENGINE = { diesel: { scaleMax: 6000, redline: 5000 }, petrol: { scaleMax: 8000, redline: 7000 } };
    var ENGINE_SETTINGS = ['auto', 'diesel', 'petrol'];
    var ENGINE_TYPES = { 4: 'petrol', 5: 'petrol', 6: 'diesel', 7: 'diesel', 8: 'petrol', 9: 'petrol',
        BENZIN_DIREKTEINSPRITZUNG: 'petrol', BENZIN_KONVENTIONELL: 'petrol', DIESEL_DIREKTEINSPRITZUNG: 'diesel',
        DIESEL_KONVENTIONELL: 'diesel', ELEKTROMOTOR: 'petrol', HYBRIDMOTOR: 'petrol' };
    function engineType(raw) { return (typeof raw === 'number' || typeof raw === 'string') && own(ENGINE_TYPES, raw) ? ENGINE_TYPES[raw] : null; }
    function engineProfile(setting, detected) {
        return setting === 'diesel' || setting === 'petrol' ? setting : detected === 'diesel' || detected === 'petrol' ? detected : 'petrol';
    }
    // "0" (Авто) of the rpm settings, per profile, exactly as the apps: a redline is the profile's and never
    // above its scale end; the cold limits and the dyno graph top per profile (kit engine.value()).
    var AUTO = { redline: { coldLimit: { diesel: 3000, petrol: 4500 } }, warmup: { coldLimit: { diesel: 3000, petrol: 3500 } },
        dyno: { maxRpm: { diesel: 6000, petrol: 8000 } } };
    function autoValue(v, perProfile, profile) { return finite(v) && v !== 0 ? v : perProfile[profile]; }
    function redlineOf(v, profile) { return Math.min(autoValue(v, { diesel: ENGINE.diesel.redline, petrol: ENGINE.petrol.redline }, profile), ENGINE[profile].scaleMax); }
    /** The rpm values the modules use: the settings with Авто resolved for the profile ('diesel' / 'petrol'). */
    function limits(prefs, profile) {
        var p = profile === 'diesel' ? 'diesel' : 'petrol', s = prefs || {};
        var get = function (id, key) { return s[id] ? s[id][key] : undefined; }, warm = redlineOf(get('warmup', 'redline'), p);
        return { profile: p, scaleMax: ENGINE[p].scaleMax, autoRedline: ENGINE[p].redline,
            redline: { redline: redlineOf(get('redline', 'redline'), p), coldLimit: autoValue(get('redline', 'coldLimit'), AUTO.redline.coldLimit, p) },
            warmup: { redline: warm, coldLimit: Math.min(autoValue(get('warmup', 'coldLimit'), AUTO.warmup.coldLimit, p), warm) },
            dyno: { maxRpm: autoValue(get('dyno', 'maxRpm'), AUTO.dyno.maxRpm, p) },
            car_vitals: { redline: redlineOf(get('car_vitals', 'redline'), p) } };
    }
    // Before the engine profile these rpm settings had fixed defaults (below) and the redlines went up to 9000.
    // module-settings.json keeps every value, so an untouched default cannot be told from a chosen one: as the
    // apps' "reset": 1 does, a saved OLD default becomes Авто (0) once - the mark _rpmAuto in the file - and
    // every other saved choice still offered is kept. 8500 / 9000 are no longer offered: Авто as well.
    var RPM_DEFAULTS = { redline: { redline: 7000, coldLimit: 4500 }, warmup: { redline: 7000, coldLimit: 3500 }, dyno: { maxRpm: 7500 }, car_vitals: { redline: 7000 } };
    var RPM_AUTO = 1;
    function fromOldDefault(id, key, v) { return own(RPM_DEFAULTS[id], key) && v === RPM_DEFAULTS[id][key] ? 0 : v; }
    var schema = {
        dyno: [
            ['ecuTorque', 'Момент ECU на графике', true, [true,false], ''],
            ['weight', 'Масса с водителем и топливом', 1750, [1300,1400,1500,1550,1600,1650,1700,1750,1800,1850,1900,1950,2000,2100,2200,2300,2400,2500], 'кг'],
            ['body', 'Кузов', 'coupe', ['coupe','wagon','suv'], ''],
            ['loss', 'Потери трансмиссии', 15, [0,10,12,15,18,20,25], '%'],
            ['powerUnit', 'Мощность', 'hp', ['hp','ps','kw'], ''],
            ['torqueUnit', 'Момент', 'nm', ['nm','lbft'], ''],
            ['maxRpm', 'Шкала оборотов', 0, [0,4500,5000,5500,6000,6500,7000,7500,8000,9000], 'об/мин']
        ],
        draggy: [
            ['rollout', 'Вычет первого фута', false, [false,true], ''],
            ['distance', 'Дистанция', 'qm', ['qm','em','m1000'], ''],
            ['speedRate', 'Частота цифр скорости', 10, [5,10,15,30,60], 'кадр/с']
        ],
        brake_test: [
            ['trigger', 'Порог торможения', 0.4, [0.2,0.3,0.4,0.5,0.6], 'g'],
            ['distUnit', 'Единицы расстояния', 'm', ['m','ft'], '']
        ],
        redline: [
            ['redline', 'Красная зона', 0, [0,4500,5000,5500,6000,6500,7000,7200,7500,7800,8000], 'об/мин'],
            ['shiftBefore', 'Запас до красной зоны', 300, [0,100,200,300,500,800,1000], 'об/мин'],
            ['coldGuard', 'Поправка на холодное масло', true, [true,false], ''],
            ['coldLimit', 'Ориентир на холодную', 0, [0,2500,3000,3500,4000,4500,5000,5500], 'об/мин'],
            ['warmOil', 'Прогрев масла', 80, [60,70,80,90], '°C'],
            ['peakHold', 'Удержание пика', 15, [0,5,10,15,30,60], 'с'],
            ['lights', 'Стиль ламп переключения', 'm', ['m','f1','mono'], ''],
            ['flash', 'Мигание в точке переключения', false, [false,true], ''],
            ['speedRate', 'Частота цифр скорости', 10, [5,10,15,30,60], 'кадр/с']
        ],
        warmup: [
            ['warmOil', 'Прогрев масла', 80, [60,70,75,80,85,90,100], '°C'],
            ['warmCoolant', 'Прогрев ОЖ', 80, [60,70,75,80,85,90], '°C'],
            ['coldLimit', 'Ориентир на холодную', 0, [0,2500,3000,3500,4000,4500], 'об/мин'],
            ['redline', 'Ориентир на прогретом', 0, [0,4500,5000,5500,6000,6500,7000,7200,7500,8000], 'об/мин'],
            ['cooldown', 'Оценка охлаждения', true, [true,false], ''],
            ['tempUnit', 'Температура', 'c', ['c','f'], '']
        ],
        gforce: [
            ['scale', 'Шкала круга', 1.5, [1,1.5,2], 'g'],
            ['trail', 'След на круге', 4, [2,4,8,15], 'с'],
            ['flipLat', 'Поменять лево / право', false, [false,true], ''],
            // apps/gforce 1.5.0 (upstream 0a3e7e1, issue #62): only the drawing; peaks and records stay as they are
            ['flipLong', 'Торможение сверху', false, [false,true], ''],
            ['gRate', 'Частота цифр g', 10, [5,10,15,30,60], 'кадр/с']
        ],
        // apps/car_vitals 2.14.0 settings (speedUnit is the shell-wide unit, engine the shell-wide «Тип двигателя»;
        // flipLong belongs to its G circle: this module has none, the one G circle is G-Force's own flipLong).
        car_vitals: [
            ['page', 'Стартовая вкладка', 'engine', ['engine','thermal','fuel','chassis'], ''],
            ['tempUnit', 'Температура', 'C', ['C','F'], ''],
            ['pressUnit', 'Давление', 'bar', ['bar','psi'], ''],
            ['boostMax', 'Шкала наддува', '2.5', ['2.0','2.5','3.0','3.5'], ''],
            ['redline', 'Красная зона', 0, [0,4500,5000,5500,6000,6500,7000,7200,7500,8000], 'об/мин'],
            ['maxPower', '100 % спорт-индикатора', 215, [100,120,135,140,150,160,170,185,190,200,215,230,240,250,260,275,285,300,320,340,360,375,390,405,420,450,460,480,500,530,550,600], 'кВт'],
            ['maxTorqueKgm', 'Шкала момента в кгс·м', 100, [20,25,30,40,50,60,80,100], 'кгс·м'],
            ['powerUnit', 'Мощность', 'kw', ['kw','hp','ps'], ''],
            ['torqueUnit', 'Момент', 'nm', ['nm','lbft','kgm'], ''],
            ['powerSource', 'Мощность из', 'sport', ['sport','calc'], ''],
            ['oilWarn', 'Предупреждение по маслу', 125, [110,115,120,125,130,135], '°C'],
            ['peaks', 'Пиковые значения', true, [true,false], ''],
            ['peakHold', 'Удержание пика', 15, [5,10,15,30,60], 'с'],
            ['xdrive', 'Карточка xDrive', 'auto', ['auto','on','off'], ''],
            ['showBoost', 'Наддув', 'auto', ['auto','on','off'], ''],
            ['boostSource', 'Наддув из', 'auto', ['auto','fes','dme'], ''],
            ['showGearbox', 'Масло коробки', 'auto', ['auto','on','off'], ''],
            ['showEgs', 'Коробка (EGS)', 'auto', ['auto','on','off'], ''],
            ['showIat', 'Температура впуска', 'auto', ['auto','on','off'], ''],
            ['showHpfp', 'Топливо · высокое', 'auto', ['auto','on','off'], ''],
            ['showLpfp', 'Топливо · низкое', 'auto', ['auto','on','off'], ''],
            ['showTiming', 'Угол зажигания', 'auto', ['auto','on','off'], ''],
            ['showMisfire', 'Счётчик пропусков', 'auto', ['auto','on','off'], ''],
            ['showTyres', 'Карточка шин', 'auto', ['auto','on','off'], ''],
            ['showTyreTemp', 'Температура шин', 'auto', ['auto','on','off'], ''],
            ['speedRate', 'Частота цифр скорости', 10, [5,10,15,30,60], 'кадр/с']
        ],
        // apps/edrive 2.2.0 settings. designKwh is replaced by the explicit capacity (default unknown);
        // sohDays/diagPage/scanUnit are not used by the unified reader (see README).
        edrive: [
            ['range20', 'Запас хода полной батареи при 20 °C', 50, [30,35,40,45,50,55,60,65,70,80,90,100], 'км'],
            ['reserve', 'ДВС запускается при', 'auto', ['auto','0','4','5','6','7','8','9','10','12','15'], ''],
            ['hybrid', 'Гибридная система', 'auto', ['auto','yes','no'], ''],
            ['price', 'Цена электроэнергии', 0.25, [0,0.05,0.1,0.12,0.15,0.16,0.17,0.18,0.19,0.2,0.21,0.22,0.23,0.24,0.25,0.26,0.27,0.28,0.29,0.3,0.31,0.32,0.33,0.34,0.35,0.36,0.37,0.38,0.39,0.4,0.45,0.5,0.55,0.6,0.7], 'EUR/кВт·ч'],
            ['distUnit', 'Расстояние', 'km', ['km','mi'], ''],
            ['tempUnit', 'Температура', 'c', ['c','f'], ''],
            ['poll', 'Чтение заряда', 15, [5,10,15,30,60], 'с'],
            ['gaugeKw', 'Шкала мощности', 100, [60,80,100,120,150], 'кВт'],
            ['widgetFps', 'Виджет · кадров в секунду', 8, [2,4,8,12], ''],
            ['slowPoll', 'Чтение ячеек и температур', 5, [2,5,10,30], 'с']
        ],
        // Original Service setting resetOn: off by default. It only permits asking for a reset.
        service: [
            ['resetOn', 'Сброс интервалов CBS', false, [false,true], '']
        ]
    };
    function settings(saved) {
        var out = {}; saved = saved || {};
        var migrate = saved._rpmAuto !== RPM_AUTO;              // a file from before the engine profile (see RPM_DEFAULTS)
        Object.keys(schema).forEach(function (id) {
            out[id] = {};
            schema[id].forEach(function (d) {
                var v = saved[id] && saved[id][d[0]];
                if (migrate) v = fromOldDefault(id, d[0], v);
                out[id][d[0]] = d[3].indexOf(v) >= 0 ? v : d[2];
            });
        });
        out._rpmAuto = RPM_AUTO; return out;
    }
    var ranges = { rpm:[0,12000], speed:[0,400], oil:[-40,170], coolant:[-40,160], torque:[-1023.5,1023.5], gear:[-1,10], gLat:[-3,3], gLong:[-3,3] };
    function snapshot(feed) {
        var d = { source:feed.mode };
        Object.keys(ranges).forEach(function (k) { var s=feed.read(k), r=ranges[k]; d[k] = finite(s.value) && s.value>=r[0] && s.value<=r[1] ? s.value : null; });
        if(d.gear!==null && Math.floor(d.gear)!==d.gear)d.gear=null;
        d.gearEstimated = /guess/i.test(feed.read('gear').source);
        return d;
    }
    // s = the Tachometer settings; Авто (0) of redline / coldLimit resolved for profile (default petrol).
    function shiftPoint(oil, s, profile) {
        var p=profile==='diesel'?'diesel':'petrol';
        // never below 2500 rpm: shifts under that are not scored (upstream 4142a3b)
        var normal=Math.max(2500,redlineOf(s.redline,p)-s.shiftBefore);
        if (!s.coldGuard) return {rpm:normal,cold:false};
        if (!finite(oil)) return {rpm:normal,cold:false,oilUnknown:true};
        var cold=Math.min(autoValue(s.coldLimit,AUTO.redline.coldLimit,p),normal), f=clamp((oil-30)/(s.warmOil-30),0,1);
        return {rpm:Math.round((cold+(normal-cold)*f)/50)*50,cold:oil<s.warmOil};
    }
    // All-time G-Force records as in apps/gforce (data/gforce_records.json): acc, brk, left, right,
    // comb, vmax, each {v, at}. Vehicle records persist; DEMO records stay in memory only.
    var RECORD_KEYS = ['acc','brk','left','right','comb','vmax'];
    function validRecords(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        return Object.keys(v).every(function (k) { var r=v[k]; return RECORD_KEYS.indexOf(k)>=0 && r && typeof r==='object' && finite(r.v) && r.v>=0 && r.v<=(k==='vmax'?500:5) && finite(r.at); });
    }
    function Telemetry(prefs, onEvent, options) {
        options = options || {}; this.prefs=prefs || settings(); this.onEvent=onEvent || function () {}; this.mode=null;
        this.records = { vehicle: validRecords(options.records) ? JSON.parse(JSON.stringify(options.records)) : {}, demo: {} };
        this.recordsError = options.records !== undefined && options.records !== null && !validRecords(options.records) ? 'Прежние рекорды не распознаны' : '';
        this.persistRecords = options.persistRecords || null; this.reset();
        // engine profile ('diesel' / 'petrol') of the shell; petrol without one, as nothing known
        this.profile = typeof options.profile === 'function' ? options.profile : function () { return 'petrol'; };
    }
    Telemetry.prototype.limits = function () { return limits(this.prefs, this.profile()); };
    Telemetry.prototype.clearRecords = function (mode) {
        var key = mode === 'demo' ? 'demo' : 'vehicle'; this.records[key] = {};
        if (key === 'vehicle' && this.persistRecords) this.persistRecords({});
    };
    Telemetry.prototype.reset = function (id) {
        if (!id || id==='redline') this.redline={recent:[],shifts:[],lastGear:null,lastShift:null,peak:null,peakAt:null,maxRpm:null,maxSpeed:null,hits:0,onLimit:false};
        if (!id || id==='warmup') this.warmup={history:[],lastHist:null,hard:0,need:0,cool:0,doneAt:null};
        if (!id || id==='gforce') this.gforce={smooth:[],trail:[],env:Array(36).fill(0),peak:{acc:null,brk:null,left:null,right:null,combined:null,speed:null},over05:0};
        this.last=null; this.previous=null;
    };
    Telemetry.prototype.source = function (feed) {
        var key=feed.mode+':'+feed.revision;
        if (this.mode!==key) { this.reset(); this.mode=key; }
    };
    Telemetry.prototype.breakContinuity = function () {
        this.redline.recent=[]; this.redline.lastGear=null; this.redline.onLimit=false;
        this.gforce.smooth=[]; this.gforce.trail=[];
        this.last=null; this.previous=null;
    };
    Telemetry.prototype.sample = function (feed,t) {
        this.source(feed);
        if (!finite(t) || feed.mode==='offline') return;
        if (this.last!==null && t<=this.last) return;
        if (this.last!==null && t-this.last>1000) this.breakContinuity();
        var dt=this.last===null?0:clamp(t-this.last,0,250)/1000;
        this.last=t; var d=snapshot(feed), previous=this.previous, self=this;
        this.previous=d;
        var rs=this.prefs.redline, r=this.redline, L=this.limits(), red=L.redline.redline;
        if (d.rpm!==null) {
            r.recent.push([t,d.rpm]); r.recent=r.recent.filter(function (p) {return t-p[0]<1200;});
            if (r.peak===null || d.rpm>=r.peak || rs.peakHold>0 && t-r.peakAt>rs.peakHold*1000) {r.peak=d.rpm;r.peakAt=t;}
            r.maxRpm=Math.max(r.maxRpm===null?0:r.maxRpm,d.rpm);
            if(d.speed!==null) r.maxSpeed=Math.max(r.maxSpeed===null?0:r.maxSpeed,d.speed);
            var limit=d.rpm>=red-60; if(limit&&!r.onLimit) r.hits++; r.onLimit=limit;
            var estimated=d.gearEstimated || d.gear===null;
            var detected=!estimated && d.gear>0 && r.lastGear>0 && d.gear===r.lastGear+1;
            var hi=Math.max.apply(null,r.recent.filter(function(p){return t-p[0]<400;}).map(function(p){return p[1];}));
            var inferred=estimated && r.recent.length>4 && d.speed>10 && hi>3000 && d.rpm<hi*.82 && (r.lastShift===null || t-r.lastShift>800);
            if(detected || inferred) {
                var rpm=Math.max.apply(null,r.recent.filter(function(p){return t-p[0]<600;}).map(function(p){return p[1];}));
                if(rpm>2500) {
                    var point=shiftPoint(d.oil,rs,L.profile);
                    var verdict=rpm>=red-60?'Красная зона':rpm<point.rpm-250?'Рано':rpm>point.rpm+200?(point.cold?'Холодное масло':'Поздно'):'В ориентир';
                    var shift={at:t,from:detected?r.lastGear:null,to:detected?d.gear:null,rpm:Math.round(rpm),target:point.rpm,verdict:verdict,estimated:inferred,source:feed.mode};
                    r.shifts.unshift(shift);r.shifts=r.shifts.slice(0,60);r.lastShift=t;
                    self.onEvent({kind:'shift',source:feed.mode,title:(inferred?'Предполагаемое переключение':'Переключение '+shift.from+' → '+shift.to)+' · '+shift.rpm+' об/мин',detail:shift});
                }
            }
            r.lastGear=!estimated?d.gear:null;
        } else {r.recent=[];r.lastGear=null;r.onLimit=false;}
        var gs=this.prefs.gforce,g=this.gforce;
        if(d.gLat===null || d.gLong===null) {g.smooth=[];g.trail=[];}
        else {
            g.smooth.push([t,gs.flipLat?-d.gLat:d.gLat,d.gLong]);g.smooth=g.smooth.filter(function(p){return t-p[0]<=150;});
            var lat=g.smooth.reduce(function(a,p){return a+p[1];},0)/g.smooth.length, lon=g.smooth.reduce(function(a,p){return a+p[2];},0)/g.smooth.length;
            var comb=Math.sqrt(lat*lat+lon*lon), values={acc:Math.max(0,lon),brk:Math.max(0,-lon),left:Math.max(0,lat),right:Math.max(0,-lat),combined:comb,speed:d.speed};
            Object.keys(values).forEach(function(k){if(values[k]!==null)g.peak[k]=Math.max(g.peak[k]===null?0:g.peak[k],values[k]);});
            if(feed.mode==='vehicle'||feed.mode==='demo'){
                var R=this.records[feed.mode],changed=false,now=Date.now();
                [['acc',values.acc],['brk',values.brk],['left',values.left],['right',values.right],['comb',comb],['vmax',d.speed]].forEach(function(p){
                    if(finite(p[1])&&p[1]>((R[p[0]]&&R[p[0]].v)||0)+1e-3){R[p[0]]={v:p[1],at:now};changed=true;}
                });
                if(changed&&feed.mode==='vehicle'&&this.persistRecords){try{this.persistRecords(JSON.parse(JSON.stringify(R)));this.recordsError='';}catch(e){this.recordsError='Рекорды не сохранены';}}
            }
            if(comb>.5 && g.trail.length) g.over05+=dt;
            var sector=Math.floor(((Math.atan2(lat,lon)*180/Math.PI+360)%360)/10);g.env[sector]=Math.max(g.env[sector],comb);
            g.trail.push([t,lat,lon]);g.trail=g.trail.filter(function(p){return t-p[0]<=gs.trail*1000;}).slice(-1000);
        }
        var w=this.warmup;
        if(w.lastHist===null || t-w.lastHist>=5000) {
            w.lastHist=t;w.history.push([t,d.oil,d.coolant,d.rpm,d.speed]);w.history=w.history.filter(function(p){return t-p[0]<=1200000;}).slice(-241);
        }
        if(this.prefs.warmup.cooldown && d.rpm!==null) {
            var kw=d.torque===null?null:d.torque*d.rpm/9549;
            var hard=d.rpm>3800 || kw!==null && kw>90;
            // Missing torque is not evidence of gentle load. Do not count cooling.
            var gentle=d.rpm>=300 && d.rpm<2800 && kw!==null && kw<40;
            var previousLoad=previous&&previous.rpm!==null&&previous.torque!==null;
            var hardDt=previous&&previous.rpm!==null?dt:0;
            var coolDt=previousLoad&&previous.rpm>=300?dt:0;
            if(hard){w.hard+=hardDt;w.cool=0;w.doneAt=null;if(w.hard>8)w.need=clamp(30+w.hard*3,30,180);}
            else if(w.need>0&&gentle){w.cool+=coolDt;if(w.cool>=w.need&&w.doneAt===null)w.doneAt=t;}
            else if(!w.need){w.hard=Math.max(0,w.hard-dt*.2);}
            if(w.doneAt!==null&&t-w.doneAt>20000){w.hard=0;w.need=0;w.cool=0;w.doneAt=null;}
        }
    };
    Telemetry.prototype.eta = function (idx,temp,target,d) {
        if(temp===null)return {state:'none'};
        if(temp>=target)return {state:'ready'};
        if(d.rpm===null)return {state:'none'};
        if(d.rpm<300)return {state:'off'};
        var h=this.warmup.history,last=h.length?h[h.length-1][0]:0;
        // Do not regress across an interruption/missing temperature.
        var points=[];
        for(var i=h.length-1;i>=0;i--){if(last-h[i][0]>=180000||h[i][idx]===null||i<h.length-1&&h[i+1][0]-h[i][0]>6000)break;points.unshift(h[i]);}
        var span=points.length>=4?points[points.length-1][0]-points[0][0]:0;
        var rate=null;
        if(span){var mx=points.reduce(function(a,p){return a+p[0];},0)/points.length,my=points.reduce(function(a,p){return a+p[idx];},0)/points.length,num=0,den=0;points.forEach(function(p){num+=(p[0]-mx)*(p[idx]-my);den+=(p[0]-mx)*(p[0]-mx);});if(den)rate=num/den*60000;}
        var typ=idx===1?(d.speed>10?4:1.5):(d.speed>10?7:3), weight=clamp(span/120000,0,1);
        rate=rate===null?typ:weight*rate+(1-weight)*typ;
        if(weight>.8&&rate<.15)return {state:'stalled',rate:rate};
        return {state:'warming',minutes:(target-temp)/Math.max(.15,rate),typical:weight<.5,rate:rate};
    };
    Telemetry.prototype.view = function(feed) {
        this.source(feed);var d=snapshot(feed),s=this.prefs.warmup,w=this.warmup,g=this.gforce,L=this.limits(),wl=L.warmup;
        var tail=g.trail.length?g.trail[g.trail.length-1]:null, both=d.gLat!==null&&d.gLong!==null;
        return {data:d,limits:L,redline:this.redline,shiftPoint:shiftPoint(d.oil,this.prefs.redline,L.profile),
            gforce:{lat:both&&tail?tail[1]:null,long:both&&tail?tail[2]:null,trail:both?g.trail:[],env:g.env,peak:g.peak,over05:g.over05},
            warmup:{oil:this.eta(1,d.oil,s.warmOil,d),coolant:this.eta(2,d.coolant,s.warmCoolant,d),history:w.history,
                revLimit:d.oil===null?null:Math.round((wl.coldLimit+(wl.redline-wl.coldLimit)*clamp((d.oil-30)/(s.warmOil-30),0,1))/100)*100,
                cooling:!s.cooldown?'disabled':d.rpm===null||d.torque===null?'unknown':d.rpm<300?'off':w.doneAt!==null?'done':w.need>0?'cooling':'idle',
                seconds:Math.max(0,Math.ceil(w.need-w.cool))}};
    };
    return {Telemetry:Telemetry,schema:schema,settings:settings,shiftPoint:shiftPoint,validRecords:validRecords,recordKeys:RECORD_KEYS,
        ENGINE:ENGINE,ENGINE_SETTINGS:ENGINE_SETTINGS,engineType:engineType,engineProfile:engineProfile,limits:limits,
        RPM_DEFAULTS:RPM_DEFAULTS,fromOldDefault:fromOldDefault};
}));
