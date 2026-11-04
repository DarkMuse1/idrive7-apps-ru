'use strict';
// One lazy TASU transport. Reads and the explicit, granted clear batch share a lock.
// It cannot arbitrate other OAP applications. Kit's reply correlation stays intact.
const ALLOWED=[0x19,0x22,0x01,0x06];
module.exports=class ReadQueue {
    constructor(factory){this.factory=factory;this.link=null;this.init=null;this.tail=Promise.resolve();this.closed=false;this.pending=0;}
    run(active,work){
        return this.enqueue(active,work,false);
    }
    clear(active,work){return this.enqueue(active,work,true);}
    // CBS reset job: only kit's fixed CBS methods (ECU 60, DIDs 1001/1002, items 03/64).
    // No address, DID or payload is accepted from the caller.
    cbs(active,work){return this.enqueue(active,work,'cbs');}
    enqueue(active,work,clearing){
        if(this.closed||this.pending>=8)return Promise.reject(Error('Диагностическая очередь недоступна'));
        this.pending++;
        const check=()=>{if(this.closed||!active()){const e=Error('Чтение отменено: источник изменён');e.code='QUEUE_CANCELLED';throw e;}};
        const task=this.tail.then(async()=>{
            check();
            if(!this.init)this.init=Promise.resolve().then(()=>this.factory()).then(link=>{this.link=link;if(this.closed)this.dispose();return link;},e=>{this.init=null;throw e;});
            const link=await this.init;check();
            if(link.error){this.dispose();this.init=null;throw Error(link.error);}
            if(!link.available)throw Error('TASU недоступен');
            let open=true,reading=false;const drains=[];
            const invoke=async(method,target,sid,data,opts)=>{
                check();if(!open||reading)throw Error('Диагностический запрос уже выполняется или завершён');
                if(ALLOWED.indexOf(sid)<0)throw Error('Разрешено только чтение');
                if(!Array.isArray(data)||!data.length||data.length>32||data.some(b=>!Number.isInteger(b)||b<0||b>255))throw Error('Некорректный запрос');
                // Copy request data; an awaiting caller cannot change the identifier later.
                const payload=data.slice();reading=true;
                try{const r=method==='readAll'?await link.readAll(sid,payload,opts):await link.physical(target,sid,payload,opts);check();return r;}
                finally{reading=false;}
            };
            const track=(...args)=>{const job=invoke(...args);drains.push(job.then(()=>{},()=>{}));return job;};
            // The explicit, armed (5 s double-press) fault-memory clear: exactly what upstream Fault Scanner sends
            // (idrive7-apps apps/dtc_scanner/main.js doClear + clearUnit; customer decision 2026-11-03). It owns the
            // lock for the whole clear, so no read interleaves and the kit's reply correlation stays intact. One
            // request at a time; a reply is kept even if the source changes after a write went out. No private grant,
            // parked gate or scan-age check here (upstream has none); the clear flow confirms with the 5 s press.
            const exclusiveReq=async(fn)=>{
                check();if(!open||reading)throw Error('Диагностический запрос уже выполняется или завершён');
                reading=true;try{return await fn();}finally{reading=false;}
            };
            const clearApi={
                // 14 FF FF FF to every unit at once (0xDF), as the workshop tester clears (upstream doClear)
                functional:(sid,data,opts)=>{const job=exclusiveReq(()=>link.functional(sid,data,opts));drains.push(job.then(()=>{},()=>{}));return job;},
                // one unit: 14 FF FF FF and the extended-session retry (upstream clearUnit); its reply, positive or negative
                physical:(target,sid,data,timeoutMs,accept)=>{const job=exclusiveReq(()=>link.physical(target,sid,data,timeoutMs,accept));drains.push(job.then(()=>{},()=>{}));return job;}
            };
            // Records exactly the replies kit's own cbsResetOptions() received (also its recheck
            // inside resetCbs). The queue lock guarantees no other request of this app interleaves.
            const captured=async fn=>{
                const seen=[],own=Object.prototype.hasOwnProperty.call(link,'request'),prev=link.request;
                link.request=function(){return prev.apply(this,arguments).then(r=>{seen.push({outcome:r.outcome,uds:r.uds?Array.from(r.uds):null,nrc:r.nrc,why:r.why||'',verdict:r.verdict});return r;});};
                try{return {value:await fn(),seen};}catch(e){e.seen=seen;throw e;}finally{if(own)link.request=prev;else delete link.request;}
            };
            const exclusive=async fn=>{check();if(!open||reading)throw Error('Диагностический запрос уже выполняется или завершён');reading=true;try{return await fn();}finally{reading=false;}};
            const cbsApi={
                permissions:()=>{const job=exclusive(()=>captured(()=>link.cbsResetOptions()));drains.push(job.then(()=>{},()=>{}));return job;},
                arm:(offer,item,ok)=>{check();if(!open)throw Error('Задача завершена');return link.armCbsReset(offer,item,ok);},
                record:()=>{const job=exclusive(()=>link.request(0x60,0x22,[0x10,0x01],{timeoutMs:5000,maxMs:10000,accept:u=>u[0]!==0x62||u[1]===0x10})).then(r=>({outcome:r.outcome,uds:r.uds?Array.from(r.uds):null,nrc:r.nrc,why:r.why||'',verdict:r.verdict}));drains.push(job.then(()=>{},()=>{}));return job;},
                // After dispatch the reply is kept even if the source changes (as for DTC clear).
                reset:(item,grant)=>{try{check();}catch(e){return Promise.reject(e);}if(!open||reading)return Promise.reject(Error('Диагностический запрос уже выполняется или завершён'));reading=true;const job=captured(()=>link.resetCbs(item,grant));const done=job.then(v=>{reading=false;return v;},e=>{reading=false;throw e;});drains.push(done.then(()=>{},()=>{}));return done;}
            };
            const api=Object.freeze(clearing==='cbs'?cbsApi:clearing?clearApi:{readAll:(sid,data,opts)=>track('readAll',null,sid,data,opts),physical:(target,sid,data,timeout)=>track('physical',target,sid,data,timeout)});
            try{return await work(api);}finally{open=false;await Promise.all(drains);}
        });
        this.tail=task.then(()=>{this.pending--;},()=>{this.pending--;});return task;
    }
    dispose(){const link=this.link;this.link=null;if(link&&link.p&&link.p.shutdown){try{Promise.resolve(link.p.shutdown()).catch(()=>{});}catch(e){}}}
    close(){this.closed=true;this.dispose();}
};
