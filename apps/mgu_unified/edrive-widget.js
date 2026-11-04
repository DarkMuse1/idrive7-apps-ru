'use strict';
// Home-screen widget of apps/edrive 2.2.0 (app.json startWidget, BMW Drive Recorder layout), fed by
// the unified feed. Big widget: a picture; small widget: the layout's own text cells (the HMI does
// not show the picture at that size). Negative power is "energy received", never claimed as a
// cable charge or regeneration.
const {Canvas,withAlpha}=require('./kit/canvas');
const I18n=require('./i18n'),tr=s=>I18n.tr(s);
const C={text:'#f0eadf',dim:'#b2a99a',amber:'#e8a64e',green:'#2fd27a',track:'#49443b',red:'#dc6754'};
const fin=v=>typeof v==='number'&&isFinite(v);
const fmt=(v,d)=>fin(v)?I18n.decimal(v.toFixed(d||0)):'--';
function state(kw){
    if(!fin(kw))return {what:'НЕТ ДАННЫХ',col:C.dim};
    if(kw<-.3)return {what:'ПРИЁМ ЭНЕРГИИ',col:C.green};
    if(kw>.3)return {what:'ОТДАЧА',col:C.text};
    return {what:'ПОКОЙ',col:C.dim};
}
class EdriveWidget {
    /** view(): {demo, kw, soc, v, a, temp, tempUnit, net, received, gaugeKw}; fps(): frames per second. */
    constructor(ctx,options){
        this.ctx=ctx;this.o=options;this.canvas={};this.sent={};this.available=!!(ctx.widget&&ctx.widget.loop);
        if(!this.available)return;
        ctx.widget.loop(()=>Math.max(1,this.o.fps()||8),inst=>this.draw(inst));
        if(ctx.widget.onChange)ctx.widget.onChange(why=>{if(why==='resized'||why==='placed')this.sent={};});
    }
    active(){return !!(this.available&&this.ctx.widget.active&&this.ctx.widget.active());}
    cells(inst,d){
        const small=!inst.big,st=state(d.kw),max=Math.max(10,d.gaugeKw||100);
        const cells={
            Title:[small?'eDrive':'','Text'],
            TextRecordings:[small?fmt(d.kw,1)+' кВт   '+(fin(d.soc)?fmt(d.soc)+' %':'-- %'):'','Text'],
            TextCam:[small?st.what+(fin(d.v)?'  '+fmt(d.v)+' V':''):'','Text'],
            ProgressbarVisible:[small,'Bool'],
            Progress:[small&&fin(d.kw)?Math.round(Math.min(1,Math.abs(d.kw)/max)*100):0,'Float'],
            TimeElapsed:[small?'Ячейки '+(fin(d.temp)?fmt(d.temp)+d.tempUnit:'--'):'','Text'],
            TimeRemaining:[small?'Поездка '+fmt(d.net,2)+' кВт·ч':'','Text']
        };
        const prev=this.sent[inst.spawnId]||(this.sent[inst.spawnId]={});
        Object.keys(cells).forEach(k=>{if(cells[k][1]==='Text')cells[k][0]=tr(cells[k][0]);const v=JSON.stringify(cells[k][0]);if(prev[k]===v)return;prev[k]=v;Promise.resolve(this.ctx.widget.set(inst.spawnId,k,cells[k][0],cells[k][1])).catch(e=>this.ctx.log.warn('widget cell '+k+': '+e));});
    }
    draw(inst){
        const d=this.o.view();
        if(inst)this.cells(inst,d);
        const _text=cv=>{const t=cv.text.bind(cv);cv.text=(s,x,y,size,c,o)=>t(I18n.glyphSafe(tr(s),!!(o&&o.font==='num')),x,y,size,c,o);return cv;};
        const sw=this.ctx.spec&&this.ctx.spec.startWidget||{},size=sw.size||[384,256],safe=sw.safe||[.09,.1],w=size[0],h=size[1],key=w+'x'+h;
        const cv=(this.canvas[key]=this.canvas[key]||_text(new Canvas(w,h))).clear([0,0,0,0]);
        const x0=Math.round(w*safe[0]),x1=w-x0,y0=Math.round(h*safe[1]),y1=h-y0,iw=x1-x0,st=state(d.kw);
        cv.text(st.what,x0,y0+18,16,st.col,{font:'bold'});
        cv.text(fin(d.v)?fmt(d.v)+' V'+(fin(d.a)?'   '+fmt(d.a)+' A':''):'-- V',x1,y0+18,15,C.dim,{align:'right'});
        if(d.demo)cv.text('DEMO',(x0+x1)/2,y0+18,13,C.amber,{font:'bold',align:'center'});
        const ky=y0+92;
        cv.text(fmt(d.kw,1),x0,ky,64,fin(d.kw)?C.text:C.dim,{font:'num'});
        cv.text('кВт',x0+170,ky,20,C.dim);
        cv.text(fin(d.soc)?fmt(d.soc)+' %':'-- %',x1,ky,42,fin(d.soc)?C.text:C.dim,{font:'num',align:'right'});
        // Power bar: discharge right of the zero mark, received energy left (gauge as setting gaugeKw).
        const out=Math.max(20,d.gaugeKw||100),inn=Math.max(10,out*.5),span=out+inn,z=x0+iw*inn/span,by=ky+16;
        cv.roundRect(x0,by,iw,12,6,withAlpha(C.track,.9));
        if(fin(d.kw)&&Math.abs(d.kw)>.05){const x=z+Math.max(-inn,Math.min(out,d.kw))/span*iw;if(d.kw>0)cv.roundRect(z,by,x-z,12,6,C.amber);else cv.roundRect(x,by,z-x,12,6,C.green);}
        cv.fillRect(Math.round(z)-1,by-4,3,20,C.text);
        const yb=y1-26,col=(x,label,v,c,align)=>{cv.text(label,x,yb,13,C.dim,{font:'bold',align});cv.text(v,x,yb+24,20,c,{font:'bold',align});};
        col(x0,'ЯЧЕЙКИ',fin(d.temp)?fmt(d.temp)+d.tempUnit:'--',fin(d.temp)?C.text:C.dim,'left');
        col((x0+x1)/2,'ПОЕЗДКА',fmt(d.net,2)+' кВт·ч',C.text,'center');
        col(x1,'ПРИНЯТО',fmt(d.received,2)+' кВт·ч',C.green,'right');
        return cv;
    }
}
module.exports=EdriveWidget;module.exports.state=state;
