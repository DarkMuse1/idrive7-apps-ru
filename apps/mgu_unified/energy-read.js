'use strict';
// Original eDrive candidates; plausible decoding is not proof of applicability
// to every SME. Raw responses and the selected DID stay in the readout report.
const spec=require('./battery-spec'),clock=require('./kit/clock');
function scalar(bytes,f){
    const at=f.at||0,n=f.bytes||1;if(at+n>bytes.length)return null;
    let value=0;for(let i=0;i<n;i++)value=value*256+bytes[at+i];
    if(f.signed&&value>=Math.pow(2,n*8-1))value-=Math.pow(2,n*8);
    value=value*(f.factor===undefined?1:f.factor)+(f.offset||0);
    return !Number.isFinite(value)||(f.min!==undefined&&value<f.min)||(f.max!==undefined&&value>f.max)?null:value;
}
function decode(raw,c){
    if(!Array.isArray(raw)||raw.some(b=>!Number.isInteger(b)||b<0||b>255))return null;
    const did=parseInt(c.did,16),obd=parseInt(c.obd,16),offset=c.obd?2:3;
    if(c.obd?(raw[0]!==0x41||raw[1]!==obd):(raw[0]!==0x62||raw[1]!==(did>>8)||raw[2]!== (did&255)))return null;
    const data=raw.slice(offset);
    if(c.array){
        const n=c.array.bytes||1;if(!data.length||data.length%n||data.length/n>256)return null;
        const cells=[];for(let at=0;at<data.length;at+=n)cells.push(scalar(data,Object.assign({},c.array,{at})));
        const good=cells.filter(v=>v!==null);if(!good.length||good.length<cells.length/2)return null;
        return {min:Math.min.apply(null,good),max:Math.max.apply(null,good),cells,valid:good.length,total:cells.length};
    }
    if(c.fields){const out={};Object.keys(c.fields).forEach(k=>out[k]=scalar(data,c.fields[k]));if(out.min!==undefined&&out.max!==undefined&&out.min!==null&&out.max!==null&&out.min>out.max)return null;return Object.keys(out).some(k=>out[k]!==null)?out:null;}
    const value=scalar(data,c);return value===null?null:{value};
}
const GROUPS=[
    ['hvVoltage',spec.fast.hvV,{v:'hvVoltage'},2000,6000],['hvCurrent',spec.fast.hvI,{a:'hvCurrent'},2000,6000],
    ['soc',spec.soc,{value:'soc'},15000,45000],['voltage',spec.v12,{value:'voltage'},15000,45000],
    ['soh',spec.soh,{value:'soh'},60000,180000],['cellV',spec.slow.cellV,{min:'cellMin',max:'cellMax'},30000,90000],
    ['cellT',spec.slow.cellT,{avg:'batteryTemp',min:'batteryTempMin',max:'batteryTempMax'},30000,90000]
];
class EnergyRead {
    constructor(queue,options){this.queue=queue;this.options=options||{};this.closed=false;this.busy=false;this.key=null;this.samples={};this.raws={};this.arrays={};this.next={};this.pick={};this.cursor=0;this.lastSave=0;this.error='';}
    clear(key){this.key=key;this.samples={};this.raws={};this.arrays={};this.next={};this.pick={};this.cursor=0;this.error='';}
    // eDrive read intervals (edrive 2.7.3 dropped the separate powerPoll, customer 2026-11-03): HV V/A, charge and
    // 12 V at poll; cells and temperatures at slowPoll.
    interval(name,base){const p=this.options.prefs&&this.options.prefs()||{};const s=name==='hvVoltage'||name==='hvCurrent'||name==='soc'||name==='voltage'?p.poll:name==='cellV'||name==='cellT'?p.slowPoll:null;return typeof s==='number'&&s>0?s*1000:base;}
    /** The full per-cell array where the battery unit actually sends one (DFA5), else null. */
    cells(now){const a=this.arrays.cellV;return a&&now>=a.at&&now-a.at<=a.ttl?{cells:a.cells.slice(),valid:a.valid,total:a.total,at:a.at,source:a.source}:null;}
    source(feed){const key=feed.mode+':'+feed.revision;if(key!==this.key)this.clear(key);}
    poll(feed,enabled,now){
        this.source(feed);if(this.closed||this.busy||!enabled||feed.mode!=='vehicle')return;
        // Setting "Hybrid system: no": only the 12 V battery is read (apps/edrive PAGES_12V).
        const hybridOff=this.options.prefs&&(this.options.prefs()||{}).hybrid==='no';
        let group=null;for(let n=0;n<GROUPS.length;n++){const i=(this.cursor+n)%GROUPS.length,g=GROUPS[i];if(hybridOff&&g[0]!=='voltage')continue;if(now>=(this.next[g[0]]||0)){group=g;this.cursor=(i+1)%GROUPS.length;break;}}
        if(!group)return;this.busy=true;const key=this.key,revision=feed.revision,name=group[0],candidate=group[1][this.pick[name]||0];
        const active=()=>!this.closed&&this.key===key&&feed.mode==='vehicle'&&feed.revision===revision;
        // One candidate per turn: a slow/unavailable ECU cannot hold the queue for
        // all seven voltage alternatives while a DTC scan is waiting.
        const every=this.interval(name,group[3]),ttl=Math.max(group[4],every*3);this.next[name]=now+every;
        return this.queue.run(active,async link=>{
            const did=parseInt(candidate.did,16),sid=candidate.obd?1:0x22,data=candidate.obd?[parseInt(candidate.obd,16)]:[did>>8,did&255];
            const raw=await link.physical(candidate.ecu===undefined?spec.ecu:candidate.ecu,sid,data,2500);
            if(!active())return;const at=clock.now(),bytes=raw?Array.from(raw):null,value=decode(bytes,candidate),source='UDS:'+ (candidate.ecu===undefined?spec.ecu:candidate.ecu)+':'+(candidate.did||'OBD '+candidate.obd);
            this.raws[name]={at:Date.now(),source,raw:bytes,decoded:value};
            Object.keys(group[2]).forEach(field=>{this.samples[group[2][field]]={value:value&&value[field]!==undefined?value[field]:null,at,ttl,source};});
            if(value&&Array.isArray(value.cells))this.arrays[name]={cells:value.cells.slice(),valid:value.valid,total:value.total,at,ttl,source};else delete this.arrays[name];
            if(!value){this.pick[name]=((this.pick[name]||0)+1)%group[1].length;this.next[name]=at+5000;}
            this.error='';
            if(this.options.persist&&at-this.lastSave>=10000){try{this.options.persist({schema:1,source:'vehicle',reads:this.raws});this.lastSave=at;}catch(e){this.error='Журнал батареи не сохранён';}}
        }).catch(e=>{if(active()){this.samples={};this.error=e.message;this.next[name]=clock.now()+5000;}}).then(()=>{this.busy=false;});
    }
    copyTo(feed,now){
        this.source(feed);if(feed.mode!=='vehicle')return;
        GROUPS.forEach(g=>Object.keys(g[2]).forEach(field=>{const k=g[2][field],s=this.samples[k];if(!s){feed.put(k,null,'unavailable',now,'UDS:awaiting response');return;}const fresh=now>=s.at&&now-s.at<=s.ttl;feed.put(k,s.value,fresh?(s.value===null?'unavailable':'live'):'stale',s.at,s.source);}));
        const v=this.samples.hvVoltage,a=this.samples.hvCurrent;
        const valid=v&&a&&v.value!==null&&a.value!==null&&Math.abs(v.at-a.at)<=1500&&now>=Math.max(v.at,a.at)&&now-v.at<=4000&&now-a.at<=4000;
        feed.put('hvPower',valid?spec.powerSign*v.value*a.value/1000:null,valid?'live':'unavailable',valid?Math.max(v.at,a.at):now,'computed:HV voltage/current');
    }
    close(){this.closed=true;}
}
module.exports=EnergyRead;module.exports.decode=decode;module.exports.GROUPS=GROUPS;
