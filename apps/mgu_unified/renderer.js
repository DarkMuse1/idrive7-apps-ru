(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./core'), require('./color'), require('./cabin'), require('./i18n'));
    else root.MguRenderer = factory(root.MguCore, root.MguColor, root.MguCabin, root.MguI18n);
}(this, function (Core, Color, Cabin, I18n) {
    'use strict';
    var C = { bg: '#191916', panel: '#30291f', line: '#44433b', text: '#f3ecdc', dim: '#b8b5a9', muted: '#827f74', amber: '#efa93e', red: '#dc6754' };
    function render(cv, app) {
        var actions = [], r = app.route, feed = app.feed, live = app.telemetry.view(feed), dynamics=app.dynamics.view(feed);
        I18n.setLanguage(app.settings.language);
        function number(v, digits) { return v === null || v === undefined ? '—' : I18n.decimal(v.toFixed(digits || 0)); }
        // Every drawn string passes the dictionary here (TZ 7.4: dictionaries apart from the logic).
        function text(s, x, y, size, color, align, number) {
            var value=I18n.glyphSafe(I18n.tr(String(s)),number),numeric=number&&/^[0-9.,:+%°/ —–-]+$/.test(value);
            cv.text(value,x,y,size||24,color||C.text,{align:align||'left',font:numeric&&size>=30?'display':number?'bold':'label'});
        }
        function rule(x, y, x2, y2) { cv.line(x, y, x2, y2, 1, C.line); }
        function outline(x,y,w,h,color) { cv.polyline([[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]],1,color||C.line); }
        function icon(name,x,y,size,color) {
            color=color||C.dim;size=size||30;
            function p(points){cv.polyline(points.map(function(v){return [x+v[0]*size/32,y+v[1]*size/32];}),1.6,color);}
            function ring(cx,cy,r){var pts=[];for(var i=0;i<=32;i++){var a=i*Math.PI/16;pts.push([cx+Math.cos(a)*r,cy+Math.sin(a)*r]);}p(pts);}
            if(name==='overview'||name==='redline'||name==='rpm'||name==='dyno'){p([[3,27],[3,18],[8,18],[8,27]]);p([[13,27],[13,11],[18,11],[18,27]]);p([[23,27],[23,4],[28,4],[28,27]]);}
            else if(name==='modules'){[[3,3],[19,3],[3,19],[19,19]].forEach(function(q){p([[q[0],q[1]],[q[0]+10,q[1]],[q[0]+10,q[1]+10],[q[0],q[1]+10],[q[0],q[1]]]);});}
            else if(name==='history'||name==='draggy'){ring(16,17,12);p([[16,8],[16,17],[23,21]]);}
            else if(name==='settings'||name==='service'||name==='transmission'||name==='gear'||name==='torque'){var pts=[];for(var i=0;i<=48;i++){var a=i*Math.PI/24,r=Math.floor(i/3)%2?11:15;pts.push([16+Math.cos(a)*r,16+Math.sin(a)*r]);}p(pts);ring(16,16,5);}
            else if(name==='oil'){p([[3,12],[9,12],[11,18],[23,18],[29,10],[22,12],[15,12],[15,8],[8,8],[8,12]]);p([[11,8],[11,4],[16,4]]);p([[4,12],[1,8],[4,6],[8,10]]);p([[28,20],[26,24],[29,25],[30,23],[28,20]]);}
            else if(name==='warmup'||name==='coolant'||name==='ambient'){p([[13,3],[13,21],[9,25],[10,29],[18,29],[20,25],[16,21],[16,3],[13,3]]);p([[18,7],[23,7]]);p([[18,12],[23,12]]);p([[1,18],[4,20],[7,18]]);}
            else if(name==='battery'||name==='voltage'||name==='edrive'){p([[3,8],[29,8],[29,27],[3,27],[3,8]]);p([[6,8],[6,4],[11,4],[11,8]]);p([[21,8],[21,4],[26,4],[26,8]]);p([[7,17],[13,17]]);p([[10,14],[10,20]]);p([[20,17],[25,17]]);}
            else if(name==='turbo'||name==='boost'){ring(15,17,11);ring(15,17,5);p([[17,6],[29,6],[29,12],[23,12]]);p([[5,26],[5,31],[14,31]]);}
            else if(name==='ambient_light'){ring(16,12,7);p([[12,18],[12,24],[20,24],[20,18]]);p([[13,28],[19,28]]);[[16,0,16,3],[1,12,5,12],[27,12,31,12],[3,2,6,5],[26,5,29,2]].forEach(function(q){p([[q[0],q[1]],[q[2],q[3]]]);});}
            else if(name==='car_vitals'||name==='dtc_scanner'){p([[2,11],[6,11],[6,7],[23,7],[23,11],[29,11],[29,24],[23,24],[20,28],[9,28],[6,24],[2,24],[2,11]]);p([[10,3],[19,3]]);p([[15,3],[15,7]]);}
            else if(name==='gforce'){ring(16,16,11);p([[16,0],[16,32]]);p([[0,16],[32,16]]);}
            else if(name==='brake_test'){ring(16,16,10);ring(16,16,3);p([[3,7],[1,16],[3,25]]);p([[29,7],[31,16],[29,25]]);}
            else if(name==='doom'){p([[3,9],[10,5],[22,5],[29,9],[31,25],[25,27],[20,21],[12,21],[7,27],[1,25],[3,9]]);p([[7,12],[7,19]]);p([[4,15],[11,15]]);ring(24,13,1);ring(20,17,1);}
            else {ring(16,16,11);p([[16,22],[16,15]]);p([[16,8],[16,10]]);}
        }
        function button(id, label, x, y, w, h, run, active, disabled) {
            actions.push({ id: id, label: I18n.tr(label), x: x, y: y, w: w, h: h, run: run, disabled: !!disabled });
            var nav=id.indexOf('nav-')===0,tab=id.indexOf('tab-')===0,primary=!disabled&&['scan','start-game'].indexOf(id)>=0;
            if(primary)cv.fillRect(x,y,w,h,C.amber);else if(active)cv.fillRect(x,y,w,h,C.panel);
            else if(label && !nav && !tab)outline(x+1,y+1,w-2,h-2,disabled?'#34332e':C.line);
            if(nav){icon(id.slice(4),x+w/2-76,y+13,29,active?C.amber:C.dim);text(label,x+w/2-27,y+h/2+8,23,active?C.amber:C.text);}
            else text(label,x+18,y+h/2+8,24,disabled?C.muted:primary?C.bg:active?C.amber:C.text);
            if (active) cv.fillRect(x + 16, y + h - 4, w - 32, 3, C.amber);
        }
        // A list's page button (the one just drawn): a finger dragged on the page turns the same pages (App.scroll).
        function paged(page, pages, set) { actions[actions.length - 1].pager = { page: page, pages: pages, set: set }; }
        function metric(key, digits) {
            var v = feed.read(key).value;
            return v === null ? '—' : I18n.decimal(v.toFixed(digits || 0));
        }
        function speed(rate) { var v = app.hold('speed', feed.read('speed').value, rate || app.settings.modules.redline.speedRate); return v === null ? '—' : String(Math.round(v / (app.settings.units === 'mph' ? 1.609344 : 1))); }
        function row(label, value, unit, x, y, w) {
            text(label, x, y, 23, C.dim); text(value + (unit ? ' ' + unit : ''), x + w, y + 1, 35, C.text, 'right', true); rule(x, y + 20, x + w, y + 20);
        }
        function hint(s) { text(s, 36, 429, 20, C.dim); }
        // «Тип двигателя» in words: the profile in use and where it comes from
        function engineWord(type) { return type === 'diesel' ? 'дизель' : 'бензин'; }
        function engineNote() {
            var p = engineWord(app.engineProfile());
            return app.settings.engine !== 'auto' ? p + ', выбран вручную' : app.engineType ? p + ', по данным автомобиля' : p + ', тип ещё не получен';
        }
        function noData(x, y, subtitle) { text('Нет данных', x, y, 45, C.dim); text(subtitle || 'Источник ещё не подключён', x, y + 37, 22, C.muted); }
        function demoValue(value) { return feed.mode === 'demo' ? value : '—'; }
        function trace(x, y, w, h, points, max) {
            for (var i = 0; i < 5; i++) { rule(x, y + h * i / 4, x + w, y + h * i / 4); }
            if (feed.mode !== 'demo') { text('График появится после измерения', x + w / 2, y + h / 2, 23, C.dim, 'center'); return; }
            cv.polyline(points.map(function (v, j) { return [x + w * j / (points.length - 1), y + h - v / max * h]; }), 3, C.amber);
            text('ДЕМОНСТРАЦИОННЫЙ ГРАФИК', x, y + h + 28, 18, C.muted);
        }
        function measuredTrace(points,x,y,w,h,xunit) {
            for(var grid=0;grid<5;grid++)rule(x,y+h*grid/4,x+w,y+h*grid/4);
            if(!points || points.length<2){text('График появится после начала замера',x+w/2,y+h/2,23,C.dim,'center');return;}
            var xmax=Math.max(1,points[points.length-1][0]),ymax=Math.max(100,Math.ceil(Math.max.apply(null,points.map(function(p){return p[1];}))/50)*50);
            var plotted=points.map(function(p){return [x+w*p[0]/xmax,y+h-h*p[1]/ymax];});
            for(var gi=0;gi<=4;gi++){var xx=x+w*gi/4;rule(xx,y,xx,y+h);text(number(ymax*(1-gi/4)),x-12,y+h*gi/4+6,17,C.dim,'right');}
            for(var pi=1;pi<plotted.length;pi++)cv.quad([plotted[pi-1],plotted[pi],[plotted[pi][0],y+h],[plotted[pi-1][0],y+h]],'#b885321c');
            cv.polyline(plotted,3,C.amber);var tip=plotted[plotted.length-1];cv.circle(tip[0],tip[1],4,C.amber);
            text('0',x,y+h+28,18,C.dim);text(number(xmax,1)+' '+xunit,x+w,y+h+28,18,C.dim,'right');text(ymax+' км/ч',x,y-14,19,C.dim);
        }
        function measurements(mod) {
            var braking=mod.id==='brake_test',dragUnit=app.settings.units==='mph'?'mph':'kmh',history=r.tab===(braking?2:3);
            // Draggy runs are kept per speed unit, as in apps/draggy (old records count as km/h).
            var runs=braking?dynamics.runs[mod.id]:dynamics.runs[mod.id].filter(function(run){return (run.unit||'kmh')===dragUnit;});
            var splitNames={'0-50':'0–50','0-100':'0–100','100-200':'100–200','0-200':'0–200','0-30mph':'0–30 mph','0-60mph':'0–60 mph','60-130mph':'60–130 mph','0-100mph':'0–100 mph',qm:'¼ мили',em:'⅛ мили',m1000:'1000 м'};
            var settings=app.settings.modules[mod.id],unit=braking?(settings.distUnit==='ft'?'фут':'м'):'с',factor=braking&&settings.distUnit==='ft'?3.28084:1;
            if(history){
                if(!runs.length)noData(44,236,'Завершённые замеры появятся здесь');
                runs.slice(0,4).forEach(function(run,i){var y=170+i*59,keys=Object.keys(run.result);
                    text(new Date(run.at).toLocaleDateString(I18n.locale()),44,y,23,C.dim);
                    var line=keys.map(function(k){return (splitNames[k]||k)+': '+number(braking?run.result[k].m*factor:run.result[k],braking?1:2)+(braking?' '+unit:'');}).join(' · ');
                    text(line.length>78?line.slice(0,77)+'…':line,290,y,braking?24:21);
                    text(run.source==='demo'?'DEMO':braking?'ЗАМЕР':run.rollout?'ROLLOUT':'БЕЗ ROLLOUT',1530,y,19,C.amber,'right');rule(44,y+18,1530,y+18);
                });
                hint(dynamics.saveError||'История: до 40 замеров · DEMO не записывается в историю автомобиля');return;
            }
            var distKey=app.settings.modules.draggy.distance;
            var key=braking?(r.tab?'200-0':'100-0'):(dragUnit==='mph'?['0-60mph','60-130mph',distKey]:['0-100','100-200',distKey])[r.tab];
            var timer=braking?dynamics.brake:dynamics.drag,last=runs[0],value=null,status,points=[];
            if(braking){
                if(timer.run&&timer.run.cross[key])value=timer.run.dist-timer.run.cross[key].d;
                else if(timer.last&&timer.last.result[key])value=timer.last.result[key].m;
                else if(!timer.run&&last&&last.result[key])value=last.result[key].m;
                points=timer.run?timer.run.trace:timer.last?timer.last.trace:last?last.trace:[];
                if(value!==null&&points.length){
                    var start=timer.run&&timer.run.cross[key]?timer.run.cross[key].d:points[points.length-1][0]-value;
                    points=[[0,r.tab?200:100]].concat(points.filter(function(p){return p[0]>start;}).map(function(p){return [(p[0]-start)*factor,p[1]];}));
                }
                status={arm:'Ожидание скорости выше порога',ready:'Готов к замеру',braking:'Измерение торможения',done:'Замер завершён'}[timer.state];
                if(feed.read('speed').value===null||feed.read('gLong').value===null)status='Нет данных для нового замера';
            }else{
                value=timer.result[key]===undefined?(!timer.state||timer.state!=='run')&&last&&last.rollout===settings.rollout&&last.result[key]!==undefined?last.result[key]:null:timer.result[key];
                points=timer.trace.length?timer.trace:last?last.trace:[];
                status={wait:'Ожидание остановки',ready:'Готов · старт автоматически',run:'Измерение разгона'}[timer.state];
                if(feed.read('speed').value===null)status='Скорость недоступна';
            }
            text(app.tabs(mod)[r.tab]+(braking||r.tab<2?(braking||dragUnit==='kmh'?' км/ч':' mph'):''),44,170,37,C.dim);
            if(!braking){
                var liveSpeed=app.hold('drag-speed',feed.read('speed').value,settings.speedRate);
                text('Скорость: '+(liveSpeed===null?'—':Math.round(liveSpeed/(dragUnit==='mph'?1.609344:1)))+(dragUnit==='mph'?' mph':' км/ч'),520,170,26,C.dim);
                if(r.tab===0){var extra=dragUnit==='mph'?['0-30mph','0-100mph']:['0-50','0-200'];
                    text(extra.map(function(k){var v=timer.result[k]!==undefined?timer.result[k]:timer.state!=='run'&&last&&last.rollout===settings.rollout&&last.result[k]!==undefined?last.result[k]:null;return splitNames[k]+': '+number(v,2)+' с';}).join(' · '),520,205,20,C.dim);}
            }
            text(value===null?'Ожидание результата':braking?timer.run?'Текущий замер':'Последний замер':timer.state==='run'?'Текущий заезд':'Последний замер',44,205,18,C.dim);
            text(number(value===null?null:value*factor,braking?1:2),36,313,145,C.text,'left',true);text(unit,550,311,36,C.dim);
            text(status,44,359,25);
            var comparable=runs.filter(function(run){return braking||run.rollout===settings.rollout;}).map(function(run){return run.result[key];}).filter(function(v){return v!==undefined;});
            var best=comparable.length?Math.min.apply(null,comparable.map(function(v){return braking?v.m:v;})):null;
            text('Лучший: '+number(best===null?null:best*factor,braking?1:2)+' '+unit+(braking?'':settings.rollout?' · rollout 1 ft':' · без rollout'),44,390,21,C.dim);
            measuredTrace(points,810,177,714,184,braking?unit:'с');
            var message=dynamics.saveError||(braking?timer.message:dynamics.dragMessage);
            hint(message||'Скорость из MGU · потеря сигнала отменяет текущий замер');
        }
        function dyno() {
            var prefs=app.settings.modules.dyno,runs=dynamics.runs.dyno,model=dynamics.dyno,base=dynamics.runs.baseline;
            var index=r.tab?Math.min(app.dynoSelection,Math.max(0,runs.length-1)):0,cur=runs[index];
            var units={hp:[745.7,'hp'],ps:[735.5,'PS'],kw:[1000,'кВт']}[prefs.powerUnit],tf=prefs.torqueUnit==='lbft'?.73756:1,tu=tf===1?'Н·м':'lb-ft';
            var rMax=live.limits.dyno.maxRpm;   // «Шкала оборотов», Авто = the engine profile (petrol 8000, diesel 6000)
            var x=65,y=175,w=955,h=155,all=(cur?cur.curve:[]).concat(r.tab&&base?base.curve:[]);
            var pmax=Math.max(150,Math.ceil(Math.max.apply(null,[0].concat(all.map(function(p){return p.p/units[0];})))/50)*50),tmax=Math.max(200,Math.ceil(Math.max.apply(null,[0].concat(all.map(function(p){return Math.max(p.t,prefs.ecuTorque&&typeof p.ecu==='number'&&isFinite(p.ecu)?p.ecu:0)*tf;})))/100)*100);
            for(var grid=0;grid<5;grid++)rule(x,y+h*grid/4,x+w,y+h*grid/4);
            text('Мощность · '+units[1],x,146,21,C.amber);text('Момент · '+tu,x+w,146,21,C.text,'right');
            function line(run,key,scale,max,color){if(!run)return;cv.polyline(run.curve.map(function(p){return [x+w*Math.max(0,Math.min(1,(p.rpm-1000)/(rMax-1000))),y+h-h*p[key]*scale/max];}),3,color);}
            if(r.tab&&base){line(base,'p',1/units[0],pmax,C.muted);line(base,'t',tf,tmax,C.dim);}
            line(cur,'p',1/units[0],pmax,C.amber);line(cur,'t',tf,tmax,C.text);
            // Original "ecuTorque": the ECU's own torque signal over the calculated curve (where present).
            if(prefs.ecuTorque&&cur&&cur.curve.some(function(p){return p.ecu!==null&&p.ecu!==undefined;})){var ecuPts=cur.curve.filter(function(p){return typeof p.ecu==='number'&&isFinite(p.ecu);});if(ecuPts.length>1)cv.polyline(ecuPts.map(function(p){return [x+w*Math.max(0,Math.min(1,(p.rpm-1000)/(rMax-1000))),y+h-h*Math.max(0,p.ecu)*tf/tmax];}),2,C.muted);text('Серая линия — момент ECU',x+w/2,146,19,C.muted,'center');}
            if(!cur)text('Кривая появится после завершённого заезда',x+w/2,y+h/2,25,C.dim,'center');
            text('1000',x,y+h+25,19,C.dim);text(rMax+' об/мин',x+w,y+h+25,19,C.dim,'right');
            rule(1052,136,1052,385);
            text('Мощность · оценка',1090,157,23,C.dim);
            text(number(model.state==='pull'&&!r.tab?model.power/units[0]:cur?cur.peakP/units[0]:null),1090,233,94,C.amber,'left',true);text(units[1],1508,232,27,C.dim,'right');
            rule(1090,249,1530,249);text('Момент · оценка',1090,279,23,C.dim);
            text(number(cur?cur.peakT*tf:null),1090,348,86,C.text,'left',true);text(tu,1508,346,27,C.dim,'right');
            var state={idle:'Ожидание заезда',pull:'Запись заезда',short:'Недостаточно данных заезда',cancelled:'Заезд отменён',done:'Расчёт завершён'}[model.state];
            text(state,1090,383,20,C.dim);
            if(r.tab){
                button('dyno-next',runs.length?'Заезд '+(index+1)+' / '+runs.length:'Нет заездов',44,353,345,44,function(){app.dynoSelection=(index+1)%runs.length;},false,!runs.length);
                button('dyno-pin','Сделать эталоном',405,353,350,44,function(){app.dynamics.pin(index);},false,!cur);
                if(base&&cur)text('К эталону: '+number((cur.peakP-base.peakP)/units[0],1)+' '+units[1],780,383,19,C.dim);
            }else text(prefs.weight+' кг · потери '+prefs.loss+' % · расчёт, не стенд',44,387,22,C.dim);
            hint(dynamics.saveError||model.reason||'Оценка по массе, ускорению и сопротивлению · уклон и ветер влияют на результат');
        }
        function tach(overview) {
            // the scale ends where the engine profile ends it (petrol 8000, diesel 6000; upstream Redline 1.9.0)
            var rpm=live.data.rpm,sp=live.shiftPoint,maxRpm=live.limits.scaleMax;
            var lp=app.settings.modules.redline,shiftNow=rpm!==null&&rpm>=sp.rpm,blinkOn=shiftNow&&lp.flash?(app.blink=!app.blink):false;
            var ledColor=function(segRpm){var f=(segRpm-(sp.rpm-2000))/2000;if(f<0||lp.lights==='mono')return C.amber;if(lp.lights==='f1')return f<.42?'#2fd27a':f<.84?C.red:'#2a7dff';return f<.42?'#2fd27a':f<.75?'#ffc21a':C.red;};
            var hot=shiftNow?(lp.flash?(blinkOn?(lp.lights==='f1'?'#2a7dff':C.red):'#713d32'):(lp.lights==='f1'?'#2a7dff':C.red)):null;
            var sy=overview?92:302,width=1512,n=84;
            for(var j=0;j<n;j++)cv.fillRect(44+width*j/n,sy+12,width/n-3,overview?19:31,rpm!==null&&j/n<rpm/maxRpm?(hot||ledColor(maxRpm*(j+.5)/n)):j/n>=sp.rpm/maxRpm?'#59332c':'#383832');
            for(var mark=0;mark<=Math.floor(maxRpm/1000);mark++){var mx=44+width*mark*1000/maxRpm;text(String(mark),mx,overview?84:367,19,C.dim,'center',true);}
            if(live.redline.peak!==null){var px=44+width*Math.min(1,live.redline.peak/maxRpm);cv.line(px,sy+9,px,sy+45,2,C.text);}   // a peak past the scale stays at its end
            if(overview){
                text(metric('rpm'),37,318,216,C.text,'left',true);text('ОБОРОТЫ / МИН',44,353,21,C.dim);
                rule(513,147,513,361);text(metric('gear'),621,318,204,C.text,'center',true);text('ПЕРЕДАЧА',621,353,21,C.dim,'center');rule(729,147,729,361);
                [['oil','Масло','oil','°C'],['coolant','ОЖ','coolant','°C'],['boost','Наддув','turbo','bar']].forEach(function(q,i){var y=179+i*76;icon(q[2],767,y-17,37);text(q[1],822,y+8,23,C.dim);text(metric(q[0],q[0]==='boost'?1:0)+(q[3]==='°C'?'°':' bar'),1128,y+15,49,C.text,'right',true);if(i<2)rule(767,y+35,1158,y+35);});
                rule(1191,147,1191,361);text(speed(),1379,249,120,C.text,'center',true);text(app.settings.units==='mph'?'mph':'км/ч',1379,280,22,C.dim,'center');
                icon('battery',1225,311,31);text('12 V',1272,336,21,C.dim);text(metric('voltage',1)+' V',1543,340,38,C.text,'right',true);
                rule(40,381,1560,381);button('open-overview','Открыть тахометр',40,393,385,48,function(){app.go('module','redline');});
                button('overview-metrics','Настроить показатели',448,393,385,48,function(){app.go('settings');});
                icon('history',1090,403,27);text('Последние заезды',1135,429,22,C.dim);button('overview-history','История',1350,393,210,48,function(){app.go('history');});
            }else{
                text('Обороты двигателя',44,148,23,C.dim);text(metric('rpm'),36,279,178,C.text,'left',true);text('об/мин',537,279,30,C.dim);
                rule(783,135,783,281);text('Передача',908,148,23,C.dim,'center');text(metric('gear'),908,280,171,C.text,'center',true);
                rule(1053,135,1053,281);text('Скорость',1205,148,23,C.dim);text(speed(),1200,278,137,C.text,'left',true);text(app.settings.units==='mph'?'mph':'км/ч',1493,278,23,C.dim);
                rule(40,383,1560,383);icon('oil',46,399,34);text('Масло',97,420,22,C.dim);text(metric('oil')+'°',293,432,49,C.text,'right',true);
                icon('coolant',355,399,33);text('ОЖ',404,420,22,C.dim);text(metric('coolant')+'°',581,432,49,C.text,'right',true);
                text('Ориентир '+sp.rpm+' об/мин'+(sp.oilUnknown?' · масло неизвестно':sp.cold?' · холодное масло':''),620,421,20,C.amber);
                if(blinkOn)cv.fillRect(40,382,1520,3,C.red);
            }
        }
        function ev() {
            var soc = feed.read('soc').value,energy=app.energy.view(feed);
            cv.fillRect(44, 133, 454, 49, C.line); cv.fillRect(48, 137, 446, 41, C.bg);
            for(var segment=0;segment<14;segment++)cv.fillRect(49+segment*31.7,138,28.7,39,soc!==null&&segment<14*Math.max(0,Math.min(100,soc))/100?C.amber:'#34342d');
            cv.fillRect(499, 148, 7, 20, C.dim);
            var ep=app.settings.modules.edrive,emi=ep.distUnit==='mi';
            text(metric('soc') + ' %', 40, 296, 110, C.amber, 'left', true); text(number(energy.range&&energy.range.mid/(emi?1.609344:1)) + (emi?' mi':' км'), 44, 364, 55, C.text, 'left', true);
            text(energy.range?(energy.range.learned?'Запас хода · по поездкам':'Запас хода · типовая кривая')+' · ДВС с '+energy.reserve+' %':energy.rangeReason,44,397,23,C.dim); rule(552, 128, 552, 400);
            text('МОЩНОСТЬ HV',770,157,22,C.dim,'center');text(metric('hvPower'),770,259,111,C.text,'center',true);text('кВт',770,294,24,C.dim,'center');
            icon('battery',741,320,57,C.dim);rule(638,350,715,350);rule(824,350,901,350);
            var bt=feed.read('batteryTemp').value;
            rule(992, 128, 992, 400); row('Батарея', number(bt===null?null:ep.tempUnit==='f'?bt*9/5+32:bt), ep.tempUnit==='f'?'°F':'°C', 1030, 160, 518);
            row('Ячейки', metric('cellMin', 2) + ' – ' + metric('cellMax', 2), 'V', 1030, 229, 518);
            row('SOH', metric('soh',1), '%', 1030, 298, 518); row('Бортовая сеть', metric('voltage', 1), 'V', 1030, 367, 518);
        }
        function lighting() {
            var draft = app.lighting, wheel = Color.wheel, selected = Color.hex(draft.hue, draft.saturation, 1);
            // The cabin preview first: on mgu-render/1 the kit (renderd.js nativeOps) rewrites a pixel image's op
            // only up to the first QUAD of the frame, so an image drawn after the wheel's quads would not show there.
            var cabin = Cabin.render(Color.rgb(draft.hue, draft.saturation, 1), draft.brightness);
            cv.drawImage(cabin.data, cabin.w, cabin.h, 428, 128, 672, 292);
            // Screen-space HSV, deliberately not an encoding for the car's hue fields.
            for (var ring = 0; ring < 16; ring++) {
                for (var sector = 0; sector < 48; sector++) {
                    var a = (sector * 7.5 + 0.15) * Math.PI / 180, b = ((sector + 1) * 7.5 - 0.15) * Math.PI / 180;
                    var inner = wheel.radius * ring / 16 + 0.25, outer = wheel.radius * (ring + 1) / 16 - 0.25;
                    cv.quad([[wheel.x + Math.cos(a) * inner, wheel.y + Math.sin(a) * inner],
                        [wheel.x + Math.cos(a) * outer, wheel.y + Math.sin(a) * outer],
                        [wheel.x + Math.cos(b) * outer, wheel.y + Math.sin(b) * outer],
                        [wheel.x + Math.cos(b) * inner, wheel.y + Math.sin(b) * inner]],
                    Color.hex(330 - (sector + 0.5) * 7.5, (ring + 0.5) / 16, 1));
                }
            }
            cv.circle(wheel.x, wheel.y, 5, '#FFFFFF');
            var cursor = Color.point(draft.hue, draft.saturation);
            cv.circle(cursor.x, cursor.y, 10, '#151515'); cv.circle(cursor.x, cursor.y, 8, '#FFFFFF'); cv.circle(cursor.x, cursor.y, 5, selected);
            actions.push({ id: 'color-wheel', label: 'Цветовой круг', kind: 'wheel',
                x: wheel.x - wheel.radius - 13, y: wheel.y - wheel.radius - 13, w: wheel.radius * 2 + 26, h: wheel.radius * 2 + 26,
                point: function (x, y) { app.colorPoint(x, y); },
                run: function () { draft.edit = draft.edit === 'hue' ? 'saturation' : draft.edit === 'saturation' ? null : 'hue'; } });
            text('Предпросмотр салона', 450, 151, 20, C.dim);
            rule(1118, 126, 1118, 425);
            Color.presets.forEach(function (preset, i) {
                var x = 1138 + i * 69, color = Color.hex(preset.hue, preset.saturation, 1);
                cv.fillRect(x + 9, 247, 48, 17, color);
                actions.push({ id: 'light-preset-' + i, label: preset.name, x: x, y: 238, w: 66, h: 34,
                    run: function () { draft.edit = null; app.selectColor(preset.hue, preset.saturation); } });
            });
            text('Яркость предпросмотра', 1140, 292, 21, C.dim); text(Math.round(draft.brightness) + ' %', 1555, 292, 23, C.text, 'right');
            cv.line(1150, 319, 1546, 319, 5, C.line); cv.line(1150, 319, 1150 + 396 * draft.brightness / 100, 319, 5, selected);
            cv.circle(1150 + 396 * draft.brightness / 100, 319, 8, C.text);
            actions.push({ id: 'light-brightness', label: 'Яркость предпросмотра', kind: 'slider', x: 1138, y: 301, w: 420, h: 36,
                point: function (x) { draft.edit = null; draft.brightness = Color.clamp((x - 1150) / 396 * 100, 0, 100); },
                run: function () { draft.edit = draft.edit === 'brightness' ? null : 'brightness'; } });
            text('Выбранный цвет', 1140, 151, 25, C.dim); cv.fillRect(1140, 174, 72, 64, selected);
            text(selected, 1234, 216, 37, C.text, 'left', true);
            text('Цвет в автомобиле', 1140, 357, 20, C.dim); text('Не подтверждён', 1140, 383, 24);
            button('light-apply', 'Применить в салоне', 1122, 390, 429, 37, function () {}, false, true);
            text(draft.edit === 'hue' ? 'Поворот: оттенок · Нажатие: насыщенность' : draft.edit === 'saturation' ? 'Поворот: насыщенность · Нажатие: готово' : draft.edit === 'brightness' ? 'Поворот: яркость · Нажатие: готово' : 'Выбор меняет предпросмотр. Применение к автомобилю пока недоступно.', 460, 439, 19, C.dim);
        }
        cv.clear(C.bg);
        ['#20201b','#1e1e19','#1c1c18','#1b1b17'].forEach(function(col,i){cv.fillRect(0,54+i*99,1600,99,col);});
        text('M G U  T O O L S', 34, 37, 26); rule(251, 14, 251, 42);
        var stale = Object.keys(feed.values).some(function (key) { return feed.values[key].quality === 'stale'; });
        text(feed.mode === 'demo' ? 'DEMO · СИМУЛЯЦИЯ' : stale ? 'УСТАРЕВШИЕ ДАННЫЕ СКРЫТЫ' : feed.mode === 'vehicle' ? 'ИСТОЧНИК HU' : 'НЕТ ПОДКЛЮЧЕНИЯ', 1558, 36, 22, feed.mode === 'demo' ? C.amber : C.dim, 'right');
        rule(32, 54, 1568, 54);
        var mod = r.page === 'module' ? Core.moduleById(r.id) : null;
        if (mod || r.page === 'group' || r.page === 'apps' || r.page === 'settings' && r.id) {
            button('back', '', 24, 60, 61, 47, function () { app.back(); });
            actions[actions.length-1].label='Назад';
            // Draw the arrow: the HU bitmap font does not contain the ‹ glyph.
            cv.line(59,74,48,83,2,C.text);cv.line(48,83,59,92,2,C.text);
            text(mod ? Core.groups[mod.group] + ' / ' + mod.title : r.page === 'settings' ? 'Настройки / '+Core.moduleById(r.id).title : r.page === 'apps' ? 'Настройки / Приложения' : Core.groups[r.id], 100, 92, 26);
            if (mod) app.tabs(mod).forEach(function (tab, i, list) {
                var w = Math.min(220, 1000 / list.length), x = 1568 - w * (list.length - i);
                button('tab-' + i, tab, x, 60, w, 47, function () { app.clearFaults.cancel();app.cbsReset.cancel();app.lighting.edit = null;app.diagnostics.detail=null;app.route.tab = i; }, r.tab === i);
            });
        }
        if (r.page === 'overview') {
            if (app.settings.overview === 'edrive') { ev(); button('open-overview', 'Открыть eDrive', 1040, 395, 320, 47, function () { app.go('module', 'edrive'); }); }
            else tach(true);
        } else if (r.page === 'modules') {
            text('Все возможности. Один экран.', 40, 111, 36); text('Двигатель, динамика и автомобиль', 40, 148, 22, C.dim);
            Core.groups.forEach(function (g, i) {
                var x = 36 + i * 308;
                icon(['car_vitals','redline','edrive','service','doom'][i],x+20,179,46,C.amber);
                button('group-' + i, g, x, 234, 284, 66, function () { app.go('group', i); });
                var list = app.visibleModules().filter(function (m) { return m.group === i; });
                if (!list.length) text('Все удалены', x + 18, 335, 20, C.muted);
                list.forEach(function (m, j) { text(m.title, x + 18, 335 + j * 27, 20, C.dim); });
                if (i < 4) rule(x + 293, 181, x + 293, 419);
            });
        } else if (r.page === 'group') {
            var groupList = app.visibleModules().filter(function (m) { return m.group === r.id; });
            if (!groupList.length) text('Все приложения этого раздела удалены · вернуть можно в Настройки / Приложения', 36, 236, 26, C.dim);
            groupList.forEach(function (m, i) {
                var x = 36 + i * 385;
                icon(m.id,x+20,153,47,C.amber);
                button('module-' + m.id, m.title, x, 216, 350, 82, function () { app.go('module', m.id); });
                text(m.tabs[0], x + 20, 341, 23, C.dim); if (i < 3) rule(x + 365, 147, x + 365, 391);
            });
        } else if (r.page === 'settings' && Core.moduleSettings[r.id]) {
            var fields=Core.moduleSettings[r.id],fieldPages=Math.max(1,Math.ceil(fields.length/6));app.settingsPage=Math.min(app.settingsPage,fieldPages-1);
            var LS=live.limits,autoRpm={redline:{redline:LS.redline.redline,coldLimit:LS.redline.coldLimit},warmup:{redline:LS.warmup.redline,coldLimit:LS.warmup.coldLimit},
                dyno:{maxRpm:LS.dyno.maxRpm},car_vitals:{redline:LS.car_vitals.redline}};
            if(fieldPages>1){button('settings-page','Стр. '+(app.settingsPage+1)+' / '+fieldPages+' · Далее',1240,399,320,48,function(){app.settingsPage=(app.settingsPage+1)%fieldPages;});
                paged(app.settingsPage,fieldPages,function(i){app.settingsPage=i;});}
            fields.slice(app.settingsPage*6,app.settingsPage*6+6).forEach(function(field,i){
                var x=36+(i%3)*516,y=151+Math.floor(i/3)*133,value=app.settings.modules[r.id][field[0]];
                var names=r.id==='redline'&&field[0]==='lights'?{m:'M · зелёный–жёлтый–красный',f1:'F1 · зелёный–красный–синий',mono:'Один цвет'}:{coupe:'Купе / седан',wagon:'Универсал / хэтчбек',suv:'SUV',m:'Метры',ft:'Футы',nm:'Н·м',lbft:'lb-ft',kgm:'кгс·м',kw:'кВт',qm:'¼ мили · 402 м',em:'⅛ мили · 201 м',m1000:'1000 м',yes:'Есть',no:'Нет',km:'км',mi:'мили',auto:'Авто',on:'Всегда',off:'Скрыть',engine:'Двигатель',thermal:'Температуры',fuel:'Топливо',chassis:'Шасси',C:'°C',F:'°F',bar:'bar',psi:'psi',hp:'hp',ps:'PS',sport:'Спорт-индикатор',calc:'Расчёт M×n',fes:'FES',dme:'DME'};
                var label=typeof value==='boolean'?(value?'Включено':'Выключено'):field[0]==='tempUnit'?(value==='f'?'°F':'°C'):(names[value]||(typeof value==='number'?I18n.decimal(String(value)):value))+' '+field[4];
                // 0 = Авто of the rpm settings: the value the engine profile gives now; the boost gauge in both units
                var resolved=autoRpm[r.id]&&autoRpm[r.id][field[0]];
                if(value===0&&resolved!==undefined)label='Авто · '+resolved+' об/мин';
                if(field[0]==='boostMax'){var bm=Core.Vitals.BOOST_MAX[value]||Core.Vitals.BOOST_MAX['2.5'];label=I18n.decimal(bm[0].toFixed(1))+' bar / '+bm[1]+' psi';}
                text(field[1],x+17,y,22,C.dim);
                button('module-setting-'+field[0],label,x,y+13,490,67,function(){app.moduleSetting(r.id,field[0]);});
            });
            hint(r.id==='service'?'Включение разрешает только запрос сброса; каждый сброс подтверждается отдельно':autoRpm[r.id]?'Авто — по типу двигателя: '+engineNote()+' · тип меняется в общих настройках':'Нажатие меняет значение · настройки расчёта, без изменения параметров автомобиля');
        } else if (r.page === 'settings') {
            text('Ваш экран', 36, 112, 40); text('Настройки общей оболочки', 36, 147, 24, C.dim);
            button('setting-overview', 'Обзор: ' + (app.settings.overview === 'edrive' ? 'eDrive' : 'Тахометр'), 36, 168, 347, 62, function () { app.setting('overview', app.settings.overview === 'edrive' ? 'redline' : 'edrive'); });
            button('setting-units', 'Скорость: ' + (app.settings.units === 'mph' ? 'мили / ч' : 'км / ч'), 399, 168, 347, 62, function () { app.setting('units', app.settings.units === 'mph' ? 'kmh' : 'mph'); });
            button('setting-language', app.settings.language === 'en' ? 'Язык: English' : 'Язык: Русский', 36, 238, 347, 62, function () { app.setting('language', app.settings.language === 'en' ? 'ru' : 'en'); });
            button('setting-apps', 'Приложения' + (app.settings.hidden.length ? ' · скрыто ' + app.settings.hidden.length : ''), 399, 238, 347, 62, function () { app.go('apps'); });
            // «Тип двигателя»: the apps' own "engine" setting (M Vitals, Redline, Dyno, Warm-Up), one for the whole car
            var eng = app.settings.engine, L0 = live.limits;
            button('setting-engine', 'Тип двигателя: ' + ({ auto: 'Авто', diesel: 'Дизель', petrol: 'Бензин' }[eng] || 'Авто'), 36, 308, 710, 62, function () { app.setting('engine', { auto: 'diesel', diesel: 'petrol', petrol: 'auto' }[eng] || 'auto'); });
            text((eng !== 'auto' ? 'Выбран вручную' : app.engineType ? 'По данным автомобиля: ' + engineWord(app.engineType) : 'Тип от автомобиля ещё не получен')
                + ' · шкала до ' + L0.scaleMax + ', Авто — ' + L0.autoRedline + ' об/мин'
                + (eng !== 'auto' && app.engineType && app.engineType !== eng ? ' · по автомобилю: ' + engineWord(app.engineType) : ''), 54, 400, 19, C.dim);
            rule(790, 164, 790, 390); text('Данные', 840, 206, 28);
            button('setting-demo', feed.mode === 'demo' ? 'Выключить DEMO' : 'Включить DEMO', 824, 240, 690, 74, function () { app.mode(feed.mode === 'demo' ? 'offline' : 'demo'); });
            text('Режим DEMO не включает управление автомобилем.', 842, 354, 22, C.dim);
            var lg=app.legacy;
            if(lg&&lg.state==='offered'){cv.fillRect(824,372,690,78,C.panel);text('Найдены настройки прежних приложений: '+lg.plan.changes.length+(lg.plan.records?' · рекорды G-Force':''),840,398,20,C.amber);
                button('legacy-apply','Импортировать',836,404,330,44,function(){app.legacyApply();});button('legacy-decline','Не импортировать',1176,404,330,44,function(){app.legacyDecline();});}
            else if(lg&&lg.message)text(lg.message,842,398,20,lg.state==='error'?C.amber:C.dim);
            var lic=app.license,licReason={malformed:'файл повреждён','unknown-key':'ключ издателя не настроен','bad-signature':'подпись неверна','not-yet-valid':'ещё не действует',expired:'срок истёк','binding-mismatch':'привязка не совпадает','clock-rollback':'часы переведены назад'};
            var licText=!lic||lic.state==='none'?'не настроена':lic.state==='ok'?'активна'+(lic.licensee?' · '+lic.licensee:''):(licReason[lic.reason]||lic.reason);
            if(!(lg&&lg.state==='offered'))text('Лицензия: '+licText+' · режим наблюдения',842,432,19,!lic||lic.state==='none'?C.muted:lic.state==='ok'?C.dim:C.amber);
            hint('Настройки тахометра, прогрева и G-Force доступны внутри этих модулей');
        } else if (r.page === 'apps') {
            text('Удалите ненужные разделы или верните их обратно', 36, 128, 22, C.dim);
            Core.modules.forEach(function (m, i) {
                var x = 36 + (i % 2) * 782, y = 145 + Math.floor(i / 2) * 35;
                var hidden = app.isHidden(m.id), armed = app.removeArmed(m.id);
                text(m.title, x, y + 23, 22, hidden ? C.muted : C.text);
                text(Core.groups[m.group], x + 250, y + 23, 19, C.dim);
                button('app-toggle-' + m.id, hidden ? 'Вернуть' : armed ? 'Да, удалить' : 'Удалить', x + 466, y, 300, 34,
                    function () { if (hidden) app.restoreModule(m.id); else app.removeModule(m.id); }, armed, false);
            });
            hint('Удаление убирает раздел из меню «Модули». Данные и настройки раздела сохраняются.');
        } else if (r.page === 'history') {
            button('history-ops',app.showOperations?'События запуска':'Журнал операций',1150,100,392,48,function(){app.toggleOperations();},app.showOperations);
            if(app.showOperations){
                var ops=app.operationsList||{items:[],error:''},opPages=Math.max(1,Math.ceil(ops.items.length/4));app.operationsPage=Math.min(app.operationsPage,opPages-1);
                text('Журнал операций', 36, 112, 40); text('Стирание DTC и сброс CBS · operations/ на HU', 36, 147, 23, C.dim);
                if(!ops.items.length)noData(44,267,ops.error||'Подтверждаемые операции ещё не выполнялись');
                ops.items.slice(app.operationsPage*4,app.operationsPage*4+4).forEach(function(o,i){var y=208+i*60;text(new Date(o.at).toLocaleString(I18n.locale()).slice(0,17),44,y,21,C.dim);text(o.title,300,y,24,o.open?C.amber:C.text);text(o.detail,1550,y,21,o.open?C.amber:C.dim,'right');rule(40,y+20,1550,y+20);});
                if(opPages>1){button('history-ops-page',(app.operationsPage+1)+' / '+opPages+' · Далее',1240,399,320,48,function(){app.operationsPage=(app.operationsPage+1)%opPages;});
                    paged(app.operationsPage,opPages,function(i){app.operationsPage=i;});}
                hint('Незавершённые операции выделены; приложение их не повторяет и не возобновляет');
            }else{
            text('История', 36, 112, 40); text('События текущего запуска', 36, 147, 23, C.dim);
            if (!app.history.length) noData(44, 267, 'Здесь будут заезды, результаты диагностики и журнал действий');
            app.history.slice(0, 4).forEach(function (h, i) { var y = 208 + i * 60; text(h.title, 44, y, 24); text(h.source.toUpperCase(), 1520, y, 22, C.amber, 'right'); rule(40, y + 20, 1550, y + 20); });
            }
        } else if (mod && ['live_data','live_adjustments','zf8hp'].indexOf(mod.id)>=0) {
            var descriptions={
                live_data:['Приборы, поездки и данные электронных блоков','Настраиваемые экраны · расход и поездки · датчики · чтение ECU'],
                live_adjustments:['Заслонка выпуска и настройки двигателя','OEM / открыть / закрыть · BM3 / MHD · экспериментальный xDrive'],
                zf8hp:['Данные автоматической коробки передач','Температуры · сцепления · переключения · карты · ошибки и сведения']
            },description=descriptions[mod.id];
            text(description[0],40,178,36);text(description[1],40,224,23,C.dim);
            text('Страницы и настройки встроены в MGU Tools. Отдельная установка не нужна.',40,270,23,C.dim);
            if(mod.id==='live_adjustments')text('Управление отключено по умолчанию. Условия и подтверждения исходного модуля сохранены.',40,316,22,C.amber);
            button('embedded-open','Открыть модуль',40,355,400,60,function(){app.openEmbedded(mod.id);},false,!app.embedded||app.embeddedBusy);
            hint(app.message||(!app.embedded?'Этот раздел запускается в приложении на головном устройстве':'Кнопка «В меню MGU Tools» возвращает в общую оболочку'));
        } else if (mod) {
            if (mod.id === 'redline' && !r.tab) tach(false);
            else if (mod.id === 'redline') {
                if(!live.redline.shifts.length) noData(44,235,'Переключения будут записаны при поступлении показаний');
                live.redline.shifts.slice(0,4).forEach(function(s,i){var y=169+i*59;
                    text(s.estimated?'Предположительно':s.from+' → '+s.to,44,y,25);
                    text(s.rpm+' об/мин',355,y,28,C.amber);text(s.verdict,665,y,24,C.dim);rule(44,y+20,1030,y+20);
                });
                row('Пик оборотов',number(live.redline.maxRpm),'',1090,180,430);
                row('Пик скорости',number(live.redline.maxSpeed===null?null:live.redline.maxSpeed/(app.settings.units==='mph'?1.609344:1)),app.settings.units==='mph'?'mph':'км/ч',1090,268,430);
                row('Входы в красную зону',String(live.redline.hits),'',1090,356,430);
                hint('Последние 60 переключений · текущая сессия · DEMO отделено от машины');
            }
            else if (mod.id === 'car_vitals') {
                if(r.tab===3&&app.showMisfires){
                    var misfires=app.misfireView();
                    if(!misfires.counts.length)text(misfires.reason||'Счётчики не прочитаны',44,220,32,C.dim);
                    misfires.counts.forEach(function(c,i){var x=44+(i%4)*390,y=157+Math.floor(i/4)*80;text('Цилиндр '+c.cylinder,x,y,22,C.dim);text(number(c.value),x,y+44,39,c.value>0?C.amber:C.text);});
                    button('vitals-misfires','Давление и зажигание',560,399,470,48,function(){app.showMisfires=false;});
                    text('Нет ответа — число пропусков неизвестно',44,431,22,C.dim);
                }else{
                var vp=app.settings.modules.car_vitals;
                if(r.tab===2){
                    var ty=Core.Vitals.tyres(feed,vp,app.vitals,feed.mode);
                    if(!ty.shown)text('Карточка шин скрыта в параметрах',44,240,30,C.dim);
                    else ty.wheels.forEach(function(wh,i){var x=44+(i%2)*790,y=157+Math.floor(i/2)*140;text(['Передняя левая','Передняя правая','Задняя левая','Задняя правая'][i],x,y,24,C.dim);
                        text(number(wh.press,ty.unit==='psi'?0:1)+' '+ty.unit,x,y+66,58,C.text,'left',true);
                        text((ty.temps?number(wh.temp)+' '+ty.tempUnit+' · ':'')+'цель '+number(wh.target,ty.unit==='psi'?0:1)+' '+ty.unit,x+310,y+62,22,C.dim);rule(x,y+91,x+701,y+91);});
                }else{
                    var cells=Core.Vitals.view(r.tab,feed,vp,app.vitals,feed.mode,live.limits),cw=1512/Math.max(1,cells.length);
                    if(!cells.length)text('Все показатели этой вкладки скрыты в параметрах',44,240,30,C.dim);
                    cells.forEach(function(c,i){var x=44+i*cw,v=c.value,unit=c.unit;
                        if(c.key==='speed'){v=app.hold('vitals-speed',v,vp.speedRate);if(v!==null&&app.settings.units==='mph')v=v/1.609344;unit=app.settings.units==='mph'?'mph':'км/ч';}
                        if(i)rule(x-20,137,x-20,379);
                        icon(c.key||'car_vitals',x,145,33,i===0?C.amber:C.dim);
                        var label=c.label.split(' · ');text(label[0],x,207,21,C.dim);
                        if(label[1])text(label[1],x,231,18,C.muted);
                        text(number(v,c.digits),x-3,312,cells.length>4?73:91,c.tone==='crit'?C.red:c.tone==='warn'||i===0?C.amber:C.text,'left',true);
                        text(unit,x,344,21,C.dim);
                        if(c.peak!==null&&c.peak!==undefined)text('пик '+number(c.peak,c.digits),x+cw-46,344,19,C.muted,'right');
                        cv.fillRect(x,366,cw-45,4,C.line);
                        // c.max: the fixed gauge of the original app (rpm: engine profile scale, torque, boost gauge max)
                        var max=c.max||(c.key==='gear'?8:c.key==='speed'?260:c.key==='voltage'?16:c.unit==='°F'?300:c.unit==='°C'?150:Math.max(100,Math.abs(v)*1.4));
                        if(v!==null)cv.fillRect(x,366,(cw-45)*Math.max(0,Math.min(1,v/max)),4,c.tone==='crit'?C.red:c.tone==='warn'||i===0?C.amber:C.dim);
                        // its red line / warning mark (rpm: the redline of the engine profile, boost: 85 % of the gauge)
                        if(c.mark)cv.fillRect(x+(cw-45)*Math.max(0,Math.min(1,c.mark/max))-1,361,2,14,c.markTone==='warn'?C.amber:C.red);
                    });
                }
                hint(app.vitalsReadError||(r.tab===4?'Момент LMV не подтверждает режим AWD/RWD; процент распределения не вычисляется':r.tab===2?'Давление, температура и целевые значения — из TPMS':'Отсутствующие и устаревшие сигналы скрываются; индикация требует проверки на машине'));
                if(r.tab===3){cv.fillRect(0,399,1600,50,C.bg);text('Чтение DME · неподдерживаемые значения скрыты',44,431,22,C.dim);if(Core.Vitals.shown(app.vitals,vp,'misfire',feed.mode))button('vitals-misfires','Счётчики пропусков',560,399,470,48,function(){app.showMisfires=true;});}
                }
            } else if (mod.id === 'warmup') {
                var w=live.warmup,p=app.settings.modules.warmup,fahr=p.tempUnit==='f',unit=fahr?'°F':'°C';
                var temp=function(v){return v===null?null:fahr?v*9/5+32:v;};
                var eta=function(e){return e.state==='ready'?'Прогрето':e.state==='off'?'Двигатель выключен':e.state==='stalled'?'Не прогревается':e.state==='warming'?'~ '+Math.min(99,Math.max(1,Math.ceil(e.minutes)))+' мин'+(e.typical?' · оценка':''):'Нет данных';};
                if(!r.tab){
                    var warming=w.oil.state==='warming',minutes=warming?Math.min(99,Math.max(1,Math.ceil(w.oil.minutes))):null;
                    text(warming?'Оценка до прогрева':'Прогрев',44,160,23,C.dim);
                    text(warming?String(minutes):w.oil.state==='ready'?'Прогрето':'—',35,301,w.oil.state==='ready'?70:166,C.text,'left',true);
                    text(warming?'мин':'',350,299,31,C.dim);
                    if(w.oil.state!=='ready')text(w.oil.typical?'Типовая оценка':eta(w.oil),44,348,25,C.dim);
                    rule(472,137,472,376);
                    var stops=[['Холодный',536],['Прогрев',757],['Прогрето',976]],step=w.oil.state==='ready'?2:warming?1:0;
                    cv.line(557,231,997,231,2,C.line);stops.forEach(function(q,i){cv.circle(q[1]+21,231,10,i===step?C.amber:C.line);cv.circle(q[1]+21,231,6,i===step?C.amber:C.bg);text(q[0],q[1]+21,279,22,i===step?C.amber:C.dim,'center');icon(i===0?'coolant':i===1?'warmup':'ambient',q[1]+5,308,33,i===step?C.amber:C.dim);});
                    rule(1087,137,1087,376);icon('oil',1122,149,34);text('Масло',1170,174,22,C.dim);text(number(temp(live.data.oil))+'°',1120,258,75,C.amber,'left',true);
                    icon('coolant',1360,149,34);text('ОЖ',1410,174,22,C.dim);text(number(temp(live.data.coolant))+'°',1360,258,75,C.text,'left',true);
                    text(unit,1122,291,21,C.dim);text(unit,1360,291,21,C.dim);
                    text('Ориентир оборотов: '+number(w.revLimit),44,391,23,C.dim);
                    var hist=w.history,end=hist.length?hist[hist.length-1][0]:0;
                    for(var hi=1;hi<hist.length;hi++){var a=hist[hi-1],b=hist[hi];if(a[1]!==null&&b[1]!==null&&b[0]-a[0]<=6000)cv.line(1122+425*(1-(end-a[0])/1200000),368-42*Math.max(0,Math.min(1,a[1]/150)),1122+425*(1-(end-b[0])/1200000),368-42*Math.max(0,Math.min(1,b[1]/150)),2,C.amber);}
                    rule(1122,369,1547,369);
                }else{
                    var status={disabled:'Оценка выключена',unknown:'Недостаточно данных',off:'Двигатель выключен',done:'Расчёт завершён',cooling:'Оценка охлаждения',idle:'Нагрузка не накоплена'};
                    text(status[w.cooling],44,178,35);text(w.cooling==='cooling'?String(w.seconds)+' с':'—',40,323,116,C.amber,'left',true);
                    text('Оценка по оборотам, моменту и времени',44,374,24,C.dim);
                    row('Обороты',metric('rpm'),'об/мин',880,192,640);row('Момент',metric('torque'),'Н·м',880,277,640);row('Масло',number(temp(live.data.oil)),unit,880,362,640);
                }
                hint('Расчётный ориентир, не заводской допуск · потеря сигнала приостанавливает расчёт');
            } else if (mod.id === 'gforce') {
                var cx = 400, cy = 275, radius = 145, gf=live.gforce, scale=app.settings.modules.gforce.scale,gx=gf.lat,gy=gf.long;
                cv.circle(cx, cy, radius, C.line); cv.circle(cx, cy, radius - 1, C.bg); cv.circle(cx, cy, radius / 2, C.line); cv.circle(cx, cy, radius / 2 - 1, C.bg);
                rule(cx - radius, cy, cx + radius, cy); rule(cx, cy - radius, cx, cy + radius);
                // «Торможение сверху» (apps/gforce 1.5.0 flipLong): the longitudinal axis the other way round - labels,
                // trail and dot; the values, peaks and records stay as they are
                var flipLong=app.settings.modules.gforce.flipLong===true,ySign=flipLong?1:-1;
                var pos=function(lat,lon){return [cx-Math.max(-1,Math.min(1,lat/scale))*radius,cy+ySign*Math.max(-1,Math.min(1,lon/scale))*radius];};
                // the axis labels sit left of the area any dot or trail can reach (each axis clamps at the ring,
                // so up to the square around it, plus the dot radius): no marker covers them, clear of the caption
                [[flipLong?'ТОРМОЗ':'РАЗГОН',cy-radius+27],[flipLong?'РАЗГОН':'ТОРМОЗ',cy+radius-15]].forEach(function(q){text(q[0],cx-radius-14,q[1],17,C.muted,'right');});
                gf.trail.forEach(function(p,i){if(i%2===0){var q=pos(p[1],p[2]);cv.circle(q[0],q[1],3,C.dim);}});
                if(gx!==null&&gy!==null){var dot=pos(gx,gy);cv.circle(dot[0],dot[1],8,C.amber);}
                // 1,5 g in RU as the other numbers; above the reach of the dot (the ring top minus its radius 8)
                text(I18n.decimal(String(scale))+' g',cx,119,21,C.dim,'center');
                var gRate=app.settings.modules.gforce.gRate;
                if(!r.tab){var longG=app.hold('glong',gy,gRate),latG=app.hold('glat',gx,gRate),combined=longG===null||latG===null?null:Math.sqrt(longG*longG+latG*latG);rule(745,137,745,386);text(number(combined,2),795,267,142,C.text,'left',true);text('g',1235,267,41,C.dim);text('Результирующее ускорение',801,303,24,C.dim);rule(800,321,1530,321);
                    [['Продольное',longG],['Поперечное',latG],['Выше 0,5 g',gf.over05]].forEach(function(q,i){var x=800+i*247;text(q[0],x,350,20,C.dim);text(number(q[1],i===2?1:2),x,391,43,C.text,'left',true);text(i===2?'с':'g',x+155,390,20,C.dim);});}
                else if(r.tab===1){[['Разгон / торможение','acc','brk'],['Влево / вправо','left','right']].forEach(function(p,i){row(p[0],number(gf.peak[p[1]],2)+' / '+number(gf.peak[p[2]],2),'g',800,184+i*84,716);});row('Суммарный максимум',number(gf.peak.combined,2),'g',800,352,716);}
                else{
                    var rec=app.telemetry.records[feed.mode==='demo'?'demo':'vehicle'],mphRec=app.settings.units==='mph';
                    var recDate=function(k){return rec[k]?new Date(rec[k].at).toLocaleDateString(I18n.locale()):'';};
                    [['Разгон','acc'],['Торможение','brk'],['Влево','left'],['Вправо','right'],['Суммарно','comb'],['Скорость','vmax']].forEach(function(p,i){
                        var x=800+(i%2)*380,y=160+Math.floor(i/2)*62,v=rec[p[1]]?rec[p[1]].v:null;
                        text(p[0]+(recDate(p[1])?' · '+recDate(p[1]):''),x,y,19,C.dim);
                        text(p[1]==='vmax'?number(v===null?null:v/(mphRec?1.609344:1))+(mphRec?' mph':' км/ч'):number(v,2)+' g',x,y+38,32,v===null?C.dim:C.text,'left',true);
                    });
                    var armed=app.recordsClear!==null&&app.now()-app.recordsClear<=5000;
                    button('gforce-records-clear',armed?'Да, удалить все':'Удалить все',800,356,360,40,function(){app.clearGforceRecords();},armed,feed.mode==='offline');
                }
                hint(r.tab===2?(app.telemetry.recordsError||app.gforceSaveError||(feed.mode==='demo'?'Рекорды DEMO не сохраняются':'Рекорды за всё время · сохраняются на HU')):'Пики текущей сессии · положительное поперечное ускорение — влево');
            } else if (mod.id === 'edrive') {
                var energy=app.energy.view(feed);
                if (r.tab === 2) {
                    var charges=energy.charges,chargePages=Math.max(1,Math.ceil(charges.length/3));app.energy.page=Math.min(app.energy.page,chargePages-1);
                    text('Рост заряда на стоянке',44,163,34);
                    if(energy.charging)text('Сейчас: '+number(energy.charging.from,1)+' → '+number(energy.charging.to,1)+' %',44,207,25,C.amber);
                    if(!charges.length)text('Сохранённых сессий ещё нет',44,263,28,C.dim);
                    var price=app.settings.modules.edrive.price;
                    charges.slice(app.energy.page*3,app.energy.page*3+3).forEach(function(c,i){row(new Date(c.fromT).toLocaleDateString(I18n.locale()),number(c.from,1)+' → '+number(c.to,1),'%',48,253+i*52,700);
                        text(typeof c.kwh==='number'?number(c.kwh,2)+' кВт·ч'+(price>0?' · '+number(c.kwh*price,2)+' €':''):'кВт·ч: нужны ёмкость и SOH',1100,253+i*52,21,C.dim,'right');});
                    if(energy.sleepNote)text('Пока HU не работал: '+number(energy.sleepNote.from,1)+' → '+number(energy.sleepNote.to,1)+' % · причина не подтверждена',44,403,20,C.amber);
                    button('energy-history-page',(app.energy.page+1)+' / '+chargePages+' · Далее',1150,230,392,65,function(){app.energy.page=(app.energy.page+1)%chargePages;},false,chargePages<2);
                    paged(app.energy.page,chargePages,function(i){app.energy.page=i;});
                    hint(energy.error||'Рост SOC при известных остановке и выключенном двигателе; подключение кабеля не подтверждено');
                }
                else if (r.tab === 4) {
                    // Full per-cell array where the battery unit sends one (DID DFA5); never synthesised from min/max.
                    var cellData=feed.mode==='demo'?{cells:Array.apply(null,Array(96)).map(function(_,i){return 3.818+((i*37)%11)/1000;}),valid:96,total:96,source:'demo'}:app.energyCells&&app.energyCells.revision===feed.revision&&app.energyCells.data;
                    text('Напряжения ячеек',44,163,34);
                    if(!cellData){text('Массив ячеек не получен',48,240,28,C.dim);text('Блок может сообщать только min/max или не отвечать на DFA5',48,282,22,C.dim);}
                    else{
                        var cv0=cellData.cells,good=cv0.filter(function(v){return v!==null;}),lo=Math.min.apply(null,good),hi=Math.max.apply(null,good),avg=good.reduce(function(a,v){return a+v;},0)/good.length;
                        var bw=1512/cv0.length,base=lo-.005,top=hi+.005;
                        cv0.forEach(function(v,i){if(v===null){cv.fillRect(44+i*bw,360,Math.max(1,bw-1),4,C.red);return;}var hh=20+150*(v-base)/(top-base);cv.fillRect(44+i*bw,380-hh,Math.max(1,bw-1),hh,v===lo||v===hi?C.amber:C.dim);});
                        text(cellData.valid+' из '+cellData.total+' ячеек · min '+number(lo,3)+' V (№'+(cv0.indexOf(lo)+1)+') · max '+number(hi,3)+' V (№'+(cv0.indexOf(hi)+1)+') · разброс '+number((hi-lo)*1000)+' мВ · среднее '+number(avg,3)+' V',44,206,21,C.text);
                    }
                    hint(feed.mode==='demo'?'DEMO · условные значения':'Только показанные блоком значения; пропуски отмечены красным');
                }
                else if (r.tab === 5) {
                    var cf=feed.mode==='demo'?{system:1,ac:0,seats:{DR:0,PS:0,DRR:null,PSR:null},wheel:false}:app.energyComfort&&app.energyComfort.revision===feed.revision&&app.energyComfort.data;
                    var onoff=function(v){return v===null||v===undefined?'нет данных':v?'включено':'выключено';},lv=function(v){return v===null||v===undefined?'нет данных':v===0?'выкл.':'уровень '+v;};
                    text('Климат и обогревы',44,163,34);
                    if(!cf)text('Данные климата не получены',48,240,28,C.dim);
                    else{
                        row('Климатическая система',onoff(cf.system),'',48,215,680);row('Кондиционер',onoff(cf.ac),'',48,280,680);row('Руль',onoff(cf.wheel),'',48,345,680);
                        row('Сиденье водителя',lv(cf.seats.DR),'',850,215,695);row('Сиденье пассажира',lv(cf.seats.PS),'',850,265,695);row('Сзади слева / справа',lv(cf.seats.DRR)+' / '+lv(cf.seats.PSR),'',850,315,695);
                        row('Обогревы · оценка',metric('comfortKw',2),'кВт',850,365,695);
                    }
                    hint('Мощность обогревов — оценка по уровням (оригинальная таблица eDrive), не измерение');
                }
                else if (r.tab === 3) { text('БОРТОВАЯ СЕТЬ', 44, 173, 25, C.dim); text(metric('voltage', 1) + ' V', 38, 326, 142, C.amber, 'left', true); hint('Значение напряжения не является оценкой остаточной ёмкости'); }
                else if(r.tab===1){
                    row('Напряжение HV',metric('hvVoltage',1),'V',48,170,680);row('Ток HV',metric('hvCurrent',1),'A',48,235,680);
                    var tf=app.settings.modules.edrive.tempUnit==='f',bt1=feed.read('batteryTemp').value,dmi=app.settings.modules.edrive.distUnit==='mi';
                    row('Температура',number(bt1===null?null:tf?bt1*9/5+32:bt1,1),tf?'°F':'°C',48,300,680);row('Ячейки min / max',metric('cellMin',3)+' / '+metric('cellMax',3),'V',48,365,680);
                    row('Отдано за сессию',number(energy.trip.seconds?energy.trip.used:null,3),'кВт·ч',850,170,695);row('Получено за сессию',number(energy.trip.seconds?energy.trip.received:null,3),'кВт·ч',850,235,695);
                    row('Измеренный участок',number(energy.trip.seconds?energy.trip.measuredKm/(dmi?1.609344:1):null,2),dmi?'mi':'км',850,300,695);row('Нетто на участке',number(energy.trip.measuredKm>=1?(energy.trip.used-energy.trip.received)/energy.trip.measuredKm*100*(dmi?1.609344:1):null,1),dmi?'кВт·ч/100 mi':'кВт·ч/100 км',850,365,695);
                    hint(app.energyReadError||'Энергия считается только на участках с данными. Полученная энергия не обязательно является рекуперацией.');
                }else{
                    ev();button('energy-capacity','Полная ёмкость: '+(energy.capacity===null?'не задана':energy.capacity+' кВт·ч'),520,399,500,48,function(){app.energy.capacity(feed);});
                    if(energy.error)text(energy.error,44,437,20,C.amber);
                }
            } else if (mod.id === 'ambient_light') {
                if (!r.tab) lighting();
                else {
                    // Confirmed = what the car reports (ComfortFunctionIuK status); selected = the preview wheel.
                    var amb=app.ambientView(),ast=amb.state,rawHue=amb.raw&&typeof amb.raw.statusHueInteriorLighting==='number'?amb.raw.statusHueInteriorLighting:null;
                    text('Состояние в автомобиле'+(amb.demo?' · DEMO':''), 44, 165, 37);
                    row('Освещение',!ast||ast.enabled===null?'Нет данных':ast.enabled?'Включено':'Выключено','',48,222,680);
                    row('Штатный профиль',!ast||ast.profile===null?'Нет данных':ast.profile===0?'Выключено':ast.profile<=12?'№ '+ast.profile:'Индивидуальный / FES','',48,282,680);
                    row('Смещение яркости HU',!ast||ast.brightnessOffset===null?'Нет данных':(ast.brightnessOffset>0?'+':'')+ast.brightnessOffset,'',48,342,680);
                    text('Сырое значение оттенка: '+(rawHue===null?'—':rawHue+' / 4095')+' · соответствие RGB не доказано',780,232,20,C.dim);
                    text('Выбранный цвет (предпросмотр)', 780, 280, 22, C.dim); cv.fillRect(780, 297, 300, 50, Color.hex(app.lighting.hue, app.lighting.saturation, 1));
                    var lastRes=amb.last?({confirmed:'подтверждена',unchanged:'без изменений',unconfirmed:'не подтверждена',rejected:'отклонена до отправки',uncertain:'результат неизвестен'}[amb.last.status]||amb.last.status):null;
                    if(lastRes)text('Последняя запись с ПК: '+lastRes,1100,322,20,amb.last.status==='confirmed'||amb.last.status==='unchanged'?C.dim:C.amber);
                    hint(amb.writeBlocked?'Результат прошлой записи не подтверждён — новые записи заблокированы до проверки':amb.problem||'Изменение штатного профиля/яркости — только после подтверждения на компьютере (MGU Tools)');
                }
            } else if (mod.id === 'draggy' || mod.id === 'brake_test') {
                measurements(mod);
            } else if (mod.id === 'dyno') {
                dyno();
            } else if (mod.id === 'dtc_scanner') {
                rule(1110,139,1110,391);
                var diagnostic=app.diagnostics.view(feed),report=diagnostic.report,items=[],clear=app.clearFaults.view(),clearing=r.tab===0&&clear.state==='clearing';
                var detail=app.diagnostics.detail;
                text(clearing?'Стирание ошибок · блоков: '+clear.results.length:r.tab===1?'Сообщения Check Control':r.tab===2?'Параметры следующего чтения':detail?'ECU '+detail.address+' · '+detail.code:'Память ошибок'+(report?(report.mask===255?' · с историей':' · текущие'):''),44,163,34);
                if(clearing){
                    // Upstream Fault Scanner's clear runs to the end (functional 14, then clearUnit per unit, then a
                    // rescan); no stop/confirm buttons here (it is busy), only its progress per unit and the message.
                    clear.results.slice(0,6).forEach(function(t,i){text('ECU '+t.addr.toString(16).toUpperCase(),48,206+i*34,24);var label=t.text||'Ожидает';text(label.length>74?label.slice(0,73)+'…':label,250,206+i*34,22,t.state==='cleared'?C.amber:t.state==='not-cleared'?C.red:C.dim);});
                    text(clear.operation?'Журнал: operations/'+clear.operation:'Стирание выполняется…',48,420,19,C.dim);
                }else if(r.tab===2){
                    button('scan-scope',app.diagnostics.scope==='all'?'Ошибки: включая историю':'Ошибки: текущие',44,205,1000,65,function(){app.diagnostics.option('scope');},false,diagnostic.phase==='reading');
                    button('scan-info','Информационная память: '+(app.diagnostics.includeInfo?'включена':'выключена'),44,291,1000,65,function(){app.diagnostics.option('info');},false,diagnostic.phase==='reading');
                    text('Параметры применятся при следующем сканировании.',48,385,24,C.dim);
                }else if(r.tab===1){
                    var cc=diagnostic.cc,ccItems=cc&&cc.messages,ccPages=Math.max(1,Math.ceil((ccItems||[]).length/4));
                    app.diagnostics.ccPage=Math.min(app.diagnostics.ccPage,ccPages-1);
                    if(!ccItems)text(cc&&cc.quality==='stale'?'Список устарел · ожидаем новые данные':'Список сообщений не прочитан',48,240,25,C.dim);
                    else if(!ccItems.length)text('В полученном списке нет активных сообщений',48,240,25,C.dim);
                    else ccItems.slice(app.diagnostics.ccPage*4,app.diagnostics.ccPage*4+4).forEach(function(m,i){text('CC '+m.id,48,220+i*48,25);text(m.reason.slice(0,55)||'Активное сообщение',230,220+i*48,24,C.dim);});
                    button('cc-page',(app.diagnostics.ccPage+1)+' / '+ccPages+' · Далее',1150,252,392,58,function(){app.diagnostics.ccPage=(app.diagnostics.ccPage+1)%ccPages;},false,ccPages<2);
                    paged(app.diagnostics.ccPage,ccPages,function(i){app.diagnostics.ccPage=i;});
                }
                else if(detail){
                    var description=detail.description||{text:'Расшифровка отсутствует',source:'unknown'},wrapped=[],line='';
                    (detail.name+'\n'+description.text).split(/\s+/).forEach(function(word){while(word.length>76){if(line){wrapped.push(line);line='';}wrapped.push(word.slice(0,76));word=word.slice(76);}if(line.length+word.length+1>76){wrapped.push(line);line='';}line+=(line?' ':'')+word;});if(line)wrapped.push(line);
                    var detailPages=Math.max(1,Math.ceil(wrapped.length/6));app.diagnostics.detailPage=Math.min(app.diagnostics.detailPage,detailPages-1);
                    wrapped.slice(app.diagnostics.detailPage*6,app.diagnostics.detailPage*6+6).forEach(function(s,i){text(s,48,208+i*29,24);});
                    var origins={oem:'База описаний',hand:'Справочное описание',export:'Экспорт кодировочного инструмента',unknown:'Неизвестно',demo:'Демонстрация'};
                    text((detail.memory==='info'?'Информационная память':'Память ошибок')+' · '+(origins[description.source]||description.source)+' · статус 0x'+detail.status.toString(16).toUpperCase(),48,398,22,C.dim);
                    button('detail-back','К списку',1150,193,392,60,function(){app.diagnostics.detail=null;});
                    button('detail-page',(app.diagnostics.detailPage+1)+' / '+detailPages+' · Далее',1150,270,392,60,function(){app.diagnostics.detailPage=(app.diagnostics.detailPage+1)%detailPages;},false,detailPages<2);
                    paged(app.diagnostics.detailPage,detailPages,function(i){app.diagnostics.detailPage=i;});
                }else {
                    if(report)report.units.forEach(function(u){
                        var addr=u.address.toString(16).toUpperCase();if(addr.length<2)addr='0'+addr;
                        var add=function(f,mem){var d={address:addr,name:u.name||'ECU '+addr,code:f.code,status:f.status,memory:mem,description:f.description};items.push({title:'ECU '+addr+' · '+f.code+(mem==='info'?' · INFO':''),value:f.description?f.description.text:'Статус 0x'+f.status.toString(16).toUpperCase(),detail:d});};
                        var entries=u.faults.concat(report.mask===255?u.other:[]);
                        if(u.state!=='read')items.push({title:'ECU '+addr,value:u.reason});
                        else if(!entries.length)items.push({title:'ECU '+addr,value:'Ошибок в ответе нет'});
                        entries.forEach(function(f){add(f,'fault');});
                        if(report.infoRequested){if(!u.info||u.info.state!=='read')items.push({title:'ECU '+addr+' · INFO',value:u.info?u.info.reason:'Не прочитано'});else u.info.faults.concat(report.mask===255?u.info.other:[]).forEach(function(f){add(f,'info');});}
                    });
                    var pages=Math.max(1,Math.ceil(items.length/4));app.diagnostics.page=Math.min(app.diagnostics.page,pages-1);
                    items.slice(app.diagnostics.page*4,app.diagnostics.page*4+4).forEach(function(item,i){
                        if(item.detail)button('fault-detail-'+i,item.title,30,188+i*48,1070,46,function(){app.diagnostics.detail=item.detail;app.diagnostics.detailPage=0;});else text(item.title,48,220+i*48,25);
                        text(item.value.length>43?item.value.slice(0,42)+'…':item.value,1080,220+i*48,22,C.dim,'right');rule(44,234+i*48,1090,234+i*48);
                    });
                    if(!items.length){icon('dtc_scanner',48,277,74,C.muted);rule(151,306,1053,306);}
                    if(!items.length)text(diagnostic.phase==='reading'?diagnostic.stage+' · ответили '+diagnostic.progress+' блоков':report?'Ни один блок не ответил. Память ошибок не прочитана.':'Запустите чтение памяти ошибок',48,240,25,C.dim);
                    button('scan',diagnostic.phase==='reading'?'Чтение…':'Прочитать ошибки',1150,179,392,65,function(){app.diagnostics.scan(feed);},false,diagnostic.phase==='reading'||(feed.mode!=='demo'&&!(feed.mode==='vehicle'&&app.diagnostics.adapter)));
                    button('scan-page',(app.diagnostics.page+1)+' / '+pages+' · Далее',1150,252,392,58,function(){app.diagnostics.page=(app.diagnostics.page+1)%pages;},false,pages<2);
                    paged(app.diagnostics.page,pages,function(i){app.diagnostics.page=i;});
                    if(diagnostic.phase==='reading')button('scan-cancel','Отменить чтение',1150,320,392,58,function(){app.diagnostics.cancel();});
                    else button('clear-dtc',clear.armed?'Подтвердите стирание · ещё раз':'Стереть ошибки',1150,320,392,58,function(){app.clearFaults.press();},clear.armed,clear.busy);
                }
                hint(clearing?(clear.message||'Стирание всей памяти ошибок указанных блоков'):r.tab===1?'Сообщения головного устройства; Check Control не заменяет чтение памяти ошибок':r.tab===2?'Чтение информационной памяти не изменяет настройки и не стирает ошибки':detail?'BACK возвращает к списку. Описание сохранено вместе с кодом в отчёте.':clear.message||diagnostic.error||diagnostic.saveError||(report&&report.infoError?'Информационная память не прочитана; основная память сохранена':report&&report.ended==='deadline'?'Достигнут лимит времени; список блоков может быть неполным':report?'Нажмите на код для описания. «Стереть ошибки» — повторное нажатие в течение 5 с':'Чтение запускается вручную; отсутствие ответа не означает отсутствие ошибок'));
            } else if (mod.id === 'service') {
                rule(1110,139,1110,391);
                var cbs=app.cbsReset.view(),cbsFlow=r.tab===0&&cbs.state!=='idle';
                var hx=function(n){var v=Number(n).toString(16).toUpperCase();return v.length<2?'0'+v:v;};
                if(cbsFlow){
                    var cbsTitles={loading:'Сброс интервала · запрос KOMBI',choose:'Сброс интервала · выберите пункт',arming:'Сброс интервала · подготовка',armed:'Подтвердите сброс интервала',resetting:'Сброс интервала · выполняется',result:'Сброс интервала · результат'};
                    text(cbsTitles[cbs.state]||'Сброс интервала',44,163,34);
                    if((cbs.state==='armed'||cbs.state==='resetting'||cbs.state==='arming')&&cbs.item){
                        text('Пункт: '+cbs.item.name.slice(0,34)+' · KOMBI 0x'+hx(cbs.item.id),48,220,26);
                        text('Запрос kit: 2E 10 01 · ECU 60 · фиксированные данные',48,266,23,C.dim);
                        text('Счётчик обслуживания читается до и после записи',48,306,23,C.dim);
                        text('При неизвестном результате повтор не выполняется',48,346,23,C.dim);
                    }else if(cbs.state==='result'&&cbs.result){
                        var res=cbs.result,resLabels={verified:'Подтверждено',accepted:'Принято, не проверено',refused:'Отклонено KOMBI',unconfirmed:'Не подтверждено','not-sent':'Не отправлено'};
                        text(res.name.slice(0,34)+' · '+(resLabels[res.state]||res.state),48,220,28,res.state==='verified'?C.amber:res.state==='unconfirmed'?C.red:C.text);
                        var resLines=[],resLine='';String(res.text||'').split(/\s+/).forEach(function(word){if(resLine.length+word.length+1>72){resLines.push(resLine);resLine='';}resLine+=(resLine?' ':'')+word;});if(resLine)resLines.push(resLine);
                        resLines.slice(0,2).forEach(function(l,i){text(l,48,262+i*32,23,C.dim);});
                        text('Счётчик до: '+(res.before?res.before.count:'—')+' · после: '+(res.after?res.after.count:'—'),48,338,23,C.dim);
                        text(cbs.operation?'Журнал: operations/'+cbs.operation:'Журнал не создан',48,376,19,C.dim);
                    }else{
                        cbs.kombi.forEach(function(k,i){var y=220+i*48;text(k.name.slice(0,34),48,y,25);
                            text(cbs.state==='loading'?'Запрос…':k.state==='allowed'?'KOMBI разрешает':k.state==='blocked'?'Заблокирован · причина 0x'+hx(k.reason):'Нет в ответе KOMBI',1080,y,23,k.state==='allowed'&&cbs.state!=='loading'?C.amber:C.dim,'right');});
                        if(cbs.other)text('Другие пункты в ответе KOMBI: '+cbs.other+' · здесь не сбрасываются',48,330,21,C.dim);
                    }
                    if(cbs.state==='choose')cbs.choices.slice(0,2).forEach(function(c,i){button('cbs-item-'+c.id,c.name.slice(0,26),1120,181+i*73,440,61,function(){app.cbsReset.choose(c.id);});});
                    else if(cbs.state==='armed')button('cbs-confirm',cbs.confirmReady?'Сбросить · '+cbs.seconds+' с':'Подождите…',1120,181,440,61,function(){app.cbsReset.confirm();},true,!cbs.confirmReady);
                    else if(cbs.state==='result')button('cbs-done','Готово',1120,181,440,61,function(){app.cbsReset.dismiss();});
                    else button('cbs-progress','Выполняется…',1120,181,440,61,function(){},false,true);
                    if(cbs.state!=='result')button('cbs-cancel',cbs.state==='resetting'?'Отменить до отправки':'Отмена',1120,325,440,58,function(){app.cbsReset.cancel();});
                    hint(cbs.message||(cbs.state==='choose'?'Выберите пункт · разрешения KOMBI действительны ещё '+cbs.seconds+' с':cbs.state==='armed'?'Подтвердите в течение '+cbs.seconds+' с. Любое другое действие отменяет сброс.':cbs.state==='result'?'Принятый запрос ещё не означает проверенный сброс':'Ожидание ответа KOMBI'));
                }else{
                var service=app.serviceView(),serviceItems=r.tab?(service.summary?[{name:service.summary.text,way:service.summary.way,date:service.summary.date,colour:service.summary.colour}]:null):service.list;
                var sd=r.tab===0?app.serviceDetail:null;
                if(sd){
                    var stateNames=['—','Требуется сейчас','Скоро','В норме','Скоро'];
                    text(sd.name.slice(0,48),44,163,34,sd.colour===1?C.red:sd.colour===2||sd.colour===4?C.amber:C.text);
                    row('Пробег до обслуживания',sd.way||'—','',48,215,680);row('Срок',sd.date||'—','',48,280,680);row('Состояние',stateNames[sd.colour]||'—','',48,345,680);
                    var hintText=app.serviceHintText,hl=[],hline='';String(hintText?hintText.text:'Нажмите «Подробности KOMBI», чтобы запросить описание пункта').split(/\s+/).forEach(function(word){if(hline.length+word.length+1>32){hl.push(hline);hline='';}hline+=(hline?' ':'')+word;});if(hline)hl.push(hline);
                    hl.slice(0,5).forEach(function(l,i){text(l,780,215+i*34,22,hintText&&hintText.state==='error'?C.amber:C.dim);});
                    button('service-hint',hintText&&hintText.state==='loading'?'Запрос…':'Подробности KOMBI',1150,195,392,62,function(){app.serviceHint();},false,hintText&&hintText.state==='loading');
                    button('service-back','К списку',1150,278,392,62,function(){app.serviceDetail=null;app.serviceHintText=null;});
                    hint('Сроки и единицы переданы автомобилем. Запрос подробностей только читает данные.');
                }else{
                text(r.tab?'Ближайшее обслуживание':'Обслуживание автомобиля',44,163,34);
                var servicePages=Math.max(1,Math.ceil((serviceItems||[]).length/4));app.servicePage=Math.min(app.servicePage,servicePages-1);
                if(!serviceItems)text('Данные CBS не прочитаны или устарели',48,240,26,C.dim);
                else if(!serviceItems.length)text('Получен пустой список CBS',48,240,26,C.dim);
                else serviceItems.slice(app.servicePage*4,app.servicePage*4+4).forEach(function(it,i){var y=220+i*48,col=it.colour===1?C.red:it.colour===2||it.colour===4?C.amber:C.text;
                    if(!r.tab){button('service-item-'+i,'',30,y-24,1070,46,function(){app.serviceOpen(it);});actions[actions.length-1].label=it.name;}
                    icon(/масл/i.test(it.name)?'oil':/торм/i.test(it.name)?'brake_test':'service',48,y-23,28,col);text(it.name.slice(0,34),96,y,25,col);text(it.way||'—',835,y,27,C.text,'right',true);text(it.date||'—',1080,y,27,col,'right',true);rule(44,y+16,1080,y+16);
                });
                button('service-page',(app.servicePage+1)+' / '+servicePages+' · Далее',1150,195,392,62,function(){app.servicePage=(app.servicePage+1)%servicePages;},false,servicePages<2);
                paged(app.servicePage,servicePages,function(i){app.servicePage=i;});
                if(!r.tab)button('reset-cbs','Сброс интервала',1150,278,392,65,function(){app.cbsReset.request();},false,!cbs.allowed);
                hint(r.tab?'Сроки и единицы переданы автомобилем.':cbs.message||cbs.previous||(cbs.allowed?'Выберите пункт для подробностей · сброс только с разрешения KOMBI':cbs.reason));
                }
                }
            } else if (mod.id === 'doom') {
                var game=app.game.view();
                if(r.tab===2){
                    app.game.cancel();
                    Core.gameSettings.slice(app.game.page*3,app.game.page*3+3).forEach(function(f,i){button('game-setting-'+f[0],f[1]+': '+Core.gameLabel(app.game.prefs[f[0]]),44,150+i*77,1000,64,function(){app.game.setting(f[0]);});});
                    button('game-settings-page',(app.game.page+1)+' / 2 · Далее',1150,184,392,64,function(){app.game.page=(app.game.page+1)%2;});
                    paged(app.game.page,2,function(i){app.game.page=i;});
                    hint(app.game.error||'Сложность и эпизод — для новой игры; остальные настройки — при продолжении.');
                }else if(r.tab===1){
                    app.game.cancel();text('Контроллер iDrive',44,177,35);
                    ['Поворот — прицеливание. Наклон — движение и шаг в сторону.','Нажатие — огонь и взаимодействие. Двойное нажатие — оружие.','BACK или кнопка «В меню» — пауза и сохранение.','Движение, потеря скорости или фокуса экрана — автоматическая пауза.'].forEach(function(s,i){text(s,48,232+i*44,25,i===3?C.amber:C.text);});
                    hint('При отсутствии событий контроллера используются кнопки игрового экрана.');
                }else{
                    for(var grid=0;grid<7;grid++){cv.line(42+grid*110,140,390+(grid-3)*38,389,1,C.line);cv.line(44,157+grid*35,744,157+grid*35,1,C.line);}cv.fillRect(38,191,710,139,C.bg);text('DOOM',60,299,125,C.amber,'left',true);text('FREEDOOM · PHASE 1',64,357,23,C.dim);rule(800,146,800,390);
                    text('Только на стоящем автомобиле',840,180,28);
                    text(game.reason.length>58?game.reason.slice(0,57)+'…':game.reason,840,222,22,C.dim);
                    button('start-game',game.saved?'Продолжить игру':'Играть',824,246,720,62,function(){app.game.play();},false,!game.allowed);
                    button('new-game',game.armed?'Подтвердить новую игру':'Новая игра',824,323,720,62,function(){app.game.newGame();},game.armed,!game.allowed);
                    hint(game.error||(game.armed?'Прогресс текущей игры будет заменён. Повторное нажатие в течение 10 секунд подтверждает.':'DEMO не отменяет проверку реальной скорости. Сохранения DEMO и автомобиля раздельные.'));
                }
            }
        }
        if(mod && Core.moduleSettings[mod.id]){
            button('module-preferences','Параметры',1050,399,240,48,function(){app.go('settings',mod.id);});
            if(mod.id!=='service'&&mod.id!=='edrive')button('reset-session','Сброс сессии',1300,399,260,48,function(){app.resetSession(mod.id);});
        }
        rule(0, 455, 1600, 455);
        var activePage = r.page === 'apps' ? 'settings' : ['module', 'group'].indexOf(r.page) >= 0 ? 'modules' : r.page;
        [['overview', 'Обзор'], ['modules', 'Модули'], ['history', 'История'], ['settings', 'Настройки']].forEach(function (p, i) {
            button('nav-' + p[0], p[1], i * 400, 462, 400, 56, function () { if (app.route.page !== p[0]) app.go(p[0]); }, activePage === p[0]);
            if (i) rule(i * 400, 474, i * 400, 504);
        });
        actions.forEach(function (a) { a.label = I18n.tr(a.label); });
        app.setActions(actions);
        // where the kit runs the screen (renderer 2.x): a page with a paged list follows a finger (App.scroll)
        cv.scroll = !!app.pager();
        var focus = actions.filter(function (a) { return a.id === app.route.focus; })[0];
        if (focus && focus.id.indexOf('nav-')===0) { cv.fillRect(focus.x+20,513,focus.w-40,4,C.amber); }
        else if (focus) { var f = focus; cv.line(f.x + 3, f.y + 2, f.x + f.w - 3, f.y + 2, 2, C.amber); cv.line(f.x + 3, f.y + f.h - 2, f.x + f.w - 3, f.y + f.h - 2, 2, C.amber); cv.line(f.x + 3, f.y + 2, f.x + 3, f.y + f.h - 2, 2, C.amber); cv.line(f.x + f.w - 3, f.y + 2, f.x + f.w - 3, f.y + f.h - 2, 2, C.amber); }
        if (app.message) { cv.fillRect(0, 402, 1600, 46, C.panel); text(app.message, 40, 433, 24, C.amber); }
        return actions;
    }
    return { render: render, colors: C };
}));
