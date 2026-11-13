'use strict';
// Read-only, app-local VIN gate. No functional scan, session change or actuator command.
const IFACE='com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE='SystemFunctionsInternalTasuInst1';
function verdict(r){
    const v=r&&typeof r==='object'?r.TasuErrorEnum:r;
    return v===undefined?'UNKNOWN':String(v);
}
function bytes(v){
    if(Buffer.isBuffer(v)||Array.isArray(v)||v instanceof Uint8Array)return Array.prototype.slice.call(v);
    if(v&&v.data)return bytes(v.data);
    return [];
}
function begin(signals,options){
    const o=options||{},delays=o.delays||[2000,4000,6000];
    let proxy,done=false,available=false,wasAvailable=false,waiting=false,accepted=false,candidate=null,attempt=0;
    let resolve,reject;const timers=[];
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    function later(fn,ms){const t=setTimeout(()=>{if(!done)fn();},ms);timers.push(t);return t;}
    function close(){if(proxy){const p=proxy;proxy=null;try{Promise.resolve(p.shutdown&&p.shutdown()).catch(()=>{});}catch(_){}}}
    function finish(error,value){if(done)return;done=true;timers.forEach(clearTimeout);close();if(error)reject(error);else resolve(value);}
    function fail(message){finish(Error(message));}
    function notify(state){if(o.onState)try{o.onState(state,attempt);}catch(_){}}
    function receive(v){
        if(done||!waiting)return;
        if(v&&v.errorCode!==undefined&&v.errorCode!==0&&v.errorCode!=='NO_ERROR')return fail('TASU прервал чтение VIN. Повторите вручную.');
        const b=bytes(v&&v.udsResponse);
        if(b.length>=5&&b[2]===0x7F)return fail('TASU отклонил чтение VIN. Повторите вручную.');
        if(b.length<12||b[6]!==0x40)return;
        const u=b.slice(9);
        if(u[0]===0x7F&&u[1]===0x22){
            if(u[2]===0x78)return; // accepted; final response only, never a duplicate
            return fail('BDC отказал в чтении VIN. Повторите вручную.');
        }
        if(u[0]!==0x62||u[1]!==0xF1||u[2]!==0x90)return;
        if(u.length!==20)return fail('BDC вернул некорректный VIN');
        const vin=String.fromCharCode.apply(null,u.slice(3));
        if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))return fail('BDC вернул некорректный VIN');
        candidate=vin;if(accepted)finish(null,vin);
    }
    async function send(){
        if(done||!available)return;
        attempt++;waiting=true;accepted=false;candidate=null;notify('reading');
        let reply;
        const p=proxy,guarded=Object.create(p);
        guarded.callMethod=function(){if(done||!available)throw Error('Cancelled VIN read');return p.callMethod.apply(p,arguments);};
        try{reply=await signals.call(guarded,'sendTasuRequest',{
            sourceAddress:0xF2,targetAddress:0x40,serviceID:0x22,subroutineID:0,
            udsDataLength:2,udsData:Buffer.from([0xF1,0x90]),deadlockTime:0,
        },o.rpcTimeoutMs||8000);}catch(_){return fail('Не получен ответ TASU на чтение VIN. Повторите вручную.');}
        if(done)return;
        const v=verdict(reply);
        if(v==='NO_ERROR'||v==='0'||v==='REQUEST_PENDING'||v==='1'){
            accepted=true;notify('accepted');
            if(candidate)return finish(null,candidate);
            later(()=>fail('BDC не прислал итоговый ответ с VIN. Повторите вручную.'),o.finalTimeoutMs||12000);
        }else if(v==='APP_REQUEST_TEMPORARILY_NOT_ACCEPTED'||v==='7'){
            waiting=false;candidate=null;
            if(attempt>delays.length)return fail('TASU занят. Не удалось прочитать VIN. Повторите позже.');
            notify('busy');later(send,delays[attempt-1]);
        }else fail('TASU не принял чтение VIN. Повторите вручную.');
    }
    later(()=>fail('Не удалось прочитать VIN за отведённое время. Повторите вручную.'),o.totalTimeoutMs||40000);
    Promise.resolve().then(()=>signals.proxy(IFACE,INSTANCE)).then(async p=>{
        proxy=p;if(done){close();return;}
        await signals.on(p,'sendTasuResponse',receive);
        if(done)return;
        await signals.onAvailable(p,up=>{
            if(done)return;available=!!up;
            if(!up&&wasAvailable)return fail('Связь с автомобилем потеряна');
            if(up&&!wasAvailable){wasAvailable=true;send();}
        });
    }).catch(()=>fail('Не удалось открыть канал чтения VIN. Проверьте подключение автомобиля.'));
    return {promise,cancel:()=>fail('Чтение VIN отменено')};
}
module.exports={begin,verdict};
