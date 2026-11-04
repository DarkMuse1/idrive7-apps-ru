'use strict';
// Source field names and scaling: apps/car_vitals/main.js + app.json 2.13.2.
// Uses the same quality store as Car; no direct native setters or diagnostic writes.
const Q=require('./kit/quality');
const FileStore=require('./kit/store'),path=require('path');
class ExtraTelemetry {
    constructor(ctx){
        this.store=new Q.Store();this.subs=[];this.closed=false;const groups={};
        const def=(key,iface,field,member,scale,range,move)=>{
            const decode=Q.scaled(scale);let initial=null,seen=false;
            this.store.define(key,{source:'someip:'+iface.split('.').pop()+'.'+field,provider:iface,stale_ms:5000,decode:raw=>{
                const d=decode(raw);if(d.invalid!==undefined)return d;
                if(d.value<range[0]||d.value>range[1])return {invalid:'outside source range'};
                if(move){if(initial===null)initial=d.value;if(Math.abs(d.value-initial)>=move)seen=true;if(!seen)return {invalid:'waiting for changing source value'};}
                return d;
            }});
            const fields=groups[iface]=groups[iface]||{};(fields[field]=fields[field]||[]).push(v=>this.store.put(key,v&&typeof v==='object'?v[member]:undefined));
        };
        const env='de.bmw.infrastructure.EnvironmentalInformation',fes='de.bmw.infotainment.drivingexcitement.FES',tpms='de.bmw.infotainment.vehicle.TPMS';
        def('ambient',env,'ExteriorTemperature','temperatureExterior',{factor:.5,offset:-40,invalid:255},[-50,60]);
        // These two scalings are tentative in the upstream config. Keep its change
        // gate; UI labels them as the car's indicated values, not calibrated sensors.
        def('boost',fes,'statusSwitchDriveDynamicSport2','displayBoostPressure',{factor:.01,offset:0,invalid:255},[-1,4],.03);
        def('powerPct',fes,'statusVehicleDynamicEngine','displaySportEnginePower',{factor:1,invalid:255},[0,100]);
        def('torquePct',fes,'statusVehicleDynamicEngine','displaySportEngineTorque',{factor:1,invalid:255},[0,100]);
        def('transmission','de.bmw.infrastructure.analytics.BasicDataSet','basicDataSet','valueTemperatureTransmissionOil',{factor:1,offset:-48,invalid:255},[-40,160],1);
        // TPMS values use the vehicle's display units. Keep their original receive time in the quality
        // store; converting again after a unit notification must not revive an old/disconnected sample.
        const wheels=['FL','FR','RL','RR'],pressUnits={1:'BAR',2:'KPA',3:'PSI'},tempUnits={1:'C',2:'F'};
        const validUnit=(map,v)=>Object.keys(map).some(k=>map[k]===v);
        const unit=(map,v)=>(typeof v==='string'||typeof v==='number')?
            (Object.prototype.hasOwnProperty.call(map,v)?map[v]:validUnit(map,v)?v:null):null;
        const unitsFile=ctx.dataDir?path.join(ctx.dataDir,'tyre-units.json'):null;
        const saved=unitsFile?FileStore.load(unitsFile,{log:ctx.log,fallback:{},valid:v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&
            (v.pressure===undefined||validUnit(pressUnits,v.pressure))&&(v.temperature===undefined||validUnit(tempUnits,v.temperature))}):{};
        let pressure=saved&&saved.pressure||null,temperature=saved&&saved.temperature||null,suspectedPsi=false;
        const learn=(p,t)=>{
            if((!p||p===pressure)&&(!t||t===temperature))return;
            pressure=p||pressure;temperature=t||temperature;
            if(unitsFile)FileStore.save(unitsFile,Object.assign({},pressure?{pressure}: {},temperature?{temperature}: {}),{log:ctx.log});
        };
        const window=v=>v>=.5&&v<=6?'BAR':v>=7&&v<60?'PSI':v>=60&&v<=600?'KPA':null;
        const pressureScale=Q.scaled({factor:.1,invalidFrom:65532});
        const infer=(msg,prefix)=>{
            const vals=wheels.map(w=>pressureScale(msg&&msg[prefix+w+'H'])).filter(d=>d.invalid===undefined).map(d=>d.value);
            suspectedPsi=vals.some(v=>window(v)==='PSI');
            if(pressure)return; // a flat PSI tyre must never become 5 BAR, even if all tyres deflate
            const votes={},need=vals.length===2?2:3;
            vals.forEach(v=>{const u=window(v);if(u)votes[u]=(votes[u]||0)+1;});
            learn(Object.keys(votes).filter(u=>votes[u]>=need)[0],null);
        };
        this.tyreDecode={};
        wheels.forEach(w=>{
            def('tire'+w,tpms,'statusTyrePressure','actualValuePressureTyre'+w+'H',{factor:.1,invalidFrom:65532},[0,600]);
            def('tireTemp'+w,tpms,'statusTyreTemperature','actualValueTemperatureTyre'+w+'H',{factor:1,offset:-40,invalid:65535},[-40,302]);
            def('tireTarget'+w,tpms,'statusTargetTyrePressure','targetPressureTyre'+w+'H',{factor:.1,invalidFrom:65532},[0,600]);
            ['tire','tireTarget'].forEach(prefix=>this.tyreDecode[prefix+w]=v=>{
                const u=pressure||window(v),factor={BAR:1,KPA:.01,PSI:1/14.5038}[u],b=factor?v*factor:null;
                return b!==null&&b>=(prefix==='tire'?.5:1)&&b<=6?b:null;
            });
            this.tyreDecode['tireTemp'+w]=v=>{
                const u=temperature||(pressure==='PSI'||(!pressure&&suspectedPsi)?null:'C');
                const c=u==='F'?(v-32)*5/9:u==='C'?v:null;
                return c!==null&&c>=-40&&c<=150?c:null;
            };
        });
        groups[tpms].statusTyrePressure.unshift(v=>infer(v,'actualValuePressureTyre'));
        groups[tpms].statusTargetTyrePressure.unshift(v=>infer(v,'targetPressureTyre'));
        groups['de.bmw.infotainment.vehicle.Vehicle']={statusNewCurrentUnitsStatusExt:[v=>{
            if(ctx.log.info)ctx.log.info('raw car units: '+JSON.stringify(v));
            learn(unit(pressUnits,v&&v.unitOfMeasurementAirPressure),unit(tempUnits,v&&v.unitOfMeasurementTemperature));
        }]};
        Object.keys(groups).forEach(iface=>{
            const handlers={};Object.keys(groups[iface]).forEach(field=>handlers[field]=v=>{if(!this.closed)groups[iface][field].forEach(fn=>fn(v));});
            ctx.signals.watch(iface,'1',handlers,ctx.log,{onAvailable:up=>{if(!this.closed)this.store.provider(iface,up);}}).then(sub=>{
                if(this.closed){sub.shutdown();return;}this.subs.push(sub);if(sub.error||!sub.available)this.store.provider(iface,false,sub.error);
            }).catch(e=>{if(!this.closed)this.store.provider(iface,false,String(e));ctx.log.warn('extra telemetry: '+e.message);});
        });
    }
    copyTo(feed){if(feed.mode!=='vehicle')return;this.store.keys().forEach(k=>{
        const s=this.store.getLive(k);let value=s.value,quality=s.quality;
        if(quality==='live'&&this.tyreDecode[k]){value=this.tyreDecode[k](value);if(value===null)quality='invalid';}
        feed.put(k,value,quality,s.received_at_monotonic||0,s.source);
    });}
    close(){if(this.closed)return;this.closed=true;this.subs.forEach(s=>s.shutdown());}
}
module.exports=ExtraTelemetry;
