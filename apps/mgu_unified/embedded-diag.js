'use strict';
// One transaction at a time across the shell and the three embedded modules.
// Retains upstream matching, deadlines and NRCs. A write waits its turn like any request, as in upstream's
// separate apps (MGU Tools' former DG-19 refusal of a write behind another request was dropped by the
// customer, 2026-11-03); right before it is sent it is cancelled if its screen closed or lost focus.
const original=require('./kit/diag');
let tail=Promise.resolve();
let outstanding=0;
function serial(owner,write,run){
    outstanding++;
    const job=tail.then(()=>{
        if(owner.signals.embeddedReadAllowed && !owner.signals.embeddedReadAllowed())throw Error('Диагностика отключена в демонстрации');
        if(write&&owner.signals.embeddedWriteAllowed&&!owner.signals.embeddedWriteAllowed())throw Error('Команда отменена: экран управления закрыт или потерял фокус');
        return run();
    });
    tail=job.then(()=>{outstanding--;},()=>{outstanding--;});
    return job;
}
class Diag extends original.Diag {
    _exchange(target,sid,data,options,write){return serial(this,write,()=>super._exchange(target,sid,data,options,write));}
    readAll(sid,data,options){return serial(this,!original.READ_SERVICES[sid],()=>super.readAll(sid,data,options));}
    send(target,sid,data){return serial(this,!original.READ_SERVICES[sid],()=>super.send(target,sid,data));}
}
module.exports=Object.assign({},original,{Diag});
