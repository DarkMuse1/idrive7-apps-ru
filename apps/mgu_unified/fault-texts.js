'use strict';
const path=require('path'),Pack=require('./kit/pack'),Texts=require('./dtc-texts'),known=require('./dtc-known');
module.exports=function faultTexts(){
    // One lazy pack handle per process; don't repeatedly open the 3.5 MB asset.
    let db=null,index=null,names=null;
    function load(){if(!db){db=Pack.open(path.join(__dirname,'dtc_db'));index=db.json('sgbd_index.json');names=db.json('unit_names.json');}}
    return {
        available(){load();return Object.keys(index).length>0;},
        decorate(unit,raw){
            load();const address=unit.address.toString(16).toUpperCase().padStart(2,'0');let id=null,variant=null;
            if(raw&&raw.length>=6&&raw[0]===0x62&&raw[1]===0xF1&&raw[2]===0x50){id=raw.slice(3,6).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');const candidate=index[address+' '+id];if(typeof candidate==='string'&&/^[A-Za-z0-9_]+$/.test(candidate))variant=candidate;}
            unit.identity={sgbdIndex:id,variant,raw:raw?Array.from(raw):null};
            unit.name=variant&&typeof names[variant]==='string'?Texts.ascii(names[variant]):'ECU '+address;
            const resolver=Texts.create({db,variant:()=>variant,known});
            const entries=unit.faults.concat(unit.other,unit.info?unit.info.faults.concat(unit.info.other):[]);
            entries.forEach(f=>f.description=resolver.describe(unit.address,f.code));
        }
    };
};
