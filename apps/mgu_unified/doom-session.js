'use strict';
// One lazily created engine. No vehicle commands; the independent parked watcher
// continues to use real Vehicle2 speed even when the shell displays DEMO.
const path=require('path'),fs=require('fs');
const {Doom,GS}=require('./doom-core');
const {Controls}=require('./doom-controls');
const Parked=require('./kit/parked');
const {Recorder,setImage}=require('./kit/record');
const clock=require('./kit/clock');
const DETAIL={full:[1920,504],medium:[1440,378],low:[960,252]};
const BUTTONS={DOOM_BACK:'BTN_BACK',DOOM_LEFT:'BTN_TL',DOOM_STAND:'BTN_STAND',DOOM_WALK:'BTN_WALK',DOOM_RIGHT:'BTN_TR',DOOM_WEAPON:'BTN_WEAPON'};
const IMG=70010,VIEW=70011;
// In the shared shell process the engine (WASM heap + WAD) is released after this long paused off-screen.
// The slot was already saved at the pause; Play loads it again.
const IDLE_UNLOAD_MS=120000;
class Session {
    constructor(ctx,options){
        this.ctx=ctx;this.o=options;this.parked=Parked.watch(ctx,ctx.log);this.game=null;this.ctl=null;this.mode=null;this.running=false;this.closed=false;this.error='';this.saved=false;this.frames=0;this.hasView=false;this.ccuAt=-Infinity;this.sub=null;
        if(ctx.controller&&ctx.controller.onInput)ctx.controller.onInput(v=>{this.ccuAt=clock.now();if(this.ctl)this.ctl.raw(v);});
        Promise.resolve(ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU','1',{
            statusRotaryEncoderState:v=>{if(this.ctl&&clock.now()-this.ccuAt>1000)this.ctl.raw(v);}
        },ctx.log,{onAvailable:up=>{if(!up&&this.ctl){this.ctl.enable(false);if(this.running)this.ctl.enable(true);}}})).then(s=>{if(this.closed){if(s.shutdown)s.shutdown();}else this.sub=s;},e=>ctx.log.warn('Game controller: '+e.message));
        Object.keys(BUTTONS).forEach(name=>{
            const c=ctx.ui.rhmi&&ctx.ui.rhmi.getByName(name);
            if(c&&c.on)c.on('focus',e=>{if(this.ctl&&e&&typeof e.value==='boolean')this.ctl.barFocus(BUTTONS[name],e.value);});
            ctx.ui.onClick(name,()=>{this.sync();if(this.ctl&&this.running)this.ctl.barClick(BUTTONS[name]);});
        });
        ctx.ui.onClick('DOOM_EXIT',()=>this.leave());
        if(ctx.ui.onFocus)ctx.ui.onFocus(()=>this.sync());
        ctx.loop('DOOM_GAME',35,()=>{this.sync();return this.render();});
    }
    shown(){return !!(this.ctx.ui.isVisible&&this.ctx.ui.isVisible('DOOM_GAME'));}
    focused(){return this.shown()&&(!this.ctx.ui.hasFocus||this.ctx.ui.hasFocus('DOOM_GAME'));}
    allowed(){return !this.closed&&!this.parked.moving()&&(this.o.mode()==='vehicle'||this.o.mode()==='demo');}
    view(){
        const allowed=this.allowed(),st=this.game&&this.game.state();
        return {allowed,running:this.running,saved:this.saved,error:this.error,
            reason:!allowed?(this.parked.speed()===null?'Нет достоверной скорости — игра приостановлена':'Автомобиль движется — игра приостановлена'):this.running?'Игра запущена':st&&st.gamestate===GS.LEVEL?'E'+Math.floor(st.level/10)+'M'+st.level%10+' · здоровье '+st.health+' %':'Готово к запуску. BACK вернёт в меню',
            available:true};
    }
    release(){if(this.ctl)this.ctl.enable(false);if(this.ctx.controller)this.ctx.controller.grab(false);}
    pause(save){
        const was=this.running;this.running=false;this.release();if(was||!this.idleSince)this.idleSince=clock.now();
        if(!this.game)return;
        this.game.pause(true);
        if(save&&was){
            try{if(this.game.save(0)&&!this.game.dead){this.saved=true;this.ctx.log.info('Unified DOOM: saved slot 0');}else{this.error='Текущий момент игры нельзя сохранить; предыдущая копия сохранена';}}
            catch(e){this.error='Игра не сохранена: '+e.message;this.ctx.log.warn(this.error);}
        }
    }
    dispose(){
        this.pause(true);
        if(this.game){this.game.stop();this.game.onFrame=null;this.game.onDead=null;this.game.fds.forEach(f=>{try{fs.closeSync(f.fd);}catch(ignore){}});this.game.fds.clear();}
        this.game=null;this.ctl=null;this.frames=0;this.hasView=false;this.saved=false;this.detail=null;
    }
    ensure(){
        const mode=this.o.mode();if(this.game&&!this.game.dead&&mode===this.mode)return;
        this.dispose();this.mode=mode;this.error='';
        const p=this.o.prefs();
        this.game=new Doom({wasm:path.join(__dirname,'doom.wasm'),wadDir:__dirname,dataDir:path.join(this.ctx.dataDir,'games',mode),log:this.ctx.log,args:['-skill',p.skill,'-episode',p.episode,'-mb','16']});
        this.game.onFrame=(px,w,h)=>{setImage(IMG,w,h,px);const v=this.game.view();this.hasView=!!v;if(v)setImage(VIEW,v.w,v.h,v.px);this.frames++;};
        this.game.onDead=e=>{this.error='Игра остановилась: '+e.message;this.pause(false);this.ctx.ui.open('MAIN');};
        this.game.start();if(this.game.dead)throw this.game.dead;
        this.game.pause(true);this.saved=this.game.load(0);if(this.game.dead)throw this.game.dead;
        this.ctl=new Controls(this.game,{log:this.ctx.log,now:clock.now,run:()=>this.o.prefs().run==='run',aim:()=>this.o.prefs().aim,reversed:()=>this.o.prefs().aimdir==='reversed'});
        this.applySettings();
    }
    applySettings(){if(!this.game||this.game.dead)return;const p=this.o.prefs(),size=DETAIL[p.detail]||DETAIL.full;if(this.detail!==p.detail){this.game.setRes(size[0],size[1]);this.detail=p.detail;}this.game.walk(p.run==='slow'?55:100);}
    play(fresh){
        if(!this.allowed())return false;
        try{
            this.ensure();if(!this.allowed()){this.pause(false);return false;}
            if(fresh){const p=this.o.prefs();this.game.newGame(Number(p.skill),Number(p.episode));this.saved=false;}
            this.error='';this.ctx.ui.open('DOOM_GAME');this.sync();return true;
        }catch(e){this.error='Не удалось запустить DOOM: '+e.message;this.pause(false);this.ctx.log.warn(this.error);return false;}
    }
    unload(){if(!this.game||this.running)return false;const saved=this.saved,error=this.error;this.dispose();this.saved=saved;this.error=error;this.unloaded=(this.unloaded||0)+1;this.ctx.log.info('Unified DOOM: engine unloaded after idle');return true;}
    sync(){
        if(this.closed)return;
        if(this.game&&!this.running&&!this.shown()&&this.idleSince&&clock.now()-this.idleSince>=IDLE_UNLOAD_MS){this.unload();return;}
        if(this.game&&this.mode!==this.o.mode()){this.dispose();if(this.shown())this.ctx.ui.open('MAIN');return;}
        const go=!!(this.game&&!this.game.dead&&this.focused()&&this.allowed());
        if(go!==this.running){
            if(!go){this.pause(true);if(this.shown()&&!this.allowed())this.ctx.ui.open('MAIN');}
            else{this.running=true;this.idleSince=0;this.applySettings();this.ctl.enable(true);if(this.ctx.controller)this.ctx.controller.grab(true);this.game.pause(false);}
        }
        if(this.ctl&&this.running)this.ctl.apply();
    }
    leave(){this.pause(true);this.ctx.ui.open('MAIN');}
    render(){
        const cv=this.ctx.canvas(1600,520).clear('#000000'),pl=cv.place;
        let target=cv,w=1600,h=520;
        if(pl&&pl.full){w=pl.w;h=pl.h;target=new Recorder(w,h);target.fillRect(0,0,w,h,'#000000');}
        if(!this.frames)target.text(require('./i18n').tr(this.error?'Игра остановлена':'Загрузка…'),w/2,h/2,28,'#ffffff',{align:'center'});
        else{const gw=Math.round(h*4/3);if(this.hasView)target.image(VIEW,0,0,w,Math.round(h*168/200));target.image(IMG,Math.round((w-gw)/2),0,gw,h);}
        if(target!==cv)cv.xf(1,0,0).append(target).xf();
        return this.ctx.ui.image('DOOM_GAME_GFX',cv);
    }
    close(){if(this.closed)return;this.closed=true;this.dispose();if(this.sub&&this.sub.shutdown)this.sub.shutdown();if(this.ctx.controller&&this.ctx.controller.onInput)this.ctx.controller.onInput(null);}
}
module.exports=Session;
