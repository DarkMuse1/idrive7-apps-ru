'use strict';
let language='ru';
function set(value){if(value==='ru'||value==='en')language=value;}
function file(name){return language==='en'&&!/^en-|^beeper-/.test(name)?'en-'+name:name;}
module.exports={set,file,get:()=>language};
