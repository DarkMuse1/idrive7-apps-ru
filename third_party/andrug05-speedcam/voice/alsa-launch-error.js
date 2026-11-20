'use strict';
const fs=require('fs');
const LOADER='/lib/ld-linux-x86-64.so.2';
function launchError(error,binary,io){
 const files=io||fs;
 if(error&&error.code==='ENOENT'){
  if(!files.existsSync(binary))return 'ALSA executable missing: '+binary+'; reinstall voice component';
  if(!files.existsSync(LOADER))return 'ALSA ELF loader missing: '+LOADER;
  return 'ALSA executable exists but cannot start (ENOENT); check ELF interpreter and installation';
 }
 return error&&error.message||String(error);
}
module.exports={launchError,LOADER};
