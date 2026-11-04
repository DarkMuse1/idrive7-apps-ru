'use strict';
const Q=require('./kit/quality');
function values(v,key,depth){
    if(!v||typeof v!=='object'||(depth||0)>10)return [];
    if(Object.prototype.hasOwnProperty.call(v,key))return [v[key]];
    return Object.keys(v).reduce((a,k)=>a.concat(values(v[k],key,(depth||0)+1)),[]);
}
class Comfort {
    constructor(ctx){
        this.store=new Q.Store();this.subs=[];this.closed=false;const groups={};
        const def=(key,iface,field,member,convert)=>{
            this.store.define(key,{provider:iface,source:'someip:'+field,stale_ms:5000,decode:raw=>{const found=values(raw,member);return found.length?convert(found):{invalid:'missing field'};}});
            (groups[iface]=groups[iface]||{})[field]=v=>{if(!this.closed)this.store.put(key,v);};
        };
        const booleans=a=>a.every(v=>typeof v==='boolean')?{value:a.some(v=>v)?1:0}:{invalid:'expected boolean states'};
        const cm='de.bmw.infotainment.climate.climatemaster.ClimateMaster';
        def('system',cm,'statusClimateSystemOn','airConditioningOn',booleans);def('ac',cm,'statusAirCondAC','acButton',booleans);
        const gateway='de.bmw.infotainment.climate.Climate2';
        def('gatewayAc',gateway,'statusACFront','statusAircon',a=>{const raw=a[0];return a.length===1&&[0,1,'KLIMAANLAGE_EIN','KLIMAANLAGE_AUS'].indexOf(raw)>=0?{value:raw===1||raw==='KLIMAANLAGE_EIN'?1:0}:{invalid:'unknown gateway AC state'};});
        def('gatewaySystem',gateway,'statusAirConditionDRStatus','statusBlowerSettingDR',a=>a.length===1&&Number.isFinite(a[0])&&a[0]>=0&&a[0]<255?{value:a[0]>0?1:0}:{invalid:'unknown blower state'});
        ['DR','PS','DRR','PSR'].forEach(pos=>def(pos,'de.bmw.infotainment.climate.Climate','statusSeatHeating'+pos,'statusSeatHeater'+pos,a=>a.length===1&&typeof a[0]==='number'&&a[0]>=0&&a[0]<15?{value:[0,.04,.07,.1][Math.min(3,Math.floor(a[0]))]}:{invalid:'unknown seat level'}));
        def('wheel','de.bmw.body.steeringwheelcomfort.SteeringWheelClimate','heatingState','heating',a=>a.length===1&&typeof a[0]==='boolean'?{value:a[0]?.06:0}:{invalid:'unknown wheel heater'});
        Object.keys(groups).forEach(iface=>ctx.signals.watch(iface,'1',groups[iface],ctx.log,{onAvailable:up=>{if(!this.closed)this.store.provider(iface,up);}}).then(sub=>{if(this.closed){sub.shutdown();return;}this.subs.push(sub);if(sub.error||!sub.available)this.store.provider(iface,false,sub.error);}).catch(e=>{if(!this.closed)this.store.provider(iface,false,String(e));ctx.log.warn('Energy comfort: '+e.message);}));
    }
    copyTo(feed,now){
        if(feed.mode!=='vehicle')return;const get=k=>{const s=this.store.getLive(k);return s.quality==='live'?s.value:null;};
        const zoneSystem=get('system'),zoneAc=get('ac'),sys=zoneSystem===null?get('gatewaySystem'):zoneSystem,ac=zoneAc===null?get('gatewayAc'):zoneAc;
        const climate=ac===1?2:sys===0?0:sys===1&&ac===0?1:null;
        const heaters=['DR','PS','DRR','PSR','wheel'].map(get),comfort=heaters.every(x=>x!==null)?heaters.reduce((a,x)=>a+x,0):null;
        feed.put('climate',climate,climate===null?'unavailable':'live',now,'computed:ClimateMaster/Climate2');feed.put('comfortKw',comfort,comfort===null?'unavailable':'live',now,'estimate:seat and wheel heater levels');
    }
    /** Climate state and heater LEVELS for the eDrive climate page (levels from the kW table, 0..3). */
    snapshot(){
        const get=k=>{const s=this.store.getLive(k);return s.quality==='live'?s.value:null;},lvl=v=>v===null?null:[0,.04,.07,.1].indexOf(v);
        const zoneSystem=get('system'),zoneAc=get('ac'),sys=zoneSystem===null?get('gatewaySystem'):zoneSystem,ac=zoneAc===null?get('gatewayAc'):zoneAc;
        const wheel=get('wheel');
        return {system:sys,ac,seats:{DR:lvl(get('DR')),PS:lvl(get('PS')),DRR:lvl(get('DRR')),PSR:lvl(get('PSR'))},wheel:wheel===null?null:wheel>0};
    }
    close(){this.closed=true;this.subs.forEach(s=>s.shutdown());}
}
module.exports=Comfort;
