'use strict';
const Q=require('./kit/quality');
const IFACE='de.bmw.infotainment.checkcontrol.CheckControlMaster';
// As in dtc_scanner: basicList is a complete snapshot, not an incremental event.
// Its shape/active-state encoding still needs a recorded HU sample for validation.
function decode(raw){
    let count=0,found=false,bad=false;const messages=new Map();
    function walk(v,depth){
        if(++count>2048||depth>12){bad=true;return;}
        if(!v||typeof v!=='object')return;
        if(Array.isArray(v)){found=true;v.forEach(x=>walk(x,depth+1));return;}
        if(v.ccmId!==undefined){
            found=true;const id=v.ccmId;
            if(!Number.isInteger(id)||id<0||id>65535){bad=true;return;}
            if(v.activeState==='AKTIV'||v.activeState===0)messages.set(id,{id,ecu:Number.isInteger(v.requestorDiagAddr)?v.requestorDiagAddr:null,reason:v.reason===undefined?'':String(v.reason).slice(0,100)});
            else if(v.activeState!=='INAKTIV'&&v.activeState!==1)bad=true;
        }
        Object.keys(v).forEach(k=>{if(v[k]&&typeof v[k]==='object')walk(v[k],depth+1);});
    }
    walk(raw,0);return !found||bad?{invalid:'unrecognized Check Control snapshot'}:{value:Array.from(messages.values())};
}
class CheckControl {
    constructor(ctx){
        this.store=new Q.Store();this.closed=false;this.sub=null;
        this.store.define('list',{provider:IFACE,source:'someip:CheckControlMaster.basicList',stale_ms:5000,decode});
        ctx.signals.watch(IFACE,'1',{basicList:v=>{if(!this.closed)this.store.put('list',v);}},ctx.log,{onAvailable:up=>{if(!this.closed)this.store.provider(IFACE,up);}}).then(sub=>{
            if(this.closed){sub.shutdown();return;}this.sub=sub;if(sub.error||!sub.available)this.store.provider(IFACE,false,sub.error);
        }).catch(e=>{if(!this.closed)this.store.provider(IFACE,false,String(e));ctx.log.warn('Check Control: '+e.message);});
    }
    snapshot(){const s=this.store.getLive('list');return {quality:s.quality,at:s.received_at_monotonic,source:s.source,messages:s.quality==='live'?s.value:null};}
    close(){this.closed=true;if(this.sub)this.sub.shutdown();}
}
module.exports=CheckControl;module.exports.decode=decode;
