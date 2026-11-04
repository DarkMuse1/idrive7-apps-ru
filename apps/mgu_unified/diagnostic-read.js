'use strict';
const ReadQueue=require('./diagnostic-queue');
const {Diag}=require('./kit/diag');
const Diagnostic=require('./diagnostics');
const FaultTexts=require('./fault-texts');
const clock=require('./kit/clock');
module.exports=function diagnostics(ctx){
    // No transport is initialized or request sent until an explicit read action.
    const queue=new ReadQueue(()=>new (ctx.Diag||Diag)(ctx.signals,ctx.log).init());
    const texts=FaultTexts();
    let latest=null;
    return {queue,resolveScan(receipt){return latest&&latest.receipt===receipt&&!latest.used?latest:null;},consumeScan(receipt){if(!latest||latest.receipt!==receipt||latest.used)throw Error('Нужно новое сканирование');latest.used=true;},async scan(active,progress,options){
        latest=null;const started=clock.now();
        const settings=options||{},mask=settings.mask===255?255:12;
        ctx.log.info('Unified diagnostics: fault-memory read started (19 02 '+mask.toString(16)+')');
        const result=await queue.run(active,link=>link.readAll(0x19,[2,mask],{onReply:(addr,n)=>progress(n)}));
        if(result.ended==='transport')throw Error(result.why||'Ошибка диагностического канала');
        const units=[];result.replies.forEach((raw,address)=>units.push(Diagnostic.unit(address,Array.from(raw))));
        result.pending.forEach(address=>units.push(Diagnostic.unit(address,[0x7F,0x19,0x78])));
        let infoState='off',infoError='',identified=0,identificationLimited=false;
        if(settings.info){
            progress(units.length,'Информационная память');
            infoState='notread';units.forEach(u=>u.info=Diagnostic.unit(u.address,null,true));
            try{
                const info=await queue.run(active,link=>link.readAll(0x19,[0x17,mask,1],{onReply:(addr,n)=>progress(n)}));
                if(info.ended==='transport')throw Error(info.why||'Ошибка чтения информационной памяти');
                const add=(addr,raw)=>{let unit=units.find(u=>u.address===addr);if(!unit){unit=Diagnostic.unit(addr,null);units.push(unit);}unit.info=Diagnostic.unit(addr,raw,true);};
                info.replies.forEach((raw,address)=>add(address,Array.from(raw)));info.pending.forEach(address=>add(address,[0x7F,0x19,0x78]));
                infoState=info.ended==='deadline'||!info.replies.size||units.some(u=>!u.info||u.info.state!=='read')?'partial':'read';
            }catch(e){infoError=e.message;ctx.log.warn('Unified info memory: '+e.message);}
        }
        // Text/identity enrichment is optional. A failed lookup never discards raw DTCs.
        for(const unit of units){
            if(!active())throw Error('Источник изменён');let identity=null;
            try{
                if(texts.available()&&(unit.faults.length||unit.other.length||unit.info&&(unit.info.faults.length||unit.info.other.length))){
                    if(identified<16){identified++;progress(units.length,'Описание блока '+identified);identity=await queue.run(active,link=>link.physical(unit.address,0x22,[0xF1,0x50],1500));}else identificationLimited=true;
                }
                texts.decorate(unit,identity);
            }catch(e){unit.textError=e.message;try{texts.decorate(unit,null);}catch(ignore){}ctx.log.warn('Unified DTC text: '+e.message);}
        }
        units.sort((a,b)=>b.faults.length-a.faults.length||a.address-b.address);
        ctx.log.info('Unified diagnostics: '+units.length+' responders; ended='+result.ended);
        if(!active())throw Error('Чтение отменено');
        const report={ended:result.ended,units,infoState,infoError,identificationLimited};
        const receipt=Object.freeze({});latest={receipt,started,used:false,report:JSON.parse(JSON.stringify(report))};
        return Object.assign(report,{receipt});
    },close(){queue.close();}};
};
