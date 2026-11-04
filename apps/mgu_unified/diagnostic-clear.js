'use strict';
// Fault memory clear as upstream Fault Scanner does it (idrive7-apps apps/dtc_scanner/main.js doClear + clearUnit;
// customer decisions 2026-11-03: its checks and conditions, none of MGU Tools' own - no parked gate, no scan-age
// gate, no two-step grant):
//   «Стереть ошибки» arms for 5 s; a second press within them clears the units of the last scan that have faults
//   in their fault memory. First all units at once (functional 14 FF FF FF to 0xDF, as the workshop tester clears:
//   the engine, e-motor and brake units refuse the physical request with the engine off but take this one), then
//   each listed unit that did not confirm that one (clearUnit): 14 FF FF FF; no answer -> asked once more; refused
//   for its session or conditions (7F 14 with 22, 31, 33, 7E or 7F) -> extended session 10 03, asked again, back to
//   the default session 10 01. Then the faults are read again (after 1.5 s); what came back at once is named.
//   While a read or a clear runs a press does nothing (upstream: busy). DEMO: simulated as upstream (no request).
// What was sent and answered is recorded in operations/dtc-clear-<time>-<id>/result.json (kit/store, atomic): a
// record for the History page and the log, never a condition - a record that cannot be written stops nothing.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const clock=require('./kit/clock'),Store=require('./kit/store');
const CONFIRM_MS=5000;
const RETRY_NRC=[0x22,0x31,0x33,0x7E,0x7F];
const NRC={0x10:'общий отказ',0x11:'сервис не поддерживается',0x12:'подфункция не поддерживается',0x13:'неверная длина',0x21:'занят',
    0x22:'условия не выполнены',0x31:'вне диапазона',0x33:'доступ запрещён',0x7E:'не поддерживается в этой сессии',0x7F:'не поддерживается в этой сессии'};
