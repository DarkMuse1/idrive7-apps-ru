(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./energy-range'));else root.MguEnergy=factory(root.MguEnergyRange);}(this,function(Range){
    'use strict';
    var capacities=[null,7.6,9.2,10.4,11.2,12,14.1,17.7,19.4,24,25.7,42.2];
    // From apps/edrive/main.js: the low-battery hybrid zone, the default engine-start charge and
    // the typical full-battery range curve [°C, lo km, hi km] scaled by setting range20 (km at 20 °C).
    var HOLD_TOP=11,RESERVE=8,RANGE_CURVE=[[-10,20,30],[0,30,38],[10,40,45],[20,50,50]];
    var DEFAULT_PREFS={range20:50,reserve:'auto',hybrid:'auto',price:.25,distUnit:'km',tempUnit:'c',poll:15,gaugeKw:100,widgetFps:8,slowPoll:5};
    function rangeAt(tC,range20){
        var k=range20/50,c=RANGE_CURVE,t=finite(tC)?tC:10,lo,hi;
        if(t>=c[c.length-1][0]){lo=c[c.length-1][1];hi=c[c.length-1][2];}
        else if(t<=c[0][0]){var d=c[0][0]-t,sl=(c[1][1]-c[0][1])/(c[1][0]-c[0][0]),sh=(c[1][2]-c[0][2])/(c[1][0]-c[0][0]);lo=Math.max(15,c[0][1]-sl*d);hi=Math.max(18,c[0][2]-sh*d);}
        else{var i=0;while(t>c[i+1][0])i++;var f=(t-c[i][0])/(c[i+1][0]-c[i][0]);lo=c[i][1]+(c[i+1][1]-c[i][1])*f;hi=c[i][2]+(c[i+1][2]-c[i][2])*f;}
        return {lo:lo*k,hi:hi*k,mid:(lo+hi)/2*k};
    }
    function finite(x){return typeof x==='number'&&isFinite(x);}
    function empty(){return {schema:1,capacity:null,charges:[],range:{}};}
    function valid(s){
        function bucket(o,axis){return o&&typeof o==='object'&&finite(o[axis])&&o[axis]>=0&&finite(o.pct);}
        function bands(o,axis){return o===undefined||o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length<=8&&Object.keys(o).every(function(k){return /^[bv][0-4]$/.test(k)&&bucket(o[k],axis);});}
        if(!s||s.schema!==1||capacities.indexOf(s.capacity)<0||!Array.isArray(s.charges)||s.charges.length>40||!s.range||typeof s.range!=='object'||Array.isArray(s.range))return false;
        if(!s.charges.every(function(c){return c&&finite(c.from)&&finite(c.to)&&c.from>=0&&c.to<=100&&c.to-c.from>=3&&finite(c.fromT)&&finite(c.toT)&&c.fromT>=0&&c.toT>=c.fromT&&c.kind==='parked-rise'&&(c.kwh===undefined||c.kwh===null||finite(c.kwh)&&c.kwh>=0&&c.kwh<=200);}))return false;
        var r=s.range;return Object.keys(r).every(function(k){return ['learn','drive','driveOff','aux','acAux','base','evSpeed','engineAll','engineUse'].indexOf(k)>=0;})&&
            ['learn','engineAll'].every(function(k){return r[k]===undefined||bucket(r[k],'km');})&&['drive','driveOff','engineUse'].every(function(k){return bands(r[k],'km');})&&['aux','acAux'].every(function(k){return bands(r[k],'h');})&&
            (r.base===undefined||bucket(r.base,'h'))&&(r.evSpeed===undefined||r.evSpeed&&finite(r.evSpeed.km)&&r.evSpeed.km>=0&&finite(r.evSpeed.h)&&r.evSpeed.h>=0)&&
            (s.engineStarts===undefined||Array.isArray(s.engineStarts)&&s.engineStarts.length<=5&&s.engineStarts.every(function(x){return finite(x)&&x>=0&&x<=100;}))&&
            (s.lastSoc===undefined||s.lastSoc&&finite(s.lastSoc.value)&&s.lastSoc.value>=0&&s.lastSoc.value<=100&&finite(s.lastSoc.wall));
    }
    var bounds={speed:[0,400],rpm:[0,12000],hvPower:[-400,400],soc:[0,100],soh:[40,110],climate:[0,2],comfortKw:[0,.46],ambient:[-50,60]};
    function read(feed,key,now,age){var s=feed.read(key),r=bounds[key];return finite(s.value)&&(!r||s.value>=r[0]&&s.value<=r[1])&&now>=s.at&&now-s.at<=age?s.value:null;}
    function Energy(options){
        options=options||{};this.prefs=options.prefs||function(){return DEFAULT_PREFS;};this.saved=valid(options.saved)?JSON.parse(JSON.stringify(options.saved)):empty();
        // SOC seen when the previous run ended: compared once with the first SOC of this run (HU sleep).
        this.lastSeen=this.saved.lastSoc?JSON.parse(JSON.stringify(this.saved.lastSoc)):null;this.sleepNote=null;this.lastSocSave=-Infinity;this.demo=empty();this.persist=options.persist||function(){};this.error=options.saved&&!valid(options.saved)?'История eDrive не прочитана':'';this.key=null;this.mode=null;this.page=0;this.reset();
    }
    Energy.prototype.reset=function(){this.engineSeg=null;this.previous=null;this.soc=null;this.charge=null;this.chargeStored=false;this.chargeStoredTo=null;this.segment=null;this.trip={km:0,measuredKm:0,used:0,received:0,seconds:0};this.trace=[];this.lastTrace=-Infinity;this.lastSave=-Infinity;this.rangeEstimate=null;this.rangeReason='Недостаточно данных';};
    Energy.prototype.source=function(feed){var key=feed.mode+':'+feed.revision;if(key!==this.key){this.key=key;this.mode=feed.mode;this.reset();if(feed.mode==='demo')this.demo=empty();this.model=new Range.RangeModel(this.state().range);}};
    Energy.prototype.state=function(){return this.mode==='demo'?this.demo:this.saved;};
    Energy.prototype.save=function(){if(this.mode==='demo')return;try{this.persist(JSON.parse(JSON.stringify(this.saved)));this.error='';}catch(e){this.error='eDrive не сохранён: '+e.message;}};
    Energy.prototype.capacity=function(feed){this.source(feed);var s=this.state();s.capacity=capacities[(capacities.indexOf(s.capacity)+1)%capacities.length];s.range={};this.model=new Range.RangeModel(s.range);this.segment=null;this.rangeEstimate=null;this.save();};
    Energy.prototype.recordCharge=function(){
        if(!this.charge||this.charge.to-this.charge.from<3||this.chargeStoredTo===this.charge.to)return;
        var copy=JSON.parse(JSON.stringify(this.charge));copy.kwh=this.kwh(copy.from,copy.to,this.lastSoh);
        if(this.chargeStored)this.state().charges[0]=copy;else this.state().charges.unshift(copy);
        this.chargeStored=true;this.chargeStoredTo=this.charge.to;this.state().charges=this.state().charges.slice(0,40);this.save();
    };
    /** Charge at which the engine starts: the setting, or the median of >=2 learned starts (apps/edrive reserve()). */
    Energy.prototype.reserve=function(){
        var s=this.prefs().reserve;if(s!==null&&s!==undefined&&s!=='auto'&&isFinite(+s))return +s;
        var e=(this.state().engineStarts||[]).filter(function(x){return x>HOLD_TOP;}).sort(function(a,b){return a-b;});
        return Math.max(HOLD_TOP,e.length>=2?e[Math.floor(e.length/2)]:RESERVE);
    };
    Energy.prototype.finishCharge=function(){this.recordCharge();this.charge=null;this.chargeStored=false;this.chargeStoredTo=null;};
    Energy.prototype.update=function(feed,now){
        this.source(feed);if(!finite(now)||feed.mode==='offline')return;
        var s=this.state(),speed=read(feed,'speed',now,1000),rpm=read(feed,'rpm',now,1000),power=read(feed,'hvPower',now,4000),soc=read(feed,'soc',now,Math.max(45000,(this.prefs().poll||15)*3000)),climate=read(feed,'climate',now,5000),comfort=read(feed,'comfortKw',now,5000),ambient=read(feed,'ambient',now,5000),soh=read(feed,'soh',now,180000);
        if(soc!==null&&(soc<0||soc>100))soc=null;
        if(soh!==null)this.lastSoh=soh;
        var previous=this.previous,dt=previous?now-previous.at:0,continuous=dt>0&&dt<=1000;
        // Engine start while driving at a low charge: where this car stops driving electric (learned reserve).
        if(continuous&&previous.rpm!==null&&previous.rpm<300&&rpm!==null&&rpm>600&&speed!==null&&speed>3&&soc!==null&&soc<=20&&soc>HOLD_TOP){
            s.engineStarts=(s.engineStarts||[]).concat([Math.round(soc*10)/10]).slice(-5);this.save();
        }
        // HU sleep: the first SOC of this run against the one saved at the end of the previous run.
        // Reported as an observation only - neither a charge nor its cause is claimed.
        if(this.mode==='vehicle'&&soc!==null&&this.lastSeen){var gap=Date.now()-this.lastSeen.wall;if(Math.abs(soc-this.lastSeen.value)>=.5&&gap>120000)this.sleepNote={from:this.lastSeen.value,to:soc,fromWall:this.lastSeen.wall,toWall:Date.now()};this.lastSeen=null;}
        if(this.mode==='vehicle'&&soc!==null&&now-this.lastSocSave>=60000){this.saved.lastSoc={value:soc,wall:Date.now()};this.lastSocSave=now;this.save();}
        if(previous&&dt<=0)return;
        if(continuous&&speed!==null&&previous.speed!==null){
            var km=(speed+previous.speed)/2*dt/3600000;this.trip.km+=km;
            if(power!==null&&previous.power!==null){
                // Split a sign crossing exactly, so energy in/out do not cancel.
                var p0=previous.power,p1=power,h=dt/3600000,used=0,received=0;
                if(p0*p1<0){var f=Math.abs(p0)/(Math.abs(p0)+Math.abs(p1));used=(Math.max(p0,0)*f+Math.max(p1,0)*(1-f))*h/2;received=(-Math.min(p0,0)*f-Math.min(p1,0)*(1-f))*h/2;}
                else{used=Math.max(0,(p0+p1)/2)*h;received=-Math.min(0,(p0+p1)/2)*h;}
                this.trip.used+=used;this.trip.received+=received;this.trip.measuredKm+=km;this.trip.seconds+=dt/1000;
            }
            if(this.segment)this.segment.km+=km;
        }
        // Learning is permitted only with continuous, known vehicle/comfort states.
        var known=continuous&&speed!==null&&rpm!==null&&rpm<400&&climate!==null&&comfort!==null&&ambient!==null;
        if(this.segment){this.segment.valid=this.segment.valid&&known&&!this.charge;this.segment.mixed=this.segment.mixed||climate!==this.segment.climate;}
        var parked=continuous&&speed!==null&&speed<=3&&rpm!==null&&rpm<400;
        if(this.charge&&!parked)this.finishCharge();
        if(!continuous||speed===null||rpm===null){this.soc=null;this.segment=null;this.engineSeg=null;}
        if(this.engineSeg){if(rpm<300)this.engineSeg.all=false;if(continuous&&speed!==null&&previous.speed!==null)this.engineSeg.km+=(speed+previous.speed)/2*dt/3600000;}
        var point=feed.read('soc');
        if(soc!==null&&(!this.soc||point.at>this.soc.at)){
            var old=this.soc,span=old?point.at-old.at:0;
            if(old&&span>0&&span<=120000){
                if(parked&&old.parked&&soc>old.value+.3){if(!this.charge){this.chargeStart=old.at;this.charge={kind:'parked-rise',from:old.value,to:soc,fromT:old.wall,toT:old.wall+span};}else{this.charge.to=Math.max(this.charge.to,soc);this.charge.toT=this.charge.fromT+point.at-this.chargeStart;}this.recordCharge();}
                else if(this.charge&&soc<this.charge.to-2)this.finishCharge();
                var seg=this.segment,kpp=s.capacity&&soh!==null?s.capacity*soh/10000:null;
                if(seg&&seg.valid&&!seg.mixed&&!this.charge&&Math.min(old.value,soc)>8&&kpp>0){this.model.learn(old.value-soc,span/3600000,seg.km,ambient,kpp,climate===2?'ac':climate===1,comfort);if(now-this.lastSave>=60000){this.save();this.lastSave=now;}}
                // Engine ran the whole stretch: the battery's own use, kept apart (original learnEngine).
                var es=this.engineSeg;if(es&&es.all&&!this.charge&&Math.min(old.value,soc)>HOLD_TOP+1){this.model.learnEngine(old.value-soc,span/3600000,es.km);if(now-this.lastSave>=60000){this.save();this.lastSave=now;}}
            }
            this.soc={value:soc,at:point.at,wall:Date.now(),parked:parked};this.segment={km:0,valid:known,climate:climate,mixed:false};
            this.engineSeg=continuous&&speed!==null&&rpm!==null&&rpm>400?{km:0,all:true}:null;
        }
        // A missing speed at any point breaks proof that a SOC increase was parked.
        if(this.soc&&!parked)this.soc.parked=false;
        var perPct=s.capacity&&soh!==null?s.capacity*soh/10000:null;
        // Only the charge above the engine-start point counts (apps/edrive estimate()).
        var res=this.reserve(),use=soc===null?null:Math.max(0,soc-res),span=Math.max(1,100-res);
        this.rangeEstimate=perPct&&climate!==null&&comfort!==null&&ambient!==null?this.model.range(use,ambient,perPct,climate===2?'ac':climate===1,speed,comfort):null;
        if(this.rangeEstimate)this.rangeEstimate.learned=true;
        else if(use!==null&&ambient!==null){
            // Before electric driving is learned: the typical curve scaled to range20, labelled as such.
            var curve=rangeAt(ambient,this.prefs().range20),kpp0=curve.mid/span;
            this.rangeEstimate={mid:use*kpp0,lo:use*curve.lo/span,hi:use*curve.hi/span,kpp:kpp0,learned:false};
        }
        if(this.rangeEstimate)this.rangeEstimate.reserve=res;
        this.rangeReason=!s.capacity?'Задайте ёмкость батареи':soh===null?'Нет данных SOH':climate===null||comfort===null?'Нет данных климатических систем':ambient===null?'Нет наружной температуры':!this.rangeEstimate?'Обучение: нужны поездки на электротяге':'Оценка по поездкам';
        if(now-this.lastTrace>=1000){this.trace.push([now,power]);this.trace=this.trace.filter(function(p){return now-p[0]<=120000;});this.lastTrace=now;}
        this.previous={at:now,speed:speed,power:power,rpm:rpm};
    };
    Energy.prototype.view=function(feed){this.source(feed);var st=this.state();
        return {trip:this.trip,charges:st.charges,charging:this.charge,capacity:st.capacity,range:this.rangeEstimate,rangeReason:this.rangeReason,trace:this.trace,error:this.error,
            reserve:this.reserve(),engineStarts:(st.engineStarts||[]).slice(),enginePerKm:this.model?this.model.enginePctPerKm(null):null,sleepNote:this.mode==='vehicle'?this.sleepNote:null};};
    /** kWh of a SOC rise with known capacity and SOH; null otherwise (no invented energy). */
    Energy.prototype.kwh=function(from,to,soh){var c=this.state().capacity;return c&&finite(soh)&&finite(from)&&finite(to)?(to-from)/100*c*soh/100:null;};
    Energy.demo=function(feed,now){if(feed.mode!=='demo')return;var d={soc:67,hvVoltage:350,hvCurrent:-34.28,hvPower:12,soh:95,voltage:14.2,batteryTemp:27,cellMin:3.82,cellMax:3.83,climate:0,comfortKw:0,ambient:18};Object.keys(d).forEach(function(k){feed.put(k,d[k],'demo',now,'demo:energy');});};
    return {Energy:Energy,empty:empty,valid:valid,capacities:capacities,rangeAt:rangeAt,HOLD_TOP:HOLD_TOP,RESERVE:RESERVE,DEFAULT_PREFS:DEFAULT_PREFS};
}));
