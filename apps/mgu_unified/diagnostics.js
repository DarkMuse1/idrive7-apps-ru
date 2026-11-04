(function(root,factory){
    if(typeof module==='object'&&module.exports)module.exports=factory();
    else root.MguDiagnostics=factory();
}(this,function(){
    'use strict';
    // Read-only fault-memory model; decoding follows kit/diag.parseDtcReply.
    // A negative, truncated or missing answer is never an empty, successful scan.
    function hex(n,width){var s=n.toString(16).toUpperCase();while(s.length<width)s='0'+s;return s;}
    function bytes(value){return Array.isArray(value)&&value.length<=65536&&value.every(function(b){return Number.isInteger(b)&&b>=0&&b<=255;});}
    function decode(raw,info){
        var out={state:'notread',reason:'Нет корректного ответа',faults:[],other:[]};
        if(!bytes(raw)||!raw.length)return out;
        if(raw.length===3&&raw[0]===0x7F&&raw[1]===0x19){out.reason=raw[2]===0x78?'Ответ остался в ожидании':'Отказ ECU · NRC '+hex(raw[2],2);return out;}
        var start=info?4:3;
        if(raw[0]!==0x59||raw[1]!==(info?0x17:0x02)||raw.length<start||(raw.length-start)%4){out.reason='Неполный или чужой ответ';return out;}
        for(var i=start;i<raw.length;i+=4){var d={code:hex(raw[i]*65536+raw[i+1]*256+raw[i+2],6),status:raw[i+3]};
            // Matches the existing scanner's classification, including warning-lamp status.
            ((d.status&0xAF)?out.faults:out.other).push(d);
        }
        out.state='read';out.reason='';return out;
    }
    function unit(address,raw,info){return Object.assign({address:address,raw:bytes(raw)?raw.slice():null},decode(raw,info));}
    function label(status){return status&1?'Активна':status&128?'Индикатор':status&4?'Ожидает':status&8?'Сохранена':'История';}
    function Model(options){
        options=options||{};this.adapter=options.adapter;this.persist=options.persist||function(){};
        this.event=options.event||function(){};this.key=null;this.epoch=0;this.report=null;
        this.phase='idle';this.progress=0;this.error='';this.saveError='';this.page=0;this.cc=null;this.ccPage=0;
        this.scope='current';this.includeInfo=false;this.detail=null;this.detailPage=0;this.stage='';
    }
    Model.prototype.source=function(feed){
        var key=feed.mode+':'+feed.revision;
        if(key!==this.key){this.key=key;this.epoch++;this.phase='idle';this.report=null;this.error='';this.saveError='';this.progress=0;this.page=0;this.cc=null;this.ccPage=0;this.detail=null;this.detailPage=0;}
    };
    Model.prototype.scan=function(feed){
        this.source(feed);if(this.phase==='reading')return Promise.resolve(false);
        if(feed.mode!=='demo'&&(feed.mode!=='vehicle'||!this.adapter)){this.error='Диагностическое подключение недоступно';return Promise.resolve(false);}
        var self=this,token=++this.epoch,mode=feed.mode,revision=feed.revision,options={mask:this.scope==='all'?255:12,info:this.includeInfo};
        var active=function(){return self.epoch===token&&feed.mode===mode&&feed.revision===revision;};
        this.phase='reading';this.error='';this.saveError='';this.progress=0;this.report=null;this.page=0;this.detail=null;this.detailPage=0;
        var demoUnits=[unit(0x12,[0x59,2,255,0x12,0x34,0x56,9]),unit(0x18,[0x59,2,255]),unit(0x29,[0x7F,0x19,0x78])];
        demoUnits[0].faults[0].description={text:'Демонстрационное описание. Код и показания вымышлены, это не результат чтения автомобиля.',source:'demo'};
        if(options.info)demoUnits.forEach(function(u,i){u.info=unit(u.address,i?[0x7F,0x19,0x31]:[0x59,0x17,255,1,0xAB,0xCD,0xEF,8],true);});
        this.stage='Память ошибок';
        var task=mode==='demo'?Promise.resolve({ended:'idle',units:demoUnits,infoState:options.info?'partial':'off'}):Promise.resolve().then(function(){return self.adapter(active,function(n,stage){if(active()){self.progress=n;if(stage)self.stage=stage;}},options);});
        return task.then(function(result){
            if(!active())return false;
            if(!result||!Array.isArray(result.units)||['idle','deadline'].indexOf(result.ended)<0)throw Error('Некорректный результат чтения');
            self.report={schema:2,at:Date.now(),source:mode,mask:options.mask,infoRequested:options.info,infoState:result.infoState||(options.info?'notread':'off'),infoError:result.infoError||'',identificationLimited:!!result.identificationLimited,ended:result.ended,units:result.units};self.phase='done';
            // Session-only native receipt; a JSON report restored from disk cannot authorise clearing.
            if(result.receipt)Object.defineProperty(self.report,'_receipt',{value:result.receipt});
            self.progress=result.units.length;
            if(mode==='vehicle'){try{self.persist(self.report);}catch(e){self.saveError='Отчёт не сохранён: '+e.message;}}
            self.event({title:'Чтение ошибок: ответили '+result.units.length+' блоков',source:mode});return true;
        }).catch(function(err){if(active()){self.phase='error';self.error='Чтение не завершено: '+err.message;self.report=null;}return false;});
    };
    Model.prototype.option=function(key){if(this.phase==='reading')return false;if(key==='scope')this.scope=this.scope==='all'?'current':'all';else if(key==='info')this.includeInfo=!this.includeInfo;else return false;return true;};
    Model.prototype.cancel=function(){if(this.phase!=='reading')return false;this.epoch++;this.phase='idle';this.report=null;this.detail=null;this.error='Чтение отменено';return true;};
    Model.prototype.checkControl=function(feed,value){this.source(feed);if(feed.mode==='vehicle')this.cc=value;};
    Model.prototype.view=function(feed){this.source(feed);return {phase:this.phase,stage:this.stage,report:this.report,progress:this.progress,error:this.error,saveError:this.saveError,cc:feed.mode==='demo'?{quality:'demo',messages:[{id:24,ecu:null,reason:'Пример сообщения Check Control'}]}:this.cc};};
    return {Model:Model,unit:unit,decode:decode,label:label,hex:hex};
}));
