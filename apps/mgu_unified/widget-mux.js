'use strict';
// One BMW widget, selectable provider. Providers never write over one another.
module.exports=function widgetMux(widget,selected,log){
    const providers={};
    if(widget){
        widget.loop(()=>{const p=providers[selected()];return p?Math.max(1,typeof p.fps==='function'?p.fps():p.fps||4):1;},inst=>{
            const p=providers[selected()];return p&&p.draw?p.draw(inst):null;
        });
        if(widget.onChange)widget.onChange(why=>{const p=providers[selected()];if(p)p.change.forEach(f=>f(why));});
        if(widget.onTap)widget.onTap(()=>{const p=providers[selected()];if(p)p.tap.forEach(f=>f());});
    }
    return {port(id){
        const p=providers[id]={change:[],tap:[],fps:4,draw:null};
        if(!widget)return null;
        return {active:()=>selected()===id&&widget.active(),
            loop(fps,draw){p.fps=fps;p.draw=draw;},onChange(fn){p.change.push(fn);},onTap(fn){p.tap.push(fn);},
            set(){return selected()===id?widget.set.apply(widget,arguments):Promise.resolve();},
            instances:()=>selected()===id&&widget.instances?widget.instances():[]};
    },changed(){Object.keys(providers).forEach(id=>providers[id].change.forEach(fn=>{try{fn('placed');}catch(e){log.warn(e.message);}}));}};
};
