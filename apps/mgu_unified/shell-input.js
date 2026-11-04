'use strict';
// FrontCCU.statusRotaryEncoderState -> shell actions (same fields/enums as apps/doom/controls.js).
//   knob click        -> rotate ±1 per click (16-bit counter; jumps > 64 are a reset, skipped)
//   press (short/long) -> activate once per press; it must return to "not pressed" first
//   tilt north / south -> previous / next focus
//   tilt west          -> BACK inside the shell (the HMI's own BACK key stays with the HMI)
//   tilt east          -> nothing (no implicit confirmation)
// After reset() (grab lost: popup, hidden, error) the first event only re-synchronises:
// a knob or press still held from before never fires.
const DEFL={MITTELSTELLUNG:0,NORD_KURZ_GEDRUECKT:1,NORD_LANG_GEDRUECKT:2,NORD_UNWIRKSAM:3,OST_KURZ_GEDRUECKT:4,
    OST_LANG_GEDRUECKT:5,OST_UNWIRKSAM:6,SUED_KURZ_GEDRUECKT:7,SUED_LANG_GEDRUECKT:8,SUED_UNWIRKSAM:9,
    WEST_KURZ_GEDRUECKT:10,WEST_LANG_GEDRUECKT:11,WEST_UNWIRKSAM:12,SIGNAL_UNGUELTIG:15};
const PUSH={KEINE_BETAETIGUNG:0,DREHGEBER_KURZ_GEDRUECKT:1,DREHGEBER_LANG_GEDRUECKT:2,UNWIRKSAM:3,SIGNAL_UNGUELTIG:15};
const DIR={1:'N',2:'N',3:'N',4:'E',5:'E',6:'E',7:'S',8:'S',9:'S',10:'W',11:'W',12:'W'};
const num=(v,names)=>typeof v==='number'?v:v!=null&&names[v]!=null?names[v]:15;
class ShellInput {
    constructor(){this.reset();}
    reset(){this.pos=null;this.pressed=false;this.dir=null;this.synced=false;}
    feed(v){
        if(!v||typeof v!=='object')return [];
        const push=num(v.frontRotaryEncoderPushButton,PUSH),defl=num(v.frontRotaryEncoderDeflection,DEFL),pos=v.frontRotaryEncoderOperation;
        if(push===15&&defl===15){this.reset();return [];}
        const pressed=push===1||push===2,dir=DIR[defl]||null,actions=[];
        const counter=typeof pos==='number'&&pos>=0&&pos<=0xffff&&Math.floor(pos)===pos?pos:null;
        if(!this.synced){this.pos=counter;this.pressed=pressed;this.dir=dir;this.synced=true;return [];}
        if(counter!==null&&this.pos!==null){
            const d=((counter-this.pos+32768)&0xffff)-32768;
            if(d&&Math.abs(d)<=64)actions.push({type:'rotate',delta:Math.max(-10,Math.min(10,d))});
        }
        if(counter!==null)this.pos=counter;
        if(pressed&&!this.pressed)actions.push({type:'press'});
        this.pressed=pressed;
        // Only a change from centre to a direction acts; "ineffective" variants keep the direction held.
        if(dir&&!this.dir&&(defl!==3&&defl!==6&&defl!==9&&defl!==12)){
            if(dir==='N')actions.push({type:'rotate',delta:-1});
            else if(dir==='S')actions.push({type:'rotate',delta:1});
            else if(dir==='W')actions.push({type:'back'});
        }
        this.dir=dir;
        return actions;
    }
}
/** Apply decoded actions to the shared App; returns true when something changed. */
function apply(app,actions){
    let changed=false;
    for(const a of actions){
        if(a.type==='rotate'){const n=Math.abs(a.delta),s=a.delta>0?1:-1;for(let i=0;i<n;i++)app.rotate(s);changed=true;}
        else if(a.type==='press'){app.activate();changed=true;}
        else if(a.type==='back'){app.back();changed=true;}
    }
    return changed;
}
module.exports=ShellInput;module.exports.apply=apply;module.exports.DEFL=DEFL;module.exports.PUSH=PUSH;
