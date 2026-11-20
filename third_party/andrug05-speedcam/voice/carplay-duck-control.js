'use strict';
// No guessed BMW property IDs or sink-wide setVolume. Only explicitly named,
// source-scoped dB offsets can be tested. Unknown OEM semantics stay read-only.
const {extendAudioSchema,COMMAND}=require('./audio-schema');
const METHODS=['getListMainSourceSoundProperties','setMainSourceSoundProperty'];
const UNITS={MSP_VOLUME_OFFSET_DB:1,MSP_SOURCE_VOLUME_OFFSET_DB:1,MSP_VOLUME_OFFSET_01DB:10,MSP_SOURCE_VOLUME_OFFSET_01DB:10};
function definition(base,read){
 const d=extendAudioSchema(base,COMMAND,METHODS,read),get=d.methods[METHODS[0]],set=d.methods[METHODS[1]];
 const gi=get.schema.e||[],si=set.schema.e||[],out=get.retSchema&&get.retSchema.e||[];
 if(gi.length!==1||gi[0].n!=='sourceID'||gi[0].t!=='UInt16'||si.length!==2)throw Error('Unsupported source-property argument schema');
 const id=si.find(x=>x.n==='sourceID'),p=si.find(x=>x.n==='soundProperty');
 const list=out.find(x=>['listSourceProperties','listMainSourceSoundProperties','listSoundProperties'].includes(x.n));
 const error=out.find(x=>x.n==='amError'),setError=(set.retSchema&&set.retSchema.e||[]).find(x=>x.n==='amError');
 if(!id||id.t!=='UInt16'||!p||p.t!=='Struct'||!list||!['ArrayD','ArrayF'].includes(list.t)||!error||!setError)throw Error('Unsupported source-property reply schema');
 const shape=x=>x&&x.t==='Struct'&&x.e&&x.e.length===2&&x.e.some(v=>v.n==='value'&&v.t==='Int16')&&x.e.some(v=>v.n==='type'&&v.t==='Enum');
 if(!shape(p)||!shape(list.e))throw Error('Source property units/types are not declared');
 const se=p.e.find(x=>x.n==='type').e,re=list.e.e.find(x=>x.n==='type').e,candidates=[];
 for(const name of Object.keys(UNITS))if(Number.isInteger(se[name])&&se[name]===re[name])candidates.push({name,type:se[name],units:UNITS[name]});
 return {schema:d,candidates,listField:list.n,propertyNames:re};
}
function createControl(proxy,spec){
 const call=(name,args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('BMW source-property timeout: '+name)),3100);Promise.resolve().then(()=>proxy.callMethod(name,args,3000)).then(r=>{clearTimeout(timer);resolve(r);},e=>{clearTimeout(timer);reject(e);});});
 const check=r=>{if(!r||!(r.amError===0||r.amError==='E_OK'))throw Error('BMW source-property command rejected: '+String(r&&r.amError));return r;};
 return {
  candidates:spec.candidates,
  async read(sourceID){
   const rows=check(await call(METHODS[0],{sourceID}))[spec.listField];
   if(!Array.isArray(rows)||rows.length>256||rows.some(p=>!p||!Number.isInteger(p.value)||p.value<-32768||p.value>32767))throw Error('Invalid source-property inventory');
   return rows.map(p=>{const type=typeof p.type==='string'?spec.propertyNames[p.type]:p.type;
    if(!Number.isInteger(type))throw Error('Unknown source-property type');
    return {type,value:p.value,name:Object.keys(spec.propertyNames).find(k=>spec.propertyNames[k]===type)||String(type)};});
  },
  async write(sourceID,property,value){
   if(!spec.candidates.some(p=>p.type===property.type&&p.name===property.name&&p.units===property.units)||!Number.isInteger(value)||value<-60*property.units||value>12*property.units)throw Error('Unapproved source volume offset');
   check(await call(METHODS[1],{sourceID,soundProperty:{type:property.name,value}}));
  },
  async close(){if(proxy.shutdown)await proxy.shutdown();}
 };
}
module.exports={definition,createControl,UNITS};
