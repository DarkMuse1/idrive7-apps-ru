'use strict';
// Original Vitals monitor family: OBD 06 A2..AD or UDS 22 F6A2..F6AD, TID 0C.
// Count cylinders only from the engine's supported-MID bitmap, never from a timeout.
function payload(raw,mid,uds){
    if(!Array.isArray(raw)||raw.some(b=>!Number.isInteger(b)||b<0||b>255))return null;
    return uds?raw.length>=3&&raw[0]===0x62&&raw[1]===0xF6&&raw[2]===mid?raw.slice(3):null:raw.length>=2&&raw[0]===0x46&&raw[1]===mid?raw.slice(1):null;
}
function supported(raw,uds){const p=payload(raw,0xA0,uds),at=uds?0:1;if(!p||p.length!==at+4)return null;const ids=[];for(let mid=0xA2;mid<=0xAD;mid++){const bit=mid-0xA1;if(p[at+(bit>>3)]&(0x80>>(bit&7)))ids.push(mid);}return ids;}
function count(raw,mid,uds,tid){
    const p=payload(raw,mid,uds),size=uds?8:9;if(!p||!p.length||p.length%size)return null;
    let value=null,found=false;for(let i=0;i<p.length;i+=size){const at=uds?i:i+1;if(!uds&&p[i]!==mid)return null;if(p[at]===tid){if(found)return null;found=true;const v=p[at+2]*256+p[at+3];value=v===65535?null:v;}}
    return value;
}
class Misfires {
    constructor(options){this.options=options;this.uds=false;this.ids=null;this.index=0;this.samples={};this.next=0;this.reason='Список цилиндров ещё не прочитан';}
    async read(link,now,active){
        const mid=this.ids&&this.ids.length?this.ids[this.index%this.ids.length]:0xA0,mode=this.uds;
        const raw=await link.physical(this.options.ecu,this.uds?0x22:0x06,this.uds?[0xF6,mid]:[mid],2500);
        if(!active())return;
        if(mid===0xA0){
            const ids=supported(raw?Array.from(raw):null,this.uds);this.samples={};this.index=0;
            if(ids===null){this.ids=null;this.uds=!this.uds;this.reason='Список цилиндров не прочитан';this.next=now()+5000;}
            else{this.ids=ids;this.reason=ids.length?'':'DME не сообщил поддерживаемых счётчиков';this.next=now()+(ids.length?200:30000);}
        }else{
            const value=count(raw?Array.from(raw):null,mid,this.uds,this.options.tid);this.samples[mid]={value,at:now()};this.index++;this.next=now()+500;
        }
        return {mid,uds:mode,raw:raw?Array.from(raw):null};
    }
    view(now){return {reason:this.reason,ids:this.ids?this.ids.map(mid=>mid-0xA1):null,counts:(this.ids||[]).map(mid=>{const s=this.samples[mid];return {cylinder:mid-0xA1,value:s&&now>=s.at&&now-s.at<=30000?s.value:null};})};}
}
module.exports=Misfires;module.exports.supported=supported;module.exports.count=count;
