'use strict';
// Ambient light 0.2.2 inside the unified app. The vendored, unmodified bridge + guarded controller +
// lease-checking transport (docs/ambient-source.json) are the ONLY write path: a request confirmed
// on the PC (session nonce, <=30 s expiry, single claim), durable intent before the setter, lease at
// the native call, readback, and a fail-closed block after an unknown outcome. The HU screen has no
// apply button; the colour wheel stays a preview because no RGB -> BMW encoding is proven.
const clock=require('./kit/clock');
class AmbientSession {
    constructor(ctx,options){
        this.ctx=ctx;this.o=options||{};this.report=null;this.problem='';this.working=false;this.closed=false;this.transport=null;this.mailbox=null;
        const signals=ctx.signals;
        if(signals&&typeof signals.hasNative==='function'&&signals.hasNative()&&typeof signals.proxy==='function'){
            const Bridge=this.o.bridge||require('./ambient-bridge'),Transport=this.o.transportFactory||require('./comfort-transport'),C=require('./comfort-controller');
            const proxy=signals.proxy(C.IFACE,'1');
            Promise.resolve(proxy).catch(e=>{this.problem=String(e&&e.message||e);ctx.log.warn('Ambient: '+this.problem);});
            this.transport=Transport.create(proxy);this.mailbox=Bridge.create(ctx.dataDir,this.transport);
        }else this.problem='Нет подключения к сервису автомобиля';
        this.timer=clock.setInterval(()=>this.tick(),1000);
    }
    tick(){
        if(this.closed||!this.mailbox||this.working)return Promise.resolve(null);
        this.working=true;
        return this.mailbox.tick().then(r=>{if(r&&!this.closed){this.report=r;this.at=clock.now();}return r;},e=>{this.problem=String(e&&e.message||e);this.ctx.log.warn('Ambient: '+this.problem);return null;}).then(r=>{this.working=false;return r;});
    }
    /** Read-only view: confirmed car state, write block and the last PC-confirmed result. */
    snapshot(){
        const r=this.report,fresh=r&&this.at!==undefined&&clock.now()-this.at<=5000;
        return {available:!!this.mailbox,problem:this.problem||(r&&r.error)||'',ready:!!(fresh&&r.status==='ready'),state:fresh?r.state:null,
            raw:fresh&&r.raw?r.raw:null,writeBlocked:!!(r&&r.write_blocked),last:r?r.last:null,sequence:r?r.sequence:null};
    }
    copyTo(feed,now){
        if(feed.mode!=='vehicle')return;const s=this.snapshot(),st=s.state;
        const put=(k,v)=>feed.put(k,v,v===null||v===undefined?'unavailable':'live',now,'someip:ComfortFunctionIuK');
        put('profile',st?st.profile:null);put('brightness',st?st.brightnessOffset:null);put('lightEnabled',st&&st.enabled!==null?(st.enabled?1:0):null);
    }
    close(){this.closed=true;clock.clearInterval(this.timer);if(this.transport)this.transport.close();}
}
module.exports=AmbientSession;
