'use strict';
// One owner of kit's single ctx.controller.onInput slot, shared by the shell (MAIN) and DOOM.
// kit grab() needs the GPU renderer and mgu-inputgate.so; without them it is a harmless no-op and
// the HMI keeps moving its focus over the RHMI buttons (the fallback path).
// The grab is held only for a port that wants it AND whose screen is visible and has focus.
// Popup focus loss, hidden screen, a throwing handler, release or close drop it at once,
// and the losing owner's held inputs are reset (onRelease).
const ORDER=['doom','live_data','live_adjustments','zf8hp','shell'];
class ControllerRouter {
    constructor(ctx,options){
        this.ctx=ctx;this.log=(options&&options.log)||ctx.log;this.ports={};this.holder=null;this.closed=false;this.grabbed=false;
        this.native=!!(ctx.controller&&typeof ctx.controller.grab==='function'&&typeof ctx.controller.onInput==='function');
        if(this.native)ctx.controller.onInput(v=>this.input(v));
        const ui=ctx.ui||{};
        if(typeof ui.onFocus==='function')ui.onFocus(()=>this.sync());
        if(typeof ui.onVisible==='function')ui.onVisible(()=>this.sync());
    }
    port(name,opts){
        if(ORDER.indexOf(name)<0||this.ports[name])throw Error('Unknown or duplicate controller port: '+name);
        const p=this.ports[name]={name,want:false,handler:null,eligible:opts.eligible,onRelease:opts.onRelease||null};
        const self=this;
        return {
            grab(on){p.want=!!on;self.sync();},
            onInput(fn){p.handler=typeof fn==='function'?fn:null;if(!p.handler&&self.holder===p.name)self.sync();},
            get holding(){return self.holder===p.name;}
        };
    }
    eligible(p){try{return p.want&&!!p.handler&&p.eligible()===true;}catch(e){this.log.warn('controller eligibility: '+e.message);return false;}}
    sync(){
        let next=null;
        if(!this.closed)for(const name of ORDER){const p=this.ports[name];if(p&&this.eligible(p)){next=name;break;}}
        if(next===this.holder)return;
        const prev=this.ports[this.holder];this.holder=next;
        if(prev&&prev.onRelease){try{prev.onRelease();}catch(e){this.log.warn('controller release: '+e.message);}}
        const want=!!next;
        if(this.native&&want!==this.grabbed){
            this.grabbed=want;
            try{this.ctx.controller.grab(want);}catch(e){this.grabbed=false;this.log.warn('controller grab: '+e.message);}
        }
    }
    input(v){
        // Re-check first: a popup may have covered the screen since the last sync.
        this.sync();const p=this.ports[this.holder];if(!p||!p.handler)return false;
        try{p.handler(v);return true;}
        catch(e){this.log.warn('controller handler '+p.name+': '+e.message);p.want=false;this.sync();return false;}
    }
    close(){
        if(this.closed)return;this.closed=true;this.sync();
        if(this.native){try{this.ctx.controller.grab(false);}catch(e){}try{this.ctx.controller.onInput(null);}catch(e){}}
    }
}
module.exports=ControllerRouter;
