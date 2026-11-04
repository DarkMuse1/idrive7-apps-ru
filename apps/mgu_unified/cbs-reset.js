'use strict';
// Confirmed CBS reset of the unified app.
// Ported from apps/service/main.js and kit/diag (cbsResetOptions/armCbsReset/resetCbs):
//   - setting resetOn, off by default;
//   - only the items 0x03 / 0x64 that the instrument cluster itself reports without a blocking
//     reason in 22 10 02; the offer is bound to one Diag link and lapses after 15 s;
//   - one grant per confirmation, consumed by kit before it waits; kit re-reads 22 10 02 and
//     re-evaluates our guard immediately before the fixed 2E 10 01 payload to ECU 0x60;
//   - 22 10 01 before/after; accepted (positive reply) and verified (count +1 mod 32) differ.
// Customer decision 2026-11-03: the checks are upstream Service's only - the earlier unified-only standstill
// (0 km/h) gate was removed (upstream Service resets with no speed check); the kit's parked.js also changed.
// Conditions kept from the unified port (not car-facing refusals upstream lacks; a future task may align these too):
//   - an explicit choice of one permitted item (no automatic pick of "the only one");
//   - at least 1 s between arming and the confirmation button;
//   - the before-record must be read, else nothing is sent (the result could not be verified);
//   - durable intent journal before dispatch, result journal after; no automatic retry ever.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const clock=require('./kit/clock'),Store=require('./kit/store');
const ITEMS=Object.freeze({3:'Тормозная жидкость',100:'Контроль автомобиля'});
const RULES=Object.freeze({offerMs:15000,confirmMs:15000,armDelayMs:1000});
const hex=n=>(n<16?'0':'')+n.toString(16).toUpperCase();
function mkdir(dir){if(fs.existsSync(dir))return;mkdir(path.dirname(dir));fs.mkdirSync(dir);}
function clone(v){return v===undefined?undefined:JSON.parse(JSON.stringify(v));}
/** 62 10 02, then 3 bytes per item: id, blocking reason (0 = none), reserve. */
function permissions(uds){
    if(!Array.isArray(uds)||uds.length<3||uds[0]!==0x62||uds[1]!==0x10||uds[2]!==0x02||(uds.length-3)%3)return null;
    const out=[];for(let i=3;i<uds.length;i+=3)out.push({id:uds[i],reason:uds[i+1]});return out;
}
/** 62 10 01, then 12 bytes per item: id, ..., [4]&0x1F service count, [5] availability %. */
function record(uds){
    if(!Array.isArray(uds)||uds.length<3||uds[0]!==0x62||uds[1]!==0x10||uds[2]!==0x01)return null;
    const out={};
    for(let i=3;i+12<=uds.length;i+=12){if(Object.prototype.hasOwnProperty.call(out,uds[i]))return null;out[uds[i]]={avail:uds[i+5],count:uds[i+4]&0x1F};}
    return out;
}
const REFUSALS=Object.freeze({CBS_NOT_ALLOWED:'KOMBI больше не разрешает этот сброс',CBS_LAPSED:'подтверждение истекло или отменено',CBS_NOT_CONFIRMED:'нет подтверждения для этого пункта',
    CBS_REPEATED:'запрос уже выполнялся, повтор запрещён',CBS_NOT_AVAILABLE:'разрешения KOMBI не прочитаны',QUEUE_CANCELLED:'источник данных изменился'});
