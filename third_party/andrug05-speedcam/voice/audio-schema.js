'use strict';
// Minimal catalog adapter for the audio methods we use. IDs and wire types
// come from the vehicle, never a hard-coded table or shipped BMW catalog.
const fs=require('fs');
const CATALOG='/etc/oap/someip/someip-interfaces.json';
const COMMAND='org.genivi.am.commandinterface.CommandControl';
const ROUTING='org.genivi.am.routinginterface.RoutingControlObserver';
const INVENTORIES=['getListMainSources','getListMainSinks','getListMainConnections'];
const PRIMITIVES=/^(U?Int(8|16|32|64)|Boolean|Float|Double|Utf(8|16)D?|ByteBuffer)$/;
function extendAudioSchema(original,interfaceName,required,read){
 const base=original||{};
 const missing=required.filter(n=>!base.methods||!base.methods[n]);
 if(!missing.length)return base;
 let catalog;
 try{catalog=JSON.parse((read||fs.readFileSync)(CATALOG,'utf8'));}
 catch(e){throw Error('BMW audio catalog unavailable: '+e.message);}
 const iface=catalog.interfaces&&catalog.interfaces[interfaceName];
 if(!iface||!Number.isInteger(iface.serviceId)||!iface.version)throw Error('BMW audio interface absent: '+interfaceName);
 if(base.serviceId!==undefined&&base.serviceId!==iface.serviceId)throw Error('BMW audio service ID mismatch');
 if(base.version!==undefined&&JSON.stringify(base.version)!==JSON.stringify(iface.version))throw Error('BMW audio interface version mismatch');
 const types=catalog.datatypes||{};
 function convert(node,trail){
  if(trail.length>40)throw Error('BMW audio type nesting limit');
  if(typeof node==='string'){
   if(PRIMITIVES.test(node)){const p={t:node};if(/^Utf16/.test(node))p.bo=true;return p;}
   if(trail.indexOf(node)>=0||!Object.prototype.hasOwnProperty.call(types,node))throw Error('BMW audio type missing/cyclic: '+node);
   return convert(types[node],trail.concat(node));
  }
  if(!node||typeof node!=='object')throw Error('Invalid BMW audio type');
  switch(node.type){
   case 'typedef':return convert(node.dataRef,trail);
   case 'struct':
    if(!Array.isArray(node.members))throw Error('BMW audio struct members missing');
    return {t:'Struct',e:node.members.map(m=>parameter(m,trail))};
   case 'enum':{
    let entries={};
    if(node.extends){const parent=convert(node.extends,trail);if(parent.t!=='Enum')throw Error('Invalid BMW enum parent');entries=parent.e;}
    const value={t:'Enum',e:Object.assign({},entries,node.items||{})};
    if(node.enumWidth!==undefined)value.w=node.enumWidth;
    if(!Object.keys(value.e).length)throw Error('Empty BMW audio enum');return value;
   }
   case 'array':return arrayOf(node,convert(node.dataRef,trail));
   default:throw Error('Unsupported BMW audio wire type: '+node.type);
  }
 }
 function arrayOf(node,element){
  if(node.arrayLengthWidth===0){if(!Number.isInteger(node.arrayMaxLength)||node.arrayMaxLength<0)throw Error('Invalid BMW fixed array');return {t:'ArrayF',l:node.arrayMaxLength,e:element};}
  const a={t:'ArrayD',e:element};
  if(node.arrayLengthWidth!==undefined&&node.arrayLengthWidth!==4)a.lw=node.arrayLengthWidth;
  if(node.arrayMinLength!==undefined)a.nl=node.arrayMinLength;
  if(node.arrayMaxLength!==undefined)a.xl=node.arrayMaxLength;return a;
 }
 function parameter(p,trail){
  if(!p||typeof p.name!=='string'||!p.name)throw Error('Invalid BMW audio parameter');
  let wire=convert(p.dataRef,trail);if(p.dimension)wire=arrayOf(p,wire);
  const result=Object.assign({n:p.name},wire);
  if(p.defaultValue!==undefined)result.d=p.defaultValue;
  if(p.bitWidth!==undefined)result.bw=p.bitWidth;return result;
 }
 function argumentsSchema(args){if(!Array.isArray(args))throw Error('BMW method arguments missing');return args.length?{t:'Struct',e:args.map(p=>parameter(p,[]))}:{};}
 const result=Object.assign({name:iface.name,serviceId:iface.serviceId,version:iface.version,instances:(catalog.instanceIDs||{})[interfaceName]||{}},base);
 result.methods=Object.assign({},base.methods||{});
 for(const name of missing){
  const method=iface.methods&&iface.methods[name];
  if(!method||!Number.isInteger(method.methodId)||method.methodId<0||method.methodId>65535)throw Error('BMW audio method absent/invalid: '+name);
  const entry={id:method.methodId,schema:argumentsSchema(method.inputs||[])};
  if(method.outputs!==undefined)entry.retSchema=argumentsSchema(method.outputs);
  if(method.reliable)entry.reliable=true;
  result.methods[name]=entry;
 }
 return result;
}
// Export only audio-control declarations, never the entire vehicle catalog.
// A method's presence is not proof of its semantics or independence from the knob.
function volumeCapabilities(raw){
 const catalog=JSON.parse(raw),interfaces={},types={},pending=[];
 const addRefs=value=>{
  if(!value||typeof value!=='object')return;
  for(const k of Object.keys(value)){
   if(['dataRef','extends'].includes(k)&&typeof value[k]==='string')pending.push(value[k]);
   else if(typeof value[k]==='object')addRefs(value[k]);
  }
 };
 for(const name of Object.keys(catalog.interfaces||{})){
  if(!/^org\.genivi\.am\./.test(name))continue;
  const source=catalog.interfaces[name],entry={serviceId:source.serviceId,version:source.version,methods:{}};
  for(const key of Object.keys(source.methods||{})){
   if(!/volume|gain|attenuat|focus|priority|soundpropert|sourceclass|sinkclass/i.test(key))continue;
   entry.methods[key]=source.methods[key];addRefs(entry.methods[key]);
  }
  if(Object.keys(entry.methods).length)interfaces[name]=entry;
 }
 while(pending.length){
  const name=pending.shift();if(Object.prototype.hasOwnProperty.call(types,name)||!Object.prototype.hasOwnProperty.call(catalog.datatypes||{},name))continue;
  if(Object.keys(types).length>=80)throw Error('Audio volume type inventory exceeds limit');
  types[name]=catalog.datatypes[name];addRefs(types[name]);
 }
 const result={readOnly:true,knobIsolationConfirmed:false,interfaces,datatypes:types,
  note:'Declarations only. No master volume lock, source volume change or input interception performed.'};
 if(Buffer.byteLength(JSON.stringify(result))>49152)throw Error('Audio volume declarations exceed 48 KiB');
 return result;
}
module.exports={extendAudioSchema,CATALOG,COMMAND,ROUTING,INVENTORIES,volumeCapabilities};
