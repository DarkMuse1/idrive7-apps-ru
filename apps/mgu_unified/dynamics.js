(function(root,factory){
    if(typeof module==='object'&&module.exports)module.exports=factory(require('./drag-timer'),require('./dyno'));
    else root.MguDynamics=factory(root.MguDragTimer,root.MguDyno);
}(this,function(Timer,Dyno){
    'use strict';
    var finite=function(v){return typeof v==='number'&&isFinite(v);};
    var object=function(v){return v&&typeof v==='object'&&!Array.isArray(v);};
    var nonnegative=function(v){return finite(v)&&v>=0;};
    var MPH=1.609344;
    var SPLITS={
        kmh:[{key:'0-50',from:0,to:50},{key:'0-100',from:0,to:100},{key:'100-200',from:100,to:200},{key:'0-200',from:0,to:200}],
        mph:[{key:'0-30mph',from:0,to:30*MPH},{key:'0-60mph',from:0,to:60*MPH},{key:'60-130mph',from:60*MPH,to:130*MPH},{key:'0-100mph',from:0,to:100*MPH}]
    };
    var DIST={qm:{key:'qm',dist:402.336},em:{key:'em',dist:201.168},m1000:{key:'m1000',dist:1000}};
    var dragKeys=['0-50','0-100','100-200','0-200','0-30mph','0-60mph','60-130mph','0-100mph','qm','em','m1000'];
    function splitsFor(unit,distance){return SPLITS[unit==='mph'?'mph':'kmh'].concat([DIST[distance]||DIST.qm]);}
    function validRecord(r,kind){
        if(kind==='dyno')return object(r)&&r.source==='vehicle'&&finite(r.at)&&['peakP','peakPrpm','peakT','peakTrpm','weight','loss','v0','v1'].every(function(k){return nonnegative(r[k]);})
            &&r.weight>=100&&r.weight<=10000&&r.loss<100&&Array.isArray(r.curve)&&r.curve.length>0&&r.curve.length<=150
            &&r.curve.every(function(p){return object(p)&&['rpm','p','t'].every(function(k){return nonnegative(p[k]);})&&p.rpm>0&&p.rpm<=12000&&(p.ecu===null||finite(p.ecu));});
        if(!object(r)||r.source!=='vehicle'||!finite(r.at)||!object(r.result)||!Object.keys(r.result).length)return false;
        if(!Array.isArray(r.trace)||r.trace.length>1800||!r.trace.every(function(p){return Array.isArray(p)&&p.length===2&&p.every(nonnegative);}))return false;
        return Object.keys(r.result).every(function(k){var v=r.result[k];return kind==='draggy'?dragKeys.indexOf(k)>=0&&nonnegative(v)&&v<=40:['100-0','200-0'].indexOf(k)>=0&&object(v)&&nonnegative(v.s)&&v.s<=60&&nonnegative(v.m)&&v.m<5000;})
            &&(kind!=='draggy'||typeof r.rollout==='boolean'&&(r.unit===undefined||r.unit==='kmh'||r.unit==='mph'))&&(kind!=='brake_test'||nonnegative(r.peakG)&&r.peakG<=3);
    }
    function validHistory(h){return object(h)&&h.schema===1&&['draggy','brake_test'].every(function(id){return Array.isArray(h[id])&&h[id].length<=40&&h[id].every(function(r){return validRecord(r,id);});})
        &&(h.dyno===undefined||Array.isArray(h.dyno)&&h.dyno.length<=40&&h.dyno.every(function(r){return validRecord(r,'dyno');}))&&(h.baseline===undefined||h.baseline===null||validRecord(h.baseline,'dyno'));}
    function emptyHistory(){return {schema:1,draggy:[],brake_test:[],dyno:[],baseline:null};}
    // Adapted from brake_test/main.js. Only integrates fresh speed sample intervals.
    function Brake(trigger,onDone){this.trigger=trigger;this.onDone=onDone;this.reset();}
    Brake.prototype.reset=function(){this.state='arm';this.prev=null;this.run=null;this.last=null;this.message='';};
    Brake.prototype.invalidate=function(reason){if(this.run||this.state==='ready')this.message=reason||'Сигнал потерян — замер отменён';this.run=null;this.prev=null;this.state='arm';};
    Brake.prototype.feed=function(t,v,g){
        if(!finite(v)||v<0||v>400||!finite(g)||Math.abs(g)>3){this.invalidate();return;}
        var p=this.prev;if(p&&t<=p.t)return;
        if(p&&t-p.t>1000){this.invalidate('Пауза в данных — замер отменён');p=null;}
        var dt=p?(t-p.t)/1000:0,tests=[{key:'200-0',v:200},{key:'100-0',v:100}],self=this;
        function crossings(run,baseDist){
            tests.forEach(function(x){if(!run.cross[x.key]&&p.v>=x.v&&v<x.v){var f=(p.v-x.v)/(p.v-v);run.cross[x.key]={t:p.t+f*(t-p.t),d:baseDist+(p.v+x.v)/2/3.6*dt*f};}});
        }
        if(this.run){
            var run=this.run,base=run.dist;run.dist+=(p.v+v)/2/3.6*dt;run.peakG=Math.max(run.peakG,-g);crossings(run,base);
            run.trace.push([run.dist,v]);if(run.trace.length>1800)run.trace=run.trace.filter(function(_,i){return i%2===0;});
            if(-g<.1){if(run.released===null)run.released=t;}else run.released=null;
            if(v<.5){
                var result={};Object.keys(run.cross).forEach(function(k){var c=run.cross[k];result[k]={m:run.dist-c.d,s:(t-c.t)/1000};});
                var record={at:Date.now(),result:result,peakG:run.peakG,trace:run.trace.slice(),vStart:run.vStart};
                this.last=record;this.run=null;this.state='done';this.message='';this.onDone(record);
            }else if(t-run.t0>60000||run.released!==null&&t-run.released>1200)this.invalidate('Замер отменён: торможение прервано');
        }else{
            if(v>103)this.state='ready';
            if(this.state==='ready'&&p&&-g>=this.trigger){
                var hit=tests.filter(function(x){return p.v>=x.v&&v<x.v;})[0];
                if(hit){
                    // Integrate the whole sample interval, then subtract distance up
                    // to each crossing. Handles crossing both test speeds in one sample.
                    var total=(p.v+v)/2/3.6*dt, f=(p.v-hit.v)/(p.v-v);
                    var run={t0:p.t+f*(t-p.t),dist:total,cross:{},trace:[],peakG:-g,released:null,vStart:hit.v};
                    crossings(run,0);var offset=run.cross[hit.key].d;run.dist-=offset;
                    Object.keys(run.cross).forEach(function(k){run.cross[k].d-=offset;});
                    run.trace=[[0,hit.v],[run.dist,v]];this.run=run;this.last=null;this.state='braking';this.message='';
                }
            }
            if(this.state==='ready'&&v<97)this.state='arm';
            if(this.state==='done'&&v>5)this.state=v>103?'ready':'arm';
        }
        this.prev={t:t,v:v};
    };
    function Dynamics(options){
        options=options||{};this.prefs=options.prefs;this.units=options.units||function(){return 'kmh';};this.persist=options.persist||function(){};this.event=options.event||function(){};
        this.saved=validHistory(options.saved)?Object.assign(emptyHistory(),JSON.parse(JSON.stringify(options.saved))):emptyHistory();
        this.demo=emptyHistory();this.mode=null;this.sourceName='offline';
        this.saveError=options.saved!==undefined&&!validHistory(options.saved)?'История не распознана — прежние данные не загружены':'';this.reset();
    }
    Dynamics.prototype.reset=function(id){
        var self=this;
        if(!id||id==='draggy'){
            var unit=this.units()==='mph'?'mph':'kmh';
            this.dragMessage='';this.dragUnit=unit;this.drag=new Timer.RunTimer(splitsFor(unit,this.prefs.draggy.distance),{rollout:this.prefs.draggy.rollout,onDone:function(r){r.trace=self.drag.trace.slice();r.unit=unit;self.complete('draggy',r);}});
        }
        if(!id||id==='brake_test')this.brake=new Brake(this.prefs.brake_test.trigger,function(r){self.complete('brake_test',r);});
        if(!id||id==='dyno')this.dyno=new Dyno.Dyno(this.prefs.dyno,function(r){self.complete('dyno',r);});
        this.lastSpeed=null;this.lastClock=null;
    };
    Dynamics.prototype.source=function(feed){var key=feed.mode+':'+feed.revision;if(key!==this.mode){this.mode=key;this.sourceName=feed.mode;this.demo=emptyHistory();this.reset();}};
    Dynamics.prototype.complete=function(id,r){
        r.source=this.sourceName;
        var archive=this.sourceName==='demo'?this.demo:this.saved;
        if(this.sourceName!=='demo'&&this.sourceName!=='vehicle')return;
        archive[id].unshift(r);archive[id]=archive[id].slice(0,40);
        if(this.sourceName==='vehicle'){
            try{if(!validHistory(this.saved))throw Error('invalid history');this.persist(JSON.parse(JSON.stringify(this.saved)));this.saveError='';}
            catch(e){this.saveError='Результат в памяти: не удалось сохранить историю';}
        }
        this.event({kind:id,source:this.sourceName,title:({draggy:'Разгон',brake_test:'Торможение',dyno:'Расчётная мощность'}[id])+' · замер завершён',detail:JSON.parse(JSON.stringify(r))});
    };
    Dynamics.prototype.pin=function(index){var archive=this.sourceName==='demo'?this.demo:this.saved,run=archive.dyno[index];if(!run)return false;
        archive.baseline=JSON.parse(JSON.stringify(run));
        if(this.sourceName!=='demo'){try{this.persist(JSON.parse(JSON.stringify(this.saved)));this.saveError='';}catch(e){this.saveError='Эталон в памяти: не удалось сохранить';}}
        return true;};
    Dynamics.prototype.invalidate=function(reason){if(this.drag.state==='run')this.dragMessage=reason;this.drag.invalidate();this.brake.invalidate(reason);this.dyno.invalidate(reason);this.lastSpeed=null;};
    Dynamics.prototype.update=function(feed,now){
        this.source(feed);
        if(!finite(now)||this.lastClock!==null&&now<this.lastClock)return;
        this.lastClock=now;
        var speed=feed.read('speed'),accel=feed.read('gLong');
        var fresh=feed.mode!=='offline'&&finite(speed.value)&&speed.value>=0&&speed.value<=400&&now-speed.at>=0&&now-speed.at<=1000;
        if(!fresh){this.invalidate('Скорость недоступна — замер отменён');return;}
        var g=finite(accel.value)&&Math.abs(accel.value)<=3&&Math.abs(speed.at-accel.at)<=500&&now-accel.at<=1000?accel.value:null;
        var rpm=feed.read('rpm'),torque=feed.read('torque'),r=finite(rpm.value)&&Math.abs(speed.at-rpm.at)<=500&&now-rpm.at<=1000?rpm.value:null;
        if(g===null)this.brake.invalidate('Ускорение недоступно — замер отменён');
        if(g===null||r===null)this.dyno.invalidate('Данные недоступны — заезд отменён');
        if(this.lastSpeed===null||speed.at>this.lastSpeed){
            if(this.lastSpeed!==null&&speed.at-this.lastSpeed>1000)this.invalidate('Пауза в скорости — замер отменён');
            this.lastSpeed=speed.at;this.drag.feed(speed.at,speed.value);this.brake.feed(speed.at,speed.value,g);
            this.dyno.feed(speed.at,{rpm:r,speed:speed.value,gLong:g,torque:now-torque.at<=1000?torque.value:null});
            if(this.drag.state==='run')this.dragMessage='';
        }
        // Existing timer advances standstill only while the actual source remains fresh.
        this.drag.idle(now);
    };
    Dynamics.prototype.view=function(feed){
        this.source(feed);var archive=feed.mode==='demo'?this.demo:this.saved;
        return {drag:this.drag,dragMessage:this.dragMessage,brake:this.brake,dyno:this.dyno,runs:archive,saveError:this.saveError};
    };
    return {Dynamics:Dynamics,Brake:Brake,validHistory:validHistory,emptyHistory:emptyHistory,splitsFor:splitsFor,MPH:MPH};
}));