function refusal(e){return REFUSALS[e&&e.code]||String(e&&e.message||e);}
function requestText(id){return '2E 10 01 01 '+hex(id)+' 64 1F 80 00 0F FF 0F 3F FF 00 → ECU 60';}
class CbsReset {
    constructor(ctx,diagnostic,options){
        this.ctx=ctx;this.queue=diagnostic.queue;this.o=options;
        this.state='idle';this.message='';this.previous='';this.closed=false;this.epoch=0;this.stopRequested=false;
        this.offer=null;this.offerRaw=null;this.kombi=[];this.allowed=[];this.item=null;this.grant=null;this.result=null;this.operation=null;
        try{
            const dir=path.join(ctx.dataDir,'operations'),dirs=fs.readdirSync(dir).filter(n=>/^cbs-reset-[0-9]+-[a-f0-9]+$/.test(n)).sort();
            if(dirs.length){const latest=dirs[dirs.length-1],f=JSON.parse(fs.readFileSync(path.join(dir,latest,'result.json'),'utf8'));
                if(f.phase==='dispatching'||f.result==='unconfirmed')this.previous='Предыдущий сброс CBS не подтверждён. Проверьте список и operations/'+latest;}
        }catch(e){if(e.code!=='ENOENT')this.previous='Предыдущий журнал сброса CBS не прочитан; проверьте operations.';}
    }
    name(id){const names=(this.o.names&&this.o.names())||{};return names[id]||ITEMS[id]||('Пункт 0x'+hex(id));}
    baseline(){
        if(this.closed)return 'Сброс завершён';
        if(this.o.enabled()!==true)return 'Сброс выключен: включите «Сброс интервалов CBS» в параметрах';
        if(this.o.mode()==='demo')return 'В DEMO сброс недоступен';
        if(this.o.mode()!=='vehicle')return 'Сброс недоступен: нет подключения к автомобилю';
        if(!this.o.visible())return 'Сброс доступен только на открытом экране «Обслуживание»';
        return '';
    }
    guard(){
        if(this.stopRequested)return 'Сброс отменён';
        if(this.o.source()!==this.source)return 'Источник данных изменился';
        return this.baseline();
    }
    live(epoch){return !this.closed&&epoch===this.epoch&&this.o.mode()==='vehicle'&&this.o.source()===this.source;}
    // Given to kit's armCbsReset: re-evaluated by resetCbs before and after its permission recheck.
    permit(epoch,id){return epoch===this.epoch&&!!this.item&&this.item.id===id&&(this.state==='arming'||this.state==='armed'||this.state==='resetting')&&!this.guard();}
    abort(message){this.epoch++;this.state='idle';this.offer=null;this.grant=null;this.item=null;this.stopRequested=false;this.message=message;}
    /** Step 1: ask the cluster which items it permits right now (22 10 02, a read). */
    async request(){
        if(this.state!=='idle')return false;
        const why=this.baseline();if(why){this.message=why;return false;}
        const epoch=++this.epoch;this.source=this.o.source();this.state='loading';this.message='';this.kombi=[];this.allowed=[];this.result=null;this.operation=null;this.stopRequested=false;
        try{
            const got=await this.queue.cbs(()=>this.live(epoch),api=>api.permissions());
            if(epoch!==this.epoch)return false;
            const raw=got.seen[got.seen.length-1]||null;
            this.offer=got.value;this.offerAt=clock.now();this.offerRaw=raw;this.kombi=permissions(raw&&raw.uds)||[];this.allowed=got.value.items.slice();
            if(!this.allowed.length){this.abort('KOMBI сейчас не разрешает сброс тормозной жидкости и контроля автомобиля');return false;}
            const again=this.guard();if(again){this.abort(again+' — ничего не отправлено');return false;}
            this.state='choose';return true;
        }catch(e){if(epoch===this.epoch)this.abort('Сброс недоступен: '+refusal(e));return false;}
    }
    /** Step 2: arm one explicitly chosen, permitted item. kit consumes the offer here. */
    async choose(id){
        this.sync();if(this.state==='armed'&&this.item&&this.item.id!==id){this.abort('Выбран другой пункт — запросите разрешения KOMBI заново. Ничего не отправлено');return false;}
        if(this.state!=='choose')return false;
        if(this.allowed.indexOf(id)<0){this.message='Этот пункт KOMBI не разрешил';return false;}
        const epoch=this.epoch,offer=this.offer;this.offer=null;this.item={id,name:this.name(id)};this.state='arming';
        try{
            const grant=await this.queue.cbs(()=>this.live(epoch),async api=>api.arm(offer,id,()=>this.permit(epoch,id)));
            if(epoch!==this.epoch||this.state!=='arming')return false;
            this.grant=grant;this.armedAt=clock.now();this.state='armed';this.message='';return true;
        }catch(e){if(epoch===this.epoch)this.abort('Сброс не подготовлен: '+refusal(e));return false;}
    }
    sync(){
        if(['loading','choose','arming','armed'].indexOf(this.state)<0)return;
        const why=this.guard();if(why){this.abort(why+' — ничего не отправлено');return;}
        const now=clock.now();
        if(this.state==='choose'&&(now<this.offerAt||now-this.offerAt>RULES.offerMs))this.abort('Разрешения KOMBI устарели — запросите заново. Ничего не отправлено');
        else if(this.state==='armed'&&(now<this.armedAt||now-this.armedAt>=RULES.confirmMs))this.abort('Время подтверждения истекло — ничего не отправлено');
    }
    cancel(){
        if(this.state==='resetting'){this.stopRequested=true;this.message='Отмена: неотправленный запрос не будет отправлен';return;}
        if(this.state==='result'){this.dismiss();return;}
        if(this.state!=='idle')this.abort('Сброс отменён — ничего не отправлено');
    }
    save(file,value){if(!Store.save(file,value,{log:this.ctx.log}))throw Error('Не удалось записать журнал сброса');}
    /** Step 3: the confirmation, at least 1 s after arming and within 15 s of it. */
    async confirm(){
        this.sync();if(this.state!=='armed')return false;
        if(clock.now()-this.armedAt<RULES.armDelayMs){this.message='Подтверждение возможно через секунду после выбора';return false;}
        const item=this.item,grant=this.grant,epoch=this.epoch;this.grant=null;this.state='resetting';this.stopRequested=false;this.message='';
        const result={item:item.id,name:item.name,state:'not-sent',text:'Не отправлено'};this.result=result;
        let file=null,journal=null,dispatched=false;
        const close=(state,text)=>{result.state=state;result.text=text;};
        try{
            await this.queue.cbs(()=>!this.closed&&this.o.mode()==='vehicle'&&this.o.source()===this.source,async api=>{
                const dir=path.join(this.ctx.dataDir,'operations','cbs-reset-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'));mkdir(dir);this.operation=path.basename(dir);file=path.join(dir,'result.json');
                journal={schema:1,at:Date.now(),phase:'prepared',item:item.id,name:item.name,request:requestText(item.id)+' (формирует kit)',
                    permission:{raw:clone(this.offerRaw),items:clone(this.kombi),allowed:this.allowed.slice()},
                    conditions:{confirmWithinMs:RULES.confirmMs,armDelayMs:RULES.armDelayMs}};
                this.save(file,journal);
                const before=await api.record(),parsed=record(before.uds),was=parsed&&parsed[item.id];
                journal.before={raw:before,record:parsed};result.before=was||null;
                if(!was){close('not-sent','Исходная запись CBS не прочитана — сброс не отправлен');journal.phase='stopped';journal.result='not-sent';this.save(file,journal);return;}
                const why=this.guard();if(why){close('not-sent','Не отправлено: '+why);journal.phase='stopped';journal.result='not-sent';journal.stop=why;this.save(file,journal);return;}
                journal.phase='dispatching';journal.intentAt=Date.now();
                // A durable intent precedes the write. A crash leaves it visibly unresolved.
                this.save(file,journal);
                let out=null;
                try{const got=await api.reset(item.id,grant);dispatched=true;out=got.value;journal.recheck=got.seen;}
                catch(e){
                    journal.recheck=e.seen||[];
                    // kit refusals (CBS_*) and a queue cancellation (QUEUE_CANCELLED) happen before any write.
                    if(/^(CBS_|QUEUE_CANCELLED$)/.test(String(e.code||''))){close('not-sent','Не отправлено: '+refusal(e));journal.phase='stopped';journal.result='not-sent';journal.stop=e.code;this.save(file,journal);return;}
                    dispatched=true;out={ok:false,outcome:'failed',uds:null,why:e.message};
                }
                journal.write={outcome:out.outcome,uds:out.uds?Array.from(out.uds):null,nrc:out.nrc===undefined?null:out.nrc,why:out.why||'',verdict:out.verdict||null,pending:!!out.pending};
                if(out.outcome==='negative')close('refused','KOMBI отклонил сброс · NRC '+hex(Number(out.nrc)||0));
                else if(out.outcome==='refused')close('not-sent','Транспорт TASU не принял запрос; повтор не выполняется');
                else if(out.outcome==='reply')close('accepted','KOMBI принял запрос; запись CBS ещё не проверена');
                else close('unconfirmed','Ответ не получен — сброс не подтверждён. Повтор не выполняется');
                journal.result=result.state;this.save(file,journal);
                if(result.state!=='accepted'&&result.state!=='unconfirmed')return;
                let after=null;
                try{const raw=await api.record();journal.after={raw,record:record(raw.uds)};after=journal.after.record&&journal.after.record[item.id];}
                catch(e){journal.after={error:e.message};}
                result.after=after||null;
                const plus=after&&after.count===((was.count+1)&0x1F);
                if(result.state==='accepted'){
                    if(plus)close('verified','Сброс подтверждён: счётчик '+was.count+' → '+after.count);
                    else if(after&&after.count===was.count)close('accepted','KOMBI принял запрос, но счётчик не изменился — сброс не подтверждён');
                    else if(after)close('accepted','KOMBI принял запрос, счётчик '+was.count+' → '+after.count+' — не соответствует +1');
                    else close('accepted','KOMBI принял запрос; повторное чтение записи не удалось');
                }else if(plus){result.counterChanged=true;result.text='Ответ не получен, но счётчик '+was.count+' → '+after.count+'. Проверьте список; повтор не выполняется';}
                journal.result=result.state;journal.phase='finished';journal.finishedAt=Date.now();this.save(file,journal);
            });
        }catch(e){
            if(!dispatched&&result.state==='not-sent'&&result.text==='Не отправлено')close('not-sent','Не отправлено: '+refusal(e));
            if(journal&&file){if(journal.phase!=='finished'&&journal.phase!=='stopped'&&!dispatched)journal.phase='stopped';journal.error=e.message;try{this.save(file,journal);}catch(ignore){}}
            if(dispatched)this.message='Результат не записан полностью; журнал operations/'+this.operation+' остаётся незавершённым';
        }
        if(epoch===this.epoch)this.state='result';
        this.stopRequested=false;
        return dispatched;
    }
    dismiss(){if(this.state==='result'){this.state='idle';this.result=null;this.message='Список CBS обновится автоматически в течение минуты';}}
    view(){
        this.sync();const now=clock.now(),state=this.state;
        const kombi=[3,100].map(id=>{const k=this.kombi.filter(x=>x.id===id)[0];return {id,name:this.name(id),state:!k?'missing':k.reason===0?'allowed':'blocked',reason:k?k.reason:null};});
        return {available:true,state,message:this.message,previous:this.previous,reason:this.baseline(),allowed:state==='idle'&&!this.baseline(),
            kombi,other:this.kombi.filter(x=>x.id!==3&&x.id!==100).length,choices:this.allowed.map(id=>({id,name:this.name(id)})),item:clone(this.item),
            confirmReady:state==='armed'&&now-this.armedAt>=RULES.armDelayMs,
            seconds:state==='choose'?Math.max(0,Math.ceil((this.offerAt+RULES.offerMs-now)/1000)):state==='armed'?Math.max(0,Math.ceil((this.armedAt+RULES.confirmMs-now)/1000)):0,
            result:clone(this.result),operation:this.operation};
    }
    close(){this.cancel();this.closed=true;this.epoch++;}
}
module.exports=CbsReset;module.exports.permissions=permissions;module.exports.record=record;module.exports.RULES=RULES;module.exports.ITEMS=ITEMS;
