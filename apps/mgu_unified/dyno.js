(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MguDyno=factory();}(this,function(){
    'use strict';
    // Virtual dyno physics and binning adapted from apps/dyno/main.js.
    var finite=function(v){return typeof v==='number'&&isFinite(v);},CDA={coupe:.62,wagon:.72,suv:.95};
    function power(d,p){var v=d.speed/3.6,a=d.gLong*9.80665;return (p.weight*a*v+.6*CDA[p.body]*v*v*v+.013*p.weight*9.80665*v)/(1-p.loss/100);}
    function analyse(points,p,start){
        var bins={};points.forEach(function(x){var k=Math.round(x.rpm/100)*100;(bins[k]=bins[k]||[]).push(x);});
        var raw=Object.keys(bins).map(Number).sort(function(a,b){return a-b;}).map(function(k){
            var values=bins[k],ecu=values.filter(function(x){return finite(x.ecu);});
            return {rpm:k,p:values.reduce(function(a,x){return a+x.p;},0)/values.length,ecu:ecu.length?ecu.reduce(function(a,x){return a+x.ecu;},0)/ecu.length:null};
        });
        var curve=raw.map(function(c,i){var win=raw.slice(Math.max(0,i-2),i+3),watts=win.reduce(function(a,x){return a+x.p;},0)/win.length;
            return {rpm:c.rpm,p:Math.max(0,watts),t:Math.max(0,watts/(c.rpm*Math.PI/30)),ecu:c.ecu};});
        var pk=curve.reduce(function(a,c){return c.p>a.p?c:a;},curve[0]),tk=curve.reduce(function(a,c){return c.t>a.t?c:a;},curve[0]);
        return {at:start,curve:curve,peakP:pk.p,peakPrpm:pk.rpm,peakT:tk.t,peakTrpm:tk.rpm,weight:p.weight,loss:p.loss,body:p.body,v0:points[0].v,v1:points[points.length-1].v};
    }
    function Dyno(prefs,onDone){this.prefs=prefs;this.onDone=onDone;this.reset();}
    Dyno.prototype.reset=function(){this.pull=null;this.last=null;this.state='idle';this.reason='';this.power=null;};
    Dyno.prototype.invalidate=function(reason){if(this.pull){this.state='cancelled';this.reason=reason||'Данные потеряны — заезд отменён';}this.pull=null;this.last=null;this.power=null;};
    Dyno.prototype.feed=function(t,d){
        if(!finite(d.rpm)||d.rpm<0||d.rpm>12000||!finite(d.speed)||d.speed<0||d.speed>400||!finite(d.gLong)||Math.abs(d.gLong)>3){this.invalidate();return;}
        if(this.last!==null&&t<=this.last)return;
        if(this.last!==null&&t-this.last>1000)this.invalidate('Пауза в данных — заезд отменён');
        if(this.last!==null&&t-this.last<40)return;this.last=t;
        var hard=d.gLong>.12&&d.speed>15&&d.rpm>1200;this.power=hard?power(d,this.prefs):null;
        if(hard){
            if(!this.pull){this.pull={segs:[],start:Date.now(),startMono:t};this.state='pull';this.reason='';}
            if(t-this.pull.startMono>60000){this.invalidate('Заезд слишком длинный — запись отменена');return;}
            var k=d.rpm/d.speed,seg=this.pull.segs[this.pull.segs.length-1];
            if(!seg||Math.abs(k-seg.k)/seg.k>.04){seg={k:k,points:[]};this.pull.segs.push(seg);}
            if(this.pull.segs.length>30||seg.points.length>=2000){this.invalidate('Превышен объём записи');return;}
            seg.k+=(k-seg.k)*.1;seg.points.push({rpm:d.rpm,p:this.power,v:d.speed,ecu:finite(d.torque)?d.torque:null});this.pull.lastHard=t;
        }else if(this.pull&&t-this.pull.lastHard>500){
            var pull=this.pull;this.pull=null;
            var best=pull.segs.filter(function(seg){var rpms=seg.points.map(function(x){return x.rpm;});return seg.points.length>15&&Math.max.apply(null,rpms)-Math.min.apply(null,rpms)>=1500;}).sort(function(a,b){return a.k-b.k;})[0];
            if(!best){this.state='short';return;}
            var run=analyse(best.points,this.prefs,pull.start);this.state='done';this.onDone(run);
        }
    };
    return {Dyno:Dyno,power:power,analyse:analyse};
}));