const hex=n=>{const s=Number(n).toString(16).toUpperCase();return s.length<2?'0'+s:s;};
const sleep=ms=>ms>0?new Promise(r=>clock.setTimeout(r,ms)):Promise.resolve();
function mkdir(dir){if(fs.existsSync(dir))return;mkdir(path.dirname(dir));fs.mkdirSync(dir);}
const clone=v=>JSON.parse(JSON.stringify(v));
/** upstream clearUnit's reason for a unit not cleared (r: its last reply, null: none) */
function why(r){
    if(!r)return 'нет ответа';
    if(r[0]===0x7F)return r[2]===0x22?'отказ сейчас (двигатель работает? только зажигание)':NRC[r[2]]||'NRC '+hex(r[2]);
    return 'ответ '+r.map(hex).join(' ');
}
class Clear {
    constructor(ctx,scanner,options){
        this.ctx=ctx;this.scanner=scanner;this.o=options||{};this.state='idle';this.armedAt=0;this.message='';this.results=[];this.operation=null;this.closed=false;
        this.settle=typeof this.o.settleMs==='number'?this.o.settleMs:1500;
        this.demoStep=typeof this.o.demoStepMs==='number'?this.o.demoStepMs:400;
    }
    /** the units of the report with faults in their fault memory (upstream: e.dtcs.some(d => d.mem === 'fault')) */
    targets(report){
        return report&&Array.isArray(report.units)?report.units.filter(u=>u.state==='read'&&u.faults&&u.faults.length).map(u=>({addr:u.address,faults:u.faults.length})):[];
    }
    busy(){return this.state==='clearing'||!!(this.o.reading&&this.o.reading());}
    /** The «Стереть ошибки» press: the first arms for 5 s, the second within them clears. true: the clear started. */
    press(){
        if(this.closed||this.busy())return false;
        const report=this.o.report&&this.o.report(),targets=this.targets(report);
        if(!targets.length){this.state='idle';this.message=report?'Нечего стирать':'Сначала прочитайте ошибки, затем стирайте';return false;}
        const now=clock.now();
        if(this.state!=='armed'||now<this.armedAt||now-this.armedAt>CONFIRM_MS){
            this.state='armed';this.armedAt=now;this.message='Будет очищено блоков: '+targets.length+' — нажмите ещё раз в течение 5 с';return false;
        }
        this.state='clearing';this.armedAt=0;
        this.run(targets,report).catch(e=>{this.ctx.log.warn('clear: '+(e&&e.message||e));this.state='idle';this.message='Стирание не завершено: '+(e&&e.message||e);});
        return true;
    }
    /** the arm lapses after 5 s (upstream's timer) */
    sync(){if(this.state==='armed'&&(clock.now()<this.armedAt||clock.now()-this.armedAt>CONFIRM_MS)){this.state='idle';this.message='';}}
    /** anything else (BACK, another page or tab) disarms; a clear that runs is not stopped (upstream neither) */
    cancel(){if(this.state==='armed'){this.state='idle';this.message='';}}
    save(rec){
        if(!rec)return;
        try{if(!Store.save(rec.file,rec.value,{log:this.ctx.log}))this.ctx.log.warn('clear: operations record not written');}catch(e){this.ctx.log.warn('clear: operations record: '+e.message);}
    }
    record(demo,targets){
        if(demo)return null;
        try{
            const dir=path.join(this.ctx.dataDir,'operations','dtc-clear-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'));mkdir(dir);this.operation=path.basename(dir);
            return {file:path.join(dir,'result.json'),value:{schema:2,at:Date.now(),phase:'clearing',targets:clone(targets),results:this.results}};
        }catch(e){this.ctx.log.warn('clear: operations record: '+e.message);return null;}
    }
    async run(targets,report){
        const demo=this.o.mode&&this.o.mode()==='demo'||report.source==='demo';
        this.results=targets.map(t=>({addr:t.addr,state:'pending',text:'Ожидает',steps:[]}));this.operation=null;
        const rec=this.record(demo,targets);this.save(rec);
        let ok=0;const failed=[],cleared=[];
        if(demo){
            for(const r of this.results){this.message='Стирание ECU '+hex(r.addr)+'…';await sleep(this.demoStep);ok++;cleared.push(r.addr);Object.assign(r,{state:'cleared',text:'DEMO'});}
        }else{
            await this.scanner.queue.clear(()=>!this.closed,async api=>{
                this.message='Стирание всех блоков…';
                let all=new Map();
                try{all=await api.functional(0x14,[0xFF,0xFF,0xFF],{idleMs:5000});}catch(e){this.ctx.log.warn('clear all: '+e.message);}
                this.ctx.log.info('clear all: '+Array.from(all.values()).filter(u=>u&&u[0]===0x54).length+' units cleared');
                for(const r of this.results){
                    const a=all.get(r.addr);
                    if(a&&a[0]===0x54){ok++;cleared.push(r.addr);Object.assign(r,{state:'cleared',text:'Блок подтвердил стирание (общий запрос)'});continue;}
                    this.message='Стирание ECU '+hex(r.addr)+'…';
                    try{
                        const res=await this.clearUnit(api,r);
                        if(res.ok){ok++;cleared.push(r.addr);Object.assign(r,{state:'cleared',text:'Блок подтвердил стирание'+(res.extended?' · в расширенной сессии':res.again?' · со второго запроса':'')});}
                        else{failed.push('ECU '+hex(r.addr)+': '+res.why);Object.assign(r,{state:'not-cleared',text:'Не стёрто: '+res.why});}
                    }catch(e){this.ctx.log.warn('clear '+hex(r.addr)+': '+e.message);failed.push('ECU '+hex(r.addr)+': '+e.message);Object.assign(r,{state:'not-cleared',text:'Не стёрто: '+e.message});}
                    this.save(rec);
                }
            });
        }
        this.ctx.log.info('cleared '+ok+'/'+targets.length+(failed.length?' - not: '+failed.join('; '):''));
        if(rec){rec.value.phase='finished';rec.value.finishedAt=Date.now();this.save(rec);}
        this.state='idle';
        const keep='Стёрто блоков: '+ok+' из '+targets.length;
        this.message=keep+' — повторное чтение';
        await sleep(this.settle);
        let after=null;
        try{if(this.o.rescan)await this.o.rescan();after=this.o.report&&this.o.report();}catch(e){this.ctx.log.warn('clear: rescan: '+e.message);}
        // what the clear left: units that refused, and faults back at once (still present: the cause is still there)
        const back=after&&!demo?this.targets(after).filter(t=>cleared.indexOf(t.addr)>=0).map(t=>'ECU '+hex(t.addr)):[];
        if(back.length)this.ctx.log.info('faults back at once after the clear: '+back.join(', '));
        this.message=failed.length?'Не стёрто — '+failed.join('; '):back.length?'Стёрто; сразу вернулись (неисправность сохраняется): '+back.join(', '):keep;
        return ok;
    }
    /**
     * One unit, upstream clearUnit (14 FF FF FF, 8 s; session changes 3 s): no answer -> asked once more; refused for
     * its session or conditions -> 10 03, asked again (no answer there: the first refusal stands), then 10 01.
     * Every request and its reply go to the unit's steps in the operations record.
     */
    async clearUnit(api,r){
        const addr=r.addr,step=(request,uds)=>r.steps.push({request,reply:uds?uds.map(hex).join(' '):null});
        const ask=async()=>{const u=await api.physical(addr,0x14,[0xFF,0xFF,0xFF],8000,x=>x[0]===0x54||(x[0]===0x7F&&x[1]===0x14));step('14 FF FF FF',u);return u;};
        const session=async n=>{const u=await api.physical(addr,0x10,[n],3000,x=>(x[0]===0x50&&x[1]===n)||(x[0]===0x7F&&x[1]===0x10));step('10 '+hex(n),u);return u;};
        let res=await ask(),again=false,extended=false;
        if(!res){res=await ask();again=true;}
        if(res&&res[0]===0x7F&&RETRY_NRC.indexOf(res[2])>=0){
            const first=res,ext=await session(0x03);
            if(ext&&ext[0]===0x50){
                extended=true;
                res=(await ask())||first;
                await session(0x01);
            }
            this.ctx.log.info('clear '+hex(addr)+': refused ('+hex(first[2])+') - extended session: '+(ext?(ext[0]===0x50?'yes':'refused'):'no answer')+', then '+(res[0]===0x54?'cleared':'still refused'));
        }
        if(res&&res[0]===0x54)return {ok:true,again,extended};
        const reason=why(res);
        this.ctx.log.warn('clear '+hex(addr)+': '+reason);
        return {ok:false,why:reason,again,extended};
    }
    view(){
        this.sync();
        return {available:true,state:this.state,armed:this.state==='armed',busy:this.busy(),message:this.message,results:clone(this.results),operation:this.operation};
    }
    close(){this.closed=true;if(this.state==='armed')this.state='idle';}
}
module.exports=Clear;module.exports.why=why;module.exports.RETRY_NRC=RETRY_NRC;
