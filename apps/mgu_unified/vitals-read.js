'use strict';
const cfg=require('./vitals-spec'),decode=require('./energy-read').decode,clock=require('./kit/clock');
const Misfires=require('./misfire-read');
const groups=[
    ['intake',cfg.dme.iat,[1,3],5000,15000],['hpfp',cfg.dme.hpfp,[3],2000,8000],['lpfp',cfg.dme.lpfp,[3],2000,8000],
    ['timing',cfg.dme.timing,[3],2000,8000],['oilFallback',cfg.dme.oil,[0,1],5000,15000],
    ['boostAbs',cfg.dme.boost,[0],2000,8000],['baro',cfg.dme.baro,[0],30000,90000],
    ['egs',cfg.dme.egs,[1],5000,15000],['frontTorque',cfg.xdrive.front,[4],2000,8000]
];
class VitalsRead {
    constructor(queue,options){this.queue=queue;this.options=options||{};this.key=null;this.busy=false;this.closed=false;this.reset(null);}
    reset(key){this.key=key;this.samples={};this.raws={};this.pick={};this.next={};this.cursor=0;this.egsInitial=null;this.egsTrusted=false;this.error='';this.lastSave=-Infinity;this.lastWasMisfire=false;this.misfires=new Misfires({ecu:cfg.dme.misfire.ecu===undefined?cfg.dme.ecu:cfg.dme.misfire.ecu,tid:parseInt(cfg.dme.misfire.tid||'0C',16)});}
    source(feed){const key=feed.mode+':'+feed.revision;if(key!==this.key)this.reset(key);}
    failed(error){this.samples={};this.misfires.samples={};this.egsInitial=null;this.egsTrusted=false;this.error=error.message;}
    poll(feed,tab,now){
        this.source(feed);if(this.closed||this.busy||feed.mode!=='vehicle'||tab===null)return;
        if(tab===3&&!this.lastWasMisfire&&now>=this.misfires.next){
            this.lastWasMisfire=true;this.busy=true;const key=this.key,revision=feed.revision,model=this.misfires;
            const active=()=>!this.closed&&this.key===key&&feed.mode==='vehicle'&&feed.revision===revision;
            return this.queue.run(active,link=>model.read(link,clock.now,active)).then(raw=>{if(active()&&raw)this.raws['misfire-'+raw.mid]={at:Date.now(),read:raw};}).catch(e=>{if(active()){this.failed(e);model.next=clock.now()+5000;}}).then(()=>{this.busy=false;});
        }
        let group;
        for(let n=0;n<groups.length;n++){
            const i=(this.cursor+n)%groups.length,g=groups[i];if(g[2].indexOf(tab)<0||now<(this.next[g[0]]||0))continue;
            if(g[0]==='oilFallback'&&feed.read('oil').value!==null&&!/^UDS:/.test(feed.read('oil').source))continue;
            if((g[0]==='boostAbs'||g[0]==='baro')&&feed.read('boost').value!==null&&!/^computed:UDS/.test(feed.read('boost').source))continue;
            group=g;this.cursor=(i+1)%groups.length;break;
        }
        if(!group){this.lastWasMisfire=false;return;}this.lastWasMisfire=false;const name=group[0],candidate=group[1][this.pick[name]||0],key=this.key,revision=feed.revision;
        const active=()=>!this.closed&&this.key===key&&feed.mode==='vehicle'&&feed.revision===revision;
        this.busy=true;this.next[name]=now+group[3];
        return this.queue.run(active,async link=>{
            const did=parseInt(candidate.did,16),ecu=candidate.ecu===undefined?cfg.dme.ecu:candidate.ecu;
            const raw=await link.physical(ecu,candidate.obd?1:0x22,candidate.obd?[parseInt(candidate.obd,16)]:[did>>8,did&255],2500);
            if(!active())return;const at=clock.now(),bytes=raw?Array.from(raw):null,out=decode(bytes,candidate),value=out?out.value:null;
            const source='UDS:'+ecu+':'+(candidate.did||'OBD '+candidate.obd);
            this.raws[name]={at:Date.now(),source,raw:bytes,value};
            this.samples[name]={value,at,ttl:group[4],source};
            if(name==='egs'&&value!==null){if(this.egsInitial===null)this.egsInitial=value;if(Math.abs(value-this.egsInitial)>=1)this.egsTrusted=true;}
            if(value===null){this.pick[name]=((this.pick[name]||0)+1)%group[1].length;this.next[name]=at+5000;}
            this.error='';if(this.options.persist&&at-this.lastSave>=10000){try{this.options.persist({schema:1,reads:this.raws});this.lastSave=at;}catch(e){this.error='Журнал показаний не сохранён';}}
        }).catch(e=>{if(active()){this.failed(e);this.next[name]=clock.now()+5000;}}).then(()=>{this.busy=false;});
    }
    copyTo(feed,now){
        this.source(feed);if(feed.mode!=='vehicle')return;
        const get=k=>{const s=this.samples[k];return s&&s.value!==null&&now>=s.at&&now-s.at<=s.ttl?s:null;};
        ['intake','hpfp','lpfp','timing','frontTorque','boostAbs','baro'].forEach(k=>{const s=get(k);feed.put(k,s?s.value:null,s?'live':'unavailable',s?s.at:now,s?s.source:'UDS:awaiting response');});
        const fallback=(key,name,trusted)=>{if(feed.read(key).value!==null&&!/^UDS:/.test(feed.read(key).source))return;const s=trusted&&get(name);feed.put(key,s?s.value:null,s?'live':'unavailable',s?s.at:now,s?s.source:'UDS:awaiting response');};
        fallback('oil','oilFallback',true);fallback('transmission','egs',this.egsTrusted);
        if(feed.read('boost').value===null||/^computed:UDS/.test(feed.read('boost').source)){
            const m=get('boostAbs'),b=get('baro'),value=m&&b?(m.value-b.value)/100:null;
            feed.put('boost',value,value===null?'unavailable':'live',m?m.at:now,'computed:UDS absolute minus measured ambient pressure');
        }
    }
    close(){this.closed=true;}
    static demo(feed,now){if(feed.mode!=='demo')return;const d={intake:29,hpfp:185,lpfp:5.2,timing:14,frontTorque:160,boostAbs:180,baro:100};Object.keys(d).forEach(k=>feed.put(k,d[k],'demo',now,'demo:vitals'));}
}
module.exports=VitalsRead;
