// Development paths only. Never permit a build tool to mutate a published release.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const workspace=path.resolve(__dirname,'../..'),staging=path.join(__dirname,'build/staging'),pending=path.join(__dirname,'build/pending-release.json');
function version(){return /const VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(__dirname,'CallShare-client.js'),'utf8'))[1];}
function inside(file,root){const rel=path.relative(root,path.resolve(file));return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);}
function releasePath(){
  let value=process.env.CALLSHARE_RELEASE_DIR;
  if(!value)try{const record=JSON.parse(fs.readFileSync(pending,'utf8'));if(record.version===version())value=record.path;}catch{}
  const file=path.resolve(value||path.join(workspace,'outputs/CallShare-'+version()));
  if(!inside(file,workspace)||path.basename(file)!=='CallShare-'+version())throw Error('Invalid release path');return file;
}
function mutableRelease(){const file=releasePath();if(!inside(file,staging))throw Error('Published releases are immutable; build in a staging folder');return file;}
function newStage(){fs.mkdirSync(staging,{recursive:true});const folder=fs.mkdtempSync(path.join(staging,'build-'));const root=path.join(folder,'CallShare-'+version());fs.mkdirSync(root);return root;}
function register(root){if(!inside(root,workspace))throw Error('Invalid publication path');const temp=pending+'.'+crypto.randomUUID();fs.writeFileSync(temp,JSON.stringify({version:version(),path:root}));fs.renameSync(temp,pending);}
module.exports={releasePath,mutableRelease,newStage,register,workspace,inside,version};
