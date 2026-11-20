'use strict';
const PROFILES=[['converter-hold','НЕПРЕРЫВНЫЙ ПОТОК'],['converter-reset','ПОЛНЫЙ ПЕРЕЗАПУСК'],['converter-period','ПО ГОТОВНОСТИ ALSA']];
const isProfile=b=>PROFILES.some(p=>p[0]===b);
module.exports={PROFILES,isProfile};
