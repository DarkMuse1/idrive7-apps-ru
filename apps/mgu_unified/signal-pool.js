'use strict';
// One read/subscription proxy per declared interface+instance, shared by modules.
// Setters are never exposed. Method calls: only read-only requests in READ_METHODS that app.json
// also declares in "_methods" for that interface, over the interface's already-open proxy.
const READ_METHODS=Object.freeze({'de.bmw.infotainment.KombiInterface_2':['requestCBSServiceHint']});
module.exports=function signalPool(signals,spec){
    const entries=new Map();let closed=false;
    function watch(iface,instance,handlers,log,opts){
        opts=opts||{};const declared=spec.signals[iface]||{};
        const fields=Object.keys(declared).filter(k=>!k.startsWith('_')&&/^[rs]+$/.test(declared[k]));
        if(closed)return Promise.resolve({available:false,error:'pool closed',shutdown(){}});
        if(Object.keys(handlers).some(k=>fields.indexOf(k)<0))return Promise.reject(new Error('Undeclared signal: '+iface));
        const key=iface+'|'+instance;let e=entries.get(key);
        const sub={handlers,opts,alive:true};
        const safe=(fn,arg)=>{try{fn(arg);}catch(err){if(log&&log.warn)log.warn('signal subscriber: '+err.message);}};
        if(!e){
            e={subs:[],result:null,available:null,closed:false};entries.set(key,e);
            const dispatch={};fields.forEach(f=>dispatch[f]=value=>e.subs.slice().forEach(s=>{if(s.alive&&s.handlers[f])safe(s.handlers[f],value);}));
            // Defer construction so synchronous watch registrations are all present.
            e.ready=Promise.resolve().then(()=>e.closed?{available:false,error:'pool closed',shutdown(){}}:signals.watch(iface,instance,dispatch,log,{pollMs:1000,onAvailable:up=>{
                if(e.closed)return;e.available=!!up;e.subs.slice().forEach(s=>{if(s.alive&&s.opts.onAvailable)safe(s.opts.onAvailable,!!up);});
            }})).then(result=>{e.result=result;if(e.closed){if(result.shutdown)result.shutdown();}else if(result.error||result.available===false){e.available=false;e.subs.forEach(s=>{if(s.alive&&s.opts.onAvailable)safe(s.opts.onAvailable,false);});}return result;});
        }
        e.subs.push(sub);if(e.available!==null&&opts.onAvailable)safe(opts.onAvailable,e.available);
        return e.ready.then(result=>({
            get available(){return sub.alive&&!e.closed&&!!result.available;},get error(){return result.error;},
            shutdown(){if(!sub.alive)return;sub.alive=false;e.subs=e.subs.filter(s=>s!==sub);if(!e.subs.length&&!e.closed){e.closed=true;entries.delete(key);if(e.result&&e.result.shutdown)e.result.shutdown();}}
        }));
    }
    function call(iface,instance,method,params,timeoutMs){
        const declared=(spec.signals[iface]||{})._methods||[],allowed=READ_METHODS[iface]||[];
        if(allowed.indexOf(method)<0||declared.indexOf(method)<0)return Promise.reject(new Error('Method not permitted: '+iface+'.'+method));
        const e=entries.get(iface+'|'+instance);
        if(closed||!e||!e.result||!e.result.proxy||!e.available)return Promise.reject(new Error('Interface not available'));
        if(typeof signals.call!=='function')return Promise.reject(new Error('Method calls unavailable'));
        return Promise.resolve().then(()=>signals.call(e.result.proxy,method,params,timeoutMs));
    }
    return {watch,call,close(){if(closed)return;closed=true;entries.forEach(e=>{e.closed=true;e.subs.forEach(s=>s.alive=false);if(e.result&&e.result.shutdown)e.result.shutdown();});entries.clear();}};
};
