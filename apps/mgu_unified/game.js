(function(root,factory){
    if(typeof module==='object'&&module.exports)module.exports=factory();else root.MguGame=factory();
}(this,function(){
    'use strict';
    var fields=[
        ['skill','Сложность','3',['1','2','3','4','5']],
        ['episode','Эпизод','1',['1','2','3','4']],
        ['run','Скорость движения','slow',['slow','walk','run']],
        ['aim','Скорость поворота','normal',['slow','normal','fast']],
        ['aimdir','Направление поворота','normal',['normal','reversed']],
        ['detail','Детализация','full',['full','medium','low']]
    ];
    var labels={slow:'Медленно',walk:'Шаг',run:'Бег',normal:'Обычное',fast:'Быстро',reversed:'Обратное',full:'Полная',medium:'Средняя',low:'Низкая'};
    function settings(saved){var out={};fields.forEach(function(f){out[f[0]]=saved&&f[3].indexOf(saved[f[0]])>=0?saved[f[0]]:f[2];});return out;}
    function Model(options){options=options||{};this.adapter=options.adapter;this.prefs=settings(options.saved);this.persist=options.persist||function(){};this.now=options.now||Date.now;this.armed=null;this.page=0;this.error='';this.sourceKey=null;}
    Model.prototype.source=function(feed){var key=feed.mode+':'+feed.revision;if(this.sourceKey!==key){this.sourceKey=key;this.cancel();}};
    Model.prototype.cancel=function(){this.armed=null;};
    Model.prototype.view=function(){
        var state=this.adapter?this.adapter.view():{allowed:false,running:false,saved:false,reason:'Игра доступна в сборке для MGU; браузер показывает меню'};
        if(this.armed!==null&&(this.now()<this.armed||this.now()-this.armed>10000||!state.allowed))this.cancel();
        return Object.assign({},state,{armed:this.armed!==null,error:this.error||state.error||''});
    };
    Model.prototype.play=function(){this.cancel();if(!this.view().allowed||!this.adapter)return false;return this.adapter.play(false);};
    Model.prototype.newGame=function(){if(!this.view().allowed||!this.adapter)return false;if(this.armed===null){this.armed=this.now();return false;}this.cancel();return this.adapter.play(true);};
    Model.prototype.setting=function(key){var f=fields.filter(function(v){return v[0]===key;})[0];if(!f)return false;this.cancel();this.prefs[key]=f[3][(f[3].indexOf(this.prefs[key])+1)%f[3].length];try{this.persist(Object.assign({},this.prefs));this.error='';}catch(e){this.error='Настройки игры не сохранены';}return true;};
    return {Model:Model,fields:fields,settings:settings,label:function(value){return labels[value]||value;}};
}));
