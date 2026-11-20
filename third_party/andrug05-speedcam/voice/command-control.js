'use strict';
// AudioManager inventories are methods, not SOME/IP properties. In particular,
// a missing property must never be interpreted as an empty (unoccupied) route.
const LISTS={
 listOfMainSources:{method:'getListMainSources',fields:['listMainSources','listSources','listOfMainSources'],id:'sourceID'},
 listOfMainSinks:{method:'getListMainSinks',fields:['listMainSinks','listSinks','listOfMainSinks'],id:'sinkID'},
 listOfMainConnections:{method:'getListMainConnections',fields:['listConnections','listMainConnections','listOfMainConnections'],id:'mainConnectionID'}
};
function decode(reply,key){
 const spec=LISTS[key];if(!spec)throw Error('Unknown BMW inventory: '+key);
 if(reply&&reply.amError!==undefined&&reply.amError!==0&&reply.amError!=='E_OK')throw Error(spec.method+': '+String(reply.amError));
 let rows=Array.isArray(reply)?reply:null;
 if(!rows&&reply){for(const field of spec.fields.concat(['value'])){if(Array.isArray(reply[field])){rows=reply[field];break;}}}
 if(!rows)throw Error(spec.method+': missing list in BMW response');
 if(rows.some(r=>!r||!Number.isInteger(r[spec.id])||(key==='listOfMainConnections'&&(!Number.isInteger(r.sourceID)||!Number.isInteger(r.sinkID)))))throw Error(spec.method+': malformed BMW list');
 return rows;
}
function readList(cc,key,timeout){
 const spec=LISTS[key];if(!spec)return Promise.reject(Error('Unknown BMW inventory: '+key));
 const ms=timeout||3000;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error(spec.method+': BMW timeout')),ms+100);
  Promise.resolve().then(()=>cc.callMethod(spec.method,{},ms)).then(reply=>decode(reply,key)).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
 });
}
module.exports={readList,decode};
