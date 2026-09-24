import {createHash} from "node:crypto";
import {constants as F} from "node:fs";
import {open} from "node:fs/promises";
import {matchesSourceMetadata,pathMatchesSource,sameSessionTimelineSourceLocation,sourcePath}
from "./session-timeline-source.js";

const no=reason=>({status:"unavailable",reason});
async function handleDigest(handle,bytes){
const hash=createHash("sha256");
for(let offset=0;offset<bytes;){const buffer=Buffer.alloc(Math.min(65536,bytes-offset));
const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)return null;
hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}return hash.digest("hex");
}

export async function unchangedHandle(handle,source,hostHome=null){
try{return matchesSourceMetadata(await handle.stat({bigint:true}),source)&&await pathMatchesSource(source,hostHome);}
catch{return false;}
}

export async function validatedHandle(source,hostHome=null){
if(!await pathMatchesSource(source,hostHome))return no("transcript-changed");
let handle;try{handle=await open(source.path,F.O_RDONLY|(F.O_NOFOLLOW||0));}catch{return no("transcript-changed");}
if(!await unchangedHandle(handle,source,hostHome)){await handle.close();return no("transcript-changed");}
return {status:"open",handle,size:source.size};
}

export async function sourceSnapshotDigest(source,hostHome=null){
const opened=await validatedHandle(source,hostHome);if(opened.status!=="open")return null;
try{const value=await handleDigest(opened.handle,source.size);
return value&&await unchangedHandle(opened.handle,source,hostHome)?value:null;}finally{await opened.handle.close();}
}

async function appendHandle(source,hostHome,maximumBytes){
if(!/^[a-f0-9]{64}$/.test(source.snapshotDigest||""))return no("append-anchor-unavailable");
const resolved=await sourcePath(source.path,hostHome||source.profileRoot,source.binding.host);
const active=resolved.status==="registered"?{...resolved,binding:source.binding}:resolved;
if(active.status!=="registered"||!sameSessionTimelineSourceLocation(source,active)||active.size<source.size
||active.size>maximumBytes)return no(active.size>maximumBytes?"background-capture-budget":"transcript-changed");
let handle;try{handle=await open(active.path,F.O_RDONLY|(F.O_NOFOLLOW||0));}catch{return no("transcript-changed");}
if(await handleDigest(handle,source.size)!==source.snapshotDigest||!await unchangedHandle(handle,active,hostHome)){
await handle.close();return no("transcript-changed");}return {status:"open",handle,active};
}

export const MAX_BACKGROUND_CAPTURE_BYTES=262144;
export async function captureTimelineAppend({source,hostHome,maxBytes,parse}){
if(!source.snapshotDigest||source.indexedBytes!==source.size)return no("background-capture-unavailable");
const opened=await appendHandle(source,hostHome,MAX_BACKGROUND_CAPTURE_BYTES);if(opened.status!=="open")return opened;
try{if(opened.active.size===source.size)return {status:"indexed",next:source.size,size:source.size,events:[]};
const added=opened.active.size-source.size;if(added>maxBytes)return no("background-capture-budget");
const bytes=await readRange(opened.handle,source.size,added);
if(bytes.byteLength!==added||!await unchangedHandle(opened.handle,opened.active,hostHome))return no("transcript-changed");
const snapshotDigest=await handleDigest(opened.handle,opened.active.size);
if(!snapshotDigest||!await unchangedHandle(opened.handle,opened.active,hostHome))return no("transcript-changed");
return {status:"indexed",next:opened.active.size,size:opened.active.size,source:opened.active,snapshotDigest,
events:parse(bytes,source.size)};}finally{await opened.handle.close();}
}

export async function readRange(handle,offset,length){
const buffer=Buffer.alloc(length),{bytesRead}=await handle.read(buffer,0,length,offset);return buffer.subarray(0,bytesRead);
}
