'use strict';

class Shutdown {
    constructor(options) {
        const o=options||{};this.hooks=[];this.promise=null;
        this.exit=o.exit||(()=>process.exit(0));this.log=o.log||{warn(){}};
        this.timeout=o.timeoutMs===undefined?10000:o.timeoutMs;
    }
    add(fn) {
        if(typeof fn!=='function')throw new TypeError('Shutdown hook must be a function');
        if(this.promise)throw Error('Application is closing');
        this.hooks.push(fn);
    }
    run() {
        if(this.promise)return this.promise;
        this.promise=new Promise(resolve=>{
            let done=false;
            const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();this.exit();};
            const timer=setTimeout(()=>{this.log.warn('Shutdown deadline reached; recovery records retained');finish();},this.timeout);
            const jobs=this.hooks.map(fn=>Promise.resolve().then(fn).catch(e=>this.log.warn('Shutdown: '+String(e&&e.message||e))));
            if(!jobs.length)jobs.push(new Promise(r=>setTimeout(r,200)));
            Promise.all(jobs).then(finish);
        });
        return this.promise;
    }
}
module.exports=Shutdown;
