'use strict';
// Host existing source modules in the SAME OAP application/runtime, with separate
// RHMI names, preferences, files and controller ownership. No extra installers.
const fs=require('fs'),path=require('path');
const config=require('./embedded-config');
const THEMES=require('./kit/themes');
const TouchRouter=require('./touch-router');
const shared=['theme','layout','renderer','demo'];
const palette={bg:'#191916',panelTop:'#30291f',panelBottom:'#24221d',panelEdge:'#44433b',text:'#f3ecdc',dim:'#b8b5a9',tab:'#b8b5a9',
    accent:'#efa93e',accent2:'#efa93e',bar:'#efa93e',sel:'#efa93e',selText:'#f3ecdc',stripes:['#efa93e'],track:'#44433b',marker:'#f3ecdc'};
class EmbeddedHost {
    constructor(ctx,options){
        this.ctx=ctx;this.options=options||{};this.sessions={};this.closed=false;
        // Page touch where the kit runs the screen (renderer 2.x): the kit's single onTab/onTap/onScroll/onLayout
        // slots are the shared router's; it hands each event to the screen shown and in front (touch-router.js).
        this.touch=this.options.touch||new TouchRouter(ctx);
        ctx.settings.onChange(key=>{
            if(key==='homeWidget'){
                this.options.widgets.changed();
                if(ctx.settings.get(key)==='live_data')this.start('live_data').catch(e=>this.error(e));
            }
        });
    }
    error(e){this.ctx.log.error('Встроенный модуль: '+e.message);}
    known(id){return Object.prototype.hasOwnProperty.call(config,id);}
    visible(session){return !this.closed&&this.ctx.ui.isVisible(session.name('MAIN'))&&(!this.ctx.ui.hasFocus||this.ctx.ui.hasFocus(session.name('MAIN')));}
    /** The module's touch handlers (its ctx.onTab/onTap/onScroll/onLayout) for its screen: the kit's events for it, as it gets them standalone. */
    route(s){
        const on=(kind,args)=>{const h=s.handlers[kind];return !this.closed&&!s.failed&&h?h.apply(null,args):undefined;};
        this.touch.screen(s.name('MAIN'),{tap:(x,y)=>on('tap',[x,y]),tab:(i,closed)=>on('tab',[i,closed]),scroll:dy=>on('scroll',[dy])===true,layout:()=>on('layout',[])});
    }
    start(id){
        if(this.closed||!this.known(id))return Promise.reject(Error('Модуль недоступен'));
        if(this.sessions[id])return this.sessions[id].ready;
        const parent=this.ctx,entry=config[id],prefix=entry.prefix+'_';
        const s={name:n=>prefix+n,handlers:{},loops:[],failed:null};this.sessions[id]=s;this.route(s);
        // Where the kit runs the screen its header's tabs turn the pages: the module's own Next page leaves the bar,
        // as the kit does for a standalone app's BTN_PAGE / BTN_PREV (it knows them by those names only). Its
        // Settings stays in the bar (the HMI's settings screen; the header has no Settings tab for these screens).
        (entry.spec.screens||[]).forEach(scr=>(scr.buttons||[]).forEach(b=>{if((b[0]==='BTN_PAGE'||b[0]==='BTN_PREV')&&typeof parent.hideButton==='function')parent.hideButton(prefix+b[0]);}));
        const dataDir=path.join(parent.dataDir,'modules',id);
        [path.dirname(dataDir),dataDir].forEach(p=>{if(!fs.existsSync(p))fs.mkdirSync(p);});
        const key=k=>shared.indexOf(k)>=0?k:prefix+k;
        const safeDemo=()=>parent.settings.get('demo')==='on';
        const settingValue=k=>{
            if(k==='demo')return safeDemo()?'on':'off'; // never auto-demo on missing native data
            if(safeDemo()&&['arm','tuner','xdrive'].indexOf(k)>=0)return 'off';
            return parent.settings.get(key(k));
        };
        const settings={schema:entry.spec.settings,get:settingValue,
            set:(k,v)=>parent.settings.set(key(k),v),item:k=>entry.spec.settings.find(f=>f.key===k),
            onChange:fn=>parent.settings.onChange(k=>{if(this.closed)return;if(k.startsWith(prefix))fn(k.slice(prefix.length),settingValue(k.slice(prefix.length)));else if(shared.indexOf(k)>=0)fn(k,settingValue(k));}),
            display:k=>parent.settings.display(key(k)),cycle:k=>parent.settings.cycle(key(k))};
        const ui={};
        ['text','cells','selected','rows','visible','enabled','checked','comp','close'].forEach(method=>ui[method]=function(name){
            const args=Array.prototype.slice.call(arguments);args[0]=s.name(name);return parent.ui[method].apply(parent.ui,args);
        });
        ui.isVisible=name=>!this.closed&&parent.ui.isVisible(s.name(name));
        ui.hasFocus=name=>!this.closed&&(!parent.ui.hasFocus||parent.ui.hasFocus(s.name(name)));
        ui.onVisible=fn=>parent.ui.onVisible((name,on)=>{if(!this.closed&&name.startsWith(prefix))fn(name.slice(prefix.length),on);});
        ui.onFocus=fn=>parent.ui.onFocus((name,on)=>{if(!this.closed&&name.startsWith(prefix))fn(name.slice(prefix.length),on);});
        ui.open=name=>parent.ui.open(name==='SETTINGS'?'SETTINGS':s.name(name));
        ui.image=(name,cv)=>ui.isVisible('MAIN')?parent.ui.image(s.name(name),cv):Promise.resolve();
        ui.onClick=(name,fn)=>parent.ui.onClick(s.name(name),ev=>{
            if(!this.visible(s))return;
            parent.log.info('MGU Tools / '+id+' / '+name+': действие пользователя');
            return fn(ev);
        });
        parent.ui.onClick(prefix+'BTN_SETTINGS',()=>this.visible(s)&&parent.ui.open('SETTINGS'));
        parent.ui.onClick(prefix+'RETURN',()=>this.visible(s)&&parent.ui.open('MAIN'));
        // Separate subscribers use the original APIs. A shared Diag FIFO prevents
        // diagnostic transactions from different modules consuming one another's replies.
        const signals=Object.create(parent.signals);
        signals.embeddedReadAllowed=()=>!this.closed&&!safeDemo();
        signals.embeddedWriteAllowed=()=>this.visible(s)&&!safeDemo();
        const context={ui,settings,signals,dataDir,spec:entry.spec,log:parent.log,app:parent.app,
            theme:()=>Object.assign({},THEMES.theme('mgu_tools'),palette),canvas:(w,h)=>parent.canvas(w,h),
            display:parent.display,widget:id==='live_data'?this.options.widgets.port(id):null,
            controller:this.options.router.port(id,{eligible:()=>this.visible(s)}),
            onTab:fn=>s.handlers.tab=fn,onTap:fn=>s.handlers.tap=fn,onScroll:fn=>s.handlers.scroll=fn,onLayout:fn=>s.handlers.layout=fn,
            // the kit's sheet over the module's page where it runs the screen (touch and controller); false elsewhere:
            // the module's own inline / RHMI fallback, as in the standalone app
            sheet:sh=>typeof parent.sheet==='function'?parent.sheet(sh)===true:false,
            hideButton:name=>parent.hideButton(s.name(name)),
            loop:(name,fps,fn)=>{const loop=parent.loop(s.name(name),fps,fn);s.loops.push(loop);return loop;}};
        s.context=context;
        s.ready=Promise.resolve().then(()=>require('./embedded_'+id+'_main').start(context)).then(()=>{
            parent.log.info('MGU Tools: '+entry.title+' '+entry.spec.version+' запущен внутри общего приложения');return s;
        }).catch(e=>{s.failed=e;s.loops.forEach(l=>l.stop());this.error(e);throw e;});
        return s.ready;
    }
    async open(id){
        const s=await this.start(id);if(this.closed)throw Error('Приложение закрыто');
        if(this.options.currentId&&this.options.currentId()!==id)throw Error('Открытие отменено: выбран другой раздел');
        await this.ctx.ui.open(s.name('MAIN'));return true;
    }
    close(){this.closed=true;this.touch.close&&!this.options.touch&&this.touch.close();Object.keys(this.sessions).forEach(id=>this.sessions[id].loops.forEach(l=>l.stop()));}
}
module.exports=EmbeddedHost;
