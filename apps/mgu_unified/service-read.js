'use strict';
// BMW-formatted CBS dates/distances: retain its language and units, do not recode.
// Source: apps/service/main.js cbsDataServiceList / cbsDataSBA handlers.
const Q=require('./kit/quality'),IFACE='de.bmw.infotainment.KombiInterface_2';
function find(v,key,str,depth){
    if(typeof str==='number'){depth=str;str=false;}
    if(!v||typeof v!=='object'||(depth||0)>12)return null;
    if(Object.prototype.hasOwnProperty.call(v,key)&&(!str||typeof v[key]==='string'))return v;
    for(const k of Object.keys(v)){const result=find(v[k],key,str,(depth||0)+1);if(result)return result;}
    return null;
}
function text(v){return typeof v==='string'?v.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,160):'';}
function colour(v){return typeof v==='number'&&v>=0&&v<=4?v:({DEFAULT:0,RED:1,YELLOW:2,GREEN:3,ORANGE:4}[v]||0);}
function list(raw){
    const arr=Array.isArray(raw)?raw:raw&&(raw.cbsDataServiceList||raw.value);
    if(!Array.isArray(arr)||arr.length>256)return {invalid:'unrecognized CBS list'};
    const out=[],ids=new Set();
    for(const item of arr){
        const s=find(item,'cBSIdentifier');
        if(!s||!Number.isInteger(s.cBSIdentifier)||s.cBSIdentifier<0||s.cBSIdentifier>65535||ids.has(s.cBSIdentifier))return {invalid:'invalid CBS item'};
        const name=text(s.cBSServcieName||s.cBSServiceName);if(!name)return {invalid:'CBS item has no name'};
        ids.add(s.cBSIdentifier);out.push({id:s.cBSIdentifier,name,colour:colour(s.cBSColor),way:text(s.cBSServiceWay),date:text(s.cBSServiceDate)});
    }
    return {value:out};
}
function summary(raw){const s=find(raw,'cBSDataSBAText');return s&&typeof s.cBSDataSBAText==='string'?{value:{text:text(s.cBSDataSBAText),way:text(s.cBSDataSBADistance),date:text(s.cBSDataSBADate),colour:colour(s.cBSDataSBAColor)}}:{invalid:'unrecognized CBS summary'};}
class ServiceRead {
    constructor(ctx){
        this.store=new Q.Store();this.closed=false;this.sub=null;this.signals=ctx.signals;
        this.store.define('list',{provider:IFACE,source:'someip:KombiInterface_2.cbsDataServiceList',stale_ms:5000,decode:list});
        this.store.define('summary',{provider:IFACE,source:'someip:KombiInterface_2.cbsDataSBA',stale_ms:5000,decode:summary});
        ctx.signals.watch(IFACE,'1',{cbsDataServiceList:v=>{if(!this.closed)this.store.put('list',v);},cbsDataSBA:v=>{if(!this.closed)this.store.put('summary',v);}},ctx.log,{onAvailable:up=>{if(!this.closed)this.store.provider(IFACE,up);}}).then(sub=>{
            if(this.closed){sub.shutdown();return;}this.sub=sub;if(sub.error||!sub.available)this.store.provider(IFACE,false,sub.error);
        }).catch(e=>{if(!this.closed)this.store.provider(IFACE,false,String(e));ctx.log.warn('CBS: '+e.message);});
    }
    /** The iDrive's detail text for one item (original BTN_DETAILS: requestCBSServiceHint). */
    async hint(id){
        if(this.closed)throw Error('closed');
        if(!Number.isInteger(id)||id<0||id>65535)throw Error('invalid item');
        if(typeof this.signals.call!=='function')throw Error('Подробности недоступны');
        const r=await this.signals.call(IFACE,'1','requestCBSServiceHint',{id},6000);
        const h=find(r,'cBSServiceHint',true)||{};
        return [text(h.cBSServiceHint),text(h.cBSServiceWay),text(h.cBSServiceDate)].filter(Boolean).join('   ')||'Для этого пункта нет подробностей';
    }
    snapshot(){const l=this.store.getLive('list'),s=this.store.getLive('summary');return {quality:l.quality,list:l.quality==='live'?l.value:null,summaryQuality:s.quality,summary:s.quality==='live'?s.value:null};}
    close(){this.closed=true;if(this.sub)this.sub.shutdown();}
}
module.exports=ServiceRead;module.exports.list=list;module.exports.summary=summary;
