'use strict';
// Read-only index of the confirmed-operation journals (DTC clear, CBS reset) for the History page.
// Never resumes, repeats or rewrites an operation; an unreadable journal is listed as such.
const fs=require('fs'),path=require('path');
const NAME=/^(dtc-clear|cbs-reset)-([0-9]{10,16})-[a-f0-9]+$/;
const CBS={verified:'подтверждено',accepted:'принято, не проверено',refused:'отклонено KOMBI',unconfirmed:'не подтверждено','not-sent':'не отправлено'};
function describe(kind,record){
    if(kind==='dtc-clear'){
        // upstream Fault Scanner's clear (2026-11-03): a unit is cleared or not-cleared; the clear runs to the end
        const r=Array.isArray(record.results)?record.results:[],n=s=>r.filter(x=>x.state===s).length;
        const open=record.phase!=='finished';
        return {title:'Стирание DTC · '+n('cleared')+' / '+r.length+' блоков стёрто',detail:(n('not-cleared')?'не стёрто '+n('not-cleared')+' · ':'')+(record.phase==='finished'?'завершено':'не завершено'),open};
    }
    const open=record.phase==='dispatching'||record.result==='unconfirmed';
    return {title:'Сброс CBS · '+String(record.name||('0x'+Number(record.item).toString(16))).slice(0,30),detail:open&&record.phase==='dispatching'?'результат не записан':CBS[record.result]||String(record.result||record.phase||'неизвестно'),open};
}
module.exports=function operations(dataDir,limit){
    const dir=path.join(dataDir,'operations');let names;
    try{names=fs.readdirSync(dir);}catch(e){return {items:[],error:e.code==='ENOENT'?'':'Каталог operations не прочитан'};}
    const items=names.map(n=>{const m=NAME.exec(n);return m?{dir:n,kind:m[1],at:Number(m[2])}:null;}).filter(Boolean).sort((a,b)=>b.at-a.at).slice(0,limit||40);
    items.forEach(it=>{
        try{const record=JSON.parse(fs.readFileSync(path.join(dir,it.dir,'result.json'),'utf8'));Object.assign(it,describe(it.kind,record));}
        catch(e){Object.assign(it,{title:(it.kind==='dtc-clear'?'Стирание DTC':'Сброс CBS')+' · журнал не прочитан',detail:'проверьте operations/'+it.dir,open:true});}
    });
    return {items,error:''};
};
module.exports.describe=describe;
