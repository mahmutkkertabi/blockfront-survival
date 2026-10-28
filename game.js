import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';

// Multiplayer is peer-to-peer. PeerJS Cloud brokers the connection; gameplay state travels between browsers.
const worldChanges = new Map();
let generatingWorld = true;
let networkRole = 'solo';
let roomCode = '';
let peer = null;
let hostConnection = null;
const connections = new Map();
const remotePlayers = new Map();
let roomConnectionTimer = null;
let pendingHostConnections = 0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fc8e8);
scene.fog = new THREE.Fog(0x8fc8e8, 24, 65);
const camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, .1, 100);
camera.position.set(0,2.0,6);
scene.add(camera); // Camera-attached held items must be part of the scene graph.
const renderer = new THREE.WebGLRenderer({antialias:false});
renderer.setSize(innerWidth,innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const hemisphere = new THREE.HemisphereLight(0xd8f2ff,0x5c6446,2.1); scene.add(hemisphere);
const sun = new THREE.DirectionalLight(0xfff2cf,2.3); sun.position.set(-12,22,9); sun.castShadow=true; scene.add(sun);
const DAY_SKY = new THREE.Color(0x8fc8e8), NIGHT_SKY = new THREE.Color(0x111d39);
const DAY_FOG = new THREE.Color(0x8fc8e8), NIGHT_FOG = new THREE.Color(0x111d39);
const DAY_LENGTH = 90; // One game day lasts 90 seconds.
const NIGHT_START = 56, DAWN_START = 78;
let worldTime = 0, currentDay = 1, isNight = false, daySyncTick = 0;
const MAX_PLAYERS = 5;
const remotePlayerHitMeshes = [];
const mobHitMeshes = [];
const mobs = new Map();
const lastAttackAt = new Map();
const lastMobHitAt = new Map();
let mobCounter = 0, mobSpawnTimer = 0, mobSnapshotTimer = 0, mobTypeIndex = 0;
const MOB_TYPES = ['zombie','skeleton','creeper','spider','enderman'];
const MOB_DEFS = {
 zombie:{health:70,speed:1.45,damage:8,color:0x4eaa54,height:1.9},
 skeleton:{health:48,speed:1.15,damage:7,color:0xd7d9c9,height:1.95},
 creeper:{health:55,speed:1.25,damage:28,color:0x4da74b,height:1.8},
 spider:{health:40,speed:2.5,damage:6,color:0x252936,height:0.7},
 enderman:{health:95,speed:2.0,damage:10,color:0x24202f,height:2.8}
};
let localSpawnX = 0;

const materials = {
 grass:new THREE.MeshLambertMaterial({color:0x5da64d}),
 dirt:new THREE.MeshLambertMaterial({color:0x80553a}),
 stone:new THREE.MeshLambertMaterial({color:0x858d96}),
 wood:new THREE.MeshLambertMaterial({color:0x8d6038}),
 leaves:new THREE.MeshLambertMaterial({color:0x32784a}),
 sand:new THREE.MeshLambertMaterial({color:0xd9c17b}),
 ore:new THREE.MeshLambertMaterial({color:0x48c5cb}),
};
const cubeGeo = new THREE.BoxGeometry(1,1,1);
const blocks = new Map(), blockMeshes = [];
const key=(x,y,z)=>`${x},${y},${z}`;
const BLOCK_TYPES = new Set(['grass','dirt','stone','wood','leaves','sand','ore']);
const MAX_WORLD_XZ = 64;
const MIN_WORLD_Y = -10;
const MAX_WORLD_Y = 48;
const MAX_SNAPSHOT_CHANGES = 10000;
function isValidBlockKey(value) {
 if (typeof value !== 'string' || value.length > 18) return false;
 const match = /^(-?\d{1,3}),(-?\d{1,3}),(-?\d{1,3})$/.exec(value);
 if (!match) return false;
 const [x,y,z] = match.slice(1).map(Number);
 return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
   key(x,y,z) === value && Math.abs(x) <= MAX_WORLD_XZ &&
   y >= MIN_WORLD_Y && y <= MAX_WORLD_Y && Math.abs(z) <= MAX_WORLD_XZ;
}
function isValidBlockValue(value) {
 return value === null || (value !== null && typeof value === 'object' &&
   !Array.isArray(value) && BLOCK_TYPES.has(value.type) && typeof value.removable === 'boolean');
}
function networkBroadcast(message, exceptPeer=null) {
 if (networkRole === 'solo') return;
 if (networkRole === 'client') {
   if (hostConnection?.open) { try { hostConnection.send(message); } catch (err) { console.warn('Could not send network message', err); } }
   return;
 }
 for (const [id, conn] of connections) {
   if (id === exceptPeer || !conn.open) continue;
   try { conn.send(message); } catch (err) { console.warn('Could not send network message', err); }
 }
}
function addBlock(x,y,z,type='grass', removable=true, sync=true){
 const k=key(x,y,z); if(blocks.has(k)) return;
 const mesh=new THREE.Mesh(cubeGeo,materials[type]||materials.dirt);
 mesh.position.set(x,y,z); mesh.castShadow=true; mesh.receiveShadow=true;
 mesh.userData={x,y,z,type,removable}; scene.add(mesh); blocks.set(k,mesh); blockMeshes.push(mesh);
 if (!generatingWorld && sync) {
   const value={type,removable}; worldChanges.set(k,value);
   networkBroadcast({type:'block',key:k,value});
 }
}
function removeBlock(mesh, sync=true){
 const {x,y,z}=mesh.userData, k=key(x,y,z);
 blocks.delete(k); scene.remove(mesh); const i=blockMeshes.indexOf(mesh);if(i>=0)blockMeshes.splice(i,1);
 if (!generatingWorld && sync) {
   worldChanges.set(k,null);
   networkBroadcast({type:'block',key:k,value:null});
 }
}
function applyRemoteBlockChange(k,value){
 if (!isValidBlockKey(k) || !isValidBlockValue(value)) return;
 const parts=k.split(',').map(Number);
 worldChanges.set(k,value===null?null:{type:value.type,removable:value.removable});
 const old=blocks.get(k); if(old)removeBlock(old,false);
 if(value!==null) addBlock(parts[0],parts[1],parts[2],value.type,value.removable,false);
}
const rand=(x,z)=>{let n=Math.sin(x*127.1+z*311.7)*43758.5453;return n-Math.floor(n)};
function heightAt(x,z){return Math.floor(1+Math.sin(x*.23)*.6+Math.cos(z*.2)*.5+rand(x,z)*.7)};
for(let x=-22;x<=22;x++) for(let z=-22;z<=22;z++){
 const h=heightAt(x,z);
 for(let y=-2;y<h;y++) addBlock(x,y,z,y===h-1?'grass':y<-1?'stone':'dirt',true,false);
 if(rand(x,z)>.965 && Math.hypot(x,z)>4 && h<3){
   for(let y=h;y<h+3;y++) addBlock(x,y,z,'wood',true,false);
   for(let dx=-2;dx<=2;dx++) for(let dz=-2;dz<=2;dz++) for(let dy=2;dy<=4;dy++)
    if(Math.abs(dx)+Math.abs(dz)+(dy===4?1:0)<4 && rand(x+dx,z+dz+dy)>.12) addBlock(x+dx,h+dy,z+dz,'leaves',true,false);
 }
 if(rand(x*3,z*2)>.986 && h<=1) addBlock(x,h,z,'ore',true,false);
}
generatingWorld = false;
const groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshLambertMaterial({color:0x8fc8e8}));
groundPlane.rotation.x=-Math.PI/2;groundPlane.position.y=-2.6;scene.add(groundPlane);

const player={pos:new THREE.Vector3(0,2.3,6),vel:new THREE.Vector3(),yaw:0,pitch:0,grounded:false,health:100,hunger:100,blocks:24};
camera.position.copy(player.pos);
const keys={}; let locked=false, paused=true, selected=0, ammo=120, mag=30, reloading=false;
const weapons=[
 {name:'MINING PICK',icon:'⛏',kind:'mine'},
 {name:'PULSE PISTOL',icon:'▰',kind:'gun',damage:25,rate:320,color:0x5cf6ff},
 {name:'ASSAULT BLASTER',icon:'▥',kind:'gun',damage:14,rate:105,color:0xffc15c},
 {name:'MINIGUN',icon:'✹',kind:'gun',damage:7,rate:55,color:0xff784c},
 {name:'ENERGY SABER',icon:'⚔',kind:'melee',color:0x48aaff},
 {name:'BUILD BLOCK',icon:'▦',kind:'build'}
];
const hotbar=document.querySelector('#hotbar');
const heldItemRoot = new THREE.Group();
heldItemRoot.position.set(.44,-.37,-.72);
heldItemRoot.rotation.z = -.08;
camera.add(heldItemRoot);
function heldBox(parent,size,color,pos,rot=[0,0,0],emissive=0x000000){
 const mat=new THREE.MeshLambertMaterial({color,emissive,emissiveIntensity:emissive?0.7:0});
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size),mat);mesh.position.set(...pos);mesh.rotation.set(...rot);mesh.castShadow=false;mesh.frustumCulled=false;parent.add(mesh);return mesh;
}
function heldCylinder(parent,radius,height,color,pos,rot=[0,0,0],emissive=0x000000,segments=8){
 const mat=new THREE.MeshLambertMaterial({color,emissive,emissiveIntensity:emissive?0.9:0});
 const mesh=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,height,segments),mat);mesh.position.set(...pos);mesh.rotation.set(...rot);mesh.castShadow=false;mesh.frustumCulled=false;parent.add(mesh);return mesh;
}
function clearHeldItem(){
 while(heldItemRoot.children.length){const child=heldItemRoot.children[0];heldItemRoot.remove(child);child.traverse(obj=>{if(obj.geometry)obj.geometry.dispose();if(obj.material){if(Array.isArray(obj.material))obj.material.forEach(m=>m.dispose());else obj.material.dispose();}});}
}
function renderHeldItem(index=selected){
 clearHeldItem();
 // A small voxel forearm and glove remain visible with every selected item.
 heldBox(heldItemRoot,[.20,.30,.22],0x263c56,[.12,-.20,.13],[-.2,0,-.22]);
 heldBox(heldItemRoot,[.15,.25,.17],0xc58c65,[.02,-.31,-.05],[-.2,0,-.18]);
 const tool=new THREE.Group();heldItemRoot.add(tool);
 if(index===0){ // mining pick
   heldBox(tool,[.085,.76,.085],0x84572f,[-.12,-.04,0],[0,0,-.34]);
   heldBox(tool,[.48,.105,.13],0x9ca9b5,[-.10,.25,0],[0,0,-.10]);
   heldBox(tool,[.19,.10,.14],0xc6d0d9,[-.31,.28,0],[0,0,-.30]);
 }else if(index===1){ // pulse pistol
   heldBox(tool,[.25,.22,.42],0x273444,[-.02,-.05,-.06],[.05,0,0]);
   heldBox(tool,[.11,.14,.27],0x101923,[-.02,.01,-.39]);
   heldBox(tool,[.12,.24,.14],0x374a60,[-.01,-.24,.02],[.15,0,-.05]);
   heldBox(tool,[.15,.035,.25],0x5cf6ff,[-.02,.09,-.13],[0,0,0],0x2bbdca);
 }else if(index===2){ // assault blaster
   heldBox(tool,[.28,.23,.58],0x263342,[-.02,-.02,-.08]);
   heldBox(tool,[.12,.12,.46],0x121b25,[-.02,.02,-.53]);
   heldBox(tool,[.16,.13,.23],0x35495d,[-.02,-.02,.31]);
   heldBox(tool,[.12,.22,.15],0x1d2a38,[-.01,-.21,.03],[.12,0,-.08]);
   heldBox(tool,[.07,.035,.33],0xffbe59,[-.02,.11,-.20],[0,0,0],0x8e5019);
 }else if(index===3){ // minigun with four barrels
   heldBox(tool,[.35,.32,.43],0x303e50,[-.02,-.03,-.10]);
   for(const x of [-.105,.035])for(const y of [-.07,.07]){
     heldCylinder(tool,.045,.48,0x8d9ba8,[x,y+.02,-.48],[Math.PI/2,0,0],0x000000,8);
     heldCylinder(tool,.049,.06,0xff794b,[x,y+.02,-.75],[Math.PI/2,0,0],0x5c1d0e,8);
   }
   heldBox(tool,[.20,.12,.20],0x1b2835,[-.02,-.22,.12],[.12,0,0]);
   heldBox(tool,[.18,.035,.25],0xff794b,[-.02,.15,-.10],[0,0,0],0x8e2919);
 }else if(index===4){ // original glowing energy saber, with a vertical blade in view
   heldCylinder(tool,.075,.30,0x5d6877,[-.03,-.18,-.05],[Math.PI/2,0,0],0x000000,8);
   heldCylinder(tool,.092,.08,0x202b3d,[-.03,-.28,-.05],[Math.PI/2,0,0],0x000000,8);
   heldBox(tool,[.12,.035,.05],0xc5d5e4,[-.03,-.13,-.05]);
   heldCylinder(tool,.045,.95,0x55c9ff,[-.03,.36,-.05],[0,0,0],0x249dff,8);
   heldCylinder(tool,.071,.91,0x6ee3ff,[-.03,.36,-.05],[0,0,0],0x43a9ff,8);
 }else{ // placeable voxel block
   heldBox(tool,[.36,.36,.36],0x80553a,[-.02,-.02,-.10],[.28,.45,.1]);
   heldBox(tool,[.365,.045,.365],0x5da64d,[-.02,.165,-.10],[.28,.45,.1]);
 }
}
function drawHotbar(){hotbar.innerHTML='';weapons.forEach((w,i)=>{const d=document.createElement('div');d.className='slot'+(i===selected?' active':'');d.innerHTML=`<span class="num">${i+1}</span><span class="emoji">${w.icon}</span><span>${w.name}</span>`;hotbar.appendChild(d)});document.querySelector('#weaponLabel').textContent=`${selected+1} · ${weapons[selected].name} ${[1,2,3].includes(selected+1)?`· ${mag}/${ammo}`:''}`;renderHeldItem(selected);}
drawHotbar();
const overlay=document.querySelector('#overlay');
const startButton=document.querySelector('#start');
const netStatus=document.querySelector('#netStatus');
const roomInfo=document.querySelector('#roomInfo');
const roomCodeLabel=document.querySelector('#roomCode');
const statusLabel=document.querySelector('#status');
function setNetworkStatus(text){netStatus.textContent=text;}
function updateRoomStatus(){
 const phase=isNight?'NIGHT':'DAYLIGHT';
 const count=networkRole==='host'?1+connections.size:(networkRole==='client'&&hostConnection?.open?1+remotePlayers.size:1);
 if(networkRole==='host') statusLabel.textContent=`DAY ${currentDay} · ${phase} · PLAYERS ${count}/${MAX_PLAYERS} · ROOM ${roomCode}`;
 else if(networkRole==='client') statusLabel.textContent=`DAY ${currentDay} · ${phase} · PLAYERS ${count}/${MAX_PLAYERS} · ROOM ${roomCode}`;
 else statusLabel.textContent=`DAY ${currentDay} · ${phase} · SOLO`;
}
function updateDayCycle(){
 const phaseTime=((worldTime%DAY_LENGTH)+DAY_LENGTH)%DAY_LENGTH;
 const nextDay=Math.floor(worldTime/DAY_LENGTH)+1;
 const nextNight=phaseTime>=NIGHT_START&&phaseTime<DAWN_START;
 let darkness=nextNight?1:0;
 if(phaseTime>=NIGHT_START&&phaseTime<NIGHT_START+7) darkness=(phaseTime-NIGHT_START)/7;
 else if(phaseTime>=DAWN_START-7&&phaseTime<DAWN_START) darkness=(DAWN_START-phaseTime)/7;
 darkness=Math.max(0,Math.min(1,darkness));
 const changed=nextDay!==currentDay||nextNight!==isNight;
 currentDay=nextDay;isNight=nextNight;
 scene.background.copy(DAY_SKY).lerp(NIGHT_SKY,darkness);
 scene.fog.color.copy(DAY_FOG).lerp(NIGHT_FOG,darkness);
 hemisphere.intensity=2.1-1.1*darkness;
 sun.intensity=2.3-1.85*darkness;
 if(changed)updateRoomStatus();
}
function createRoomCode(){
 const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
 // 32 symbols, 10 cryptographically random characters (50 bits of entropy).
 const bytes=crypto.getRandomValues(new Uint8Array(10));
 return Array.from(bytes,b=>chars[b & 31]).join('');
}
function localPlayerState(){
 return {name:networkRole==='host'?'HOST':'PLAYER',pos:{x:player.pos.x,y:player.pos.y-1.6,z:player.pos.z},yaw:player.yaw,pitch:player.pitch,health:player.health,held:selected};
}
function applyLocalDamage(amount,source='friend'){
 player.health=Math.max(0,player.health-amount);updateStats();
 if(player.health<=0){
   player.health=100;player.pos.set(localSpawnX,2.3,6);player.vel.set(0,0,0);camera.position.copy(player.pos);updateStats();
   say(`Defeated by ${source}. Respawned!`);
 }else say(`Hit by ${source}!`);
}
function handlePlayerAttack(attackerPeerId,targetPeerId,weaponIndex){
 if(networkRole!=='host'||!peer||typeof targetPeerId!=='string'||attackerPeerId===targetPeerId||!Number.isInteger(weaponIndex)||weaponIndex<0||weaponIndex>=weapons.length)return;
 if(targetPeerId!==peer.id&&!connections.has(targetPeerId))return;
 if(attackerPeerId!==peer.id&&!connections.has(attackerPeerId))return;
 const w=weapons[weaponIndex];
 const damageByWeapon=[24,25,14,7,45,0];const rangeByWeapon=[3.5,30,30,30,3.7,0];
 const damage=damageByWeapon[weaponIndex],range=rangeByWeapon[weaponIndex];if(!damage||!range)return;
 const now=Date.now(),last=lastAttackAt.get(attackerPeerId)||0;
 if(now-last<Math.max(55,(w.rate||250)*.75))return;
 lastAttackAt.set(attackerPeerId,now);
 const attacker=attackerPeerId===peer.id?localPlayerState():remotePlayers.get(attackerPeerId)?.state;
 const target=targetPeerId===peer.id?localPlayerState():remotePlayers.get(targetPeerId)?.state;
 if(!attacker?.pos||!target?.pos)return;
 const origin=new THREE.Vector3(attacker.pos.x,attacker.pos.y+1.6,attacker.pos.z);
 const center=new THREE.Vector3(target.pos.x,target.pos.y+1.0,target.pos.z);
 const delta=center.clone().sub(origin);const distance=delta.length();if(distance>range||distance<.05)return;
 const yaw=Number(attacker.yaw)||0,pitch=Number(attacker.pitch)||0;
 const direction=new THREE.Vector3(-Math.sin(yaw)*Math.cos(pitch),-Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)).normalize();
 if(direction.dot(delta.normalize())<.88)return;
 if(targetPeerId===peer.id){applyLocalDamage(damage);networkBroadcast({type:'state',state:localPlayerState()});}
 else safePeerSend(connections.get(targetPeerId),{type:'damage',amount:damage,from:attackerPeerId});
 if(attackerPeerId===peer.id)say(`Hit friend for ${damage} damage`);
}
function requestPlayerAttack(targetPeerId,weaponIndex){
 if(networkRole==='host'){handlePlayerAttack(peer?.id,targetPeerId,weaponIndex);}
 else if(networkRole==='client'&&hostConnection?.open){safePeerSend(hostConnection,{type:'attack',targetPeerId,weaponIndex});say('Attack sent');}
}
function safePeerSend(conn,message){if(conn?.open){try{conn.send(message);}catch(err){console.warn(err);}}}
function sendSnapshot(conn){safePeerSend(conn,{type:'snapshot',changes:Array.from(worldChanges.entries())});}
function createNameSprite(label){
 const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;const ctx=canvas.getContext('2d');
 ctx.fillStyle='rgba(10,24,39,.84)';ctx.fillRect(6,6,244,52);ctx.strokeStyle='#8cebd8';ctx.lineWidth=3;ctx.strokeRect(7,7,242,50);
 ctx.font='bold 28px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#ffffff';ctx.fillText(label.slice(0,16),128,32);
 const tex=new THREE.CanvasTexture(canvas);const mat=new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false});const sprite=new THREE.Sprite(mat);sprite.scale.set(2.0,.5,1);return sprite;
}
function makeRemoteHeldProp(index=0){
 const root=new THREE.Group();
 const box=(size,color,pos,rot=[0,0,0])=>{const m=new THREE.Mesh(new THREE.BoxGeometry(...size),new THREE.MeshLambertMaterial({color}));m.position.set(...pos);m.rotation.set(...rot);root.add(m);return m;};
 const cylinder=(radius,height,color,pos,rot=[0,0,0],emissive=0)=>{const m=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,height,8),new THREE.MeshLambertMaterial({color,emissive}));m.position.set(...pos);m.rotation.set(...rot);root.add(m);return m;};
 root.position.set(.43,1.03,-.12);
 if(index===0){box([.07,.52,.07],0x84572f,[0,0,0],[0,0,-.3]);box([.32,.08,.09],0xb0bdc8,[-.05,.2,0]);}
 else if(index===1){box([.16,.15,.3],0x293b4e,[0,0,-.08]);box([.07,.08,.22],0x0d1721,[0,.02,-.31]);box([.10,.025,.18],0x5cf6ff,[0,.07,-.08]);}
 else if(index===2){box([.2,.17,.42],0x263342,[0,0,-.08]);box([.08,.08,.35],0x101923,[0,.02,-.42]);box([.06,.025,.25],0xffbe59,[0,.09,-.16]);}
 else if(index===3){box([.25,.23,.3],0x303e50,[0,0,-.08]);for(const x of [-.07,.07])for(const y of [-.06,.06])cylinder(.028,.35,0x8d9ba8,[x,y,-.38],[Math.PI/2,0,0]);}
 else if(index===4){cylinder(.05,.24,0x5d6877,[0,-.05,0],[Math.PI/2,0,0]);cylinder(.035,.7,0x55c9ff,[0,.42,0],[0,0,0],0x249dff);}
 else box([.28,.28,.28],0x80553a,[0,0,-.07]);
 return root;
}
function createRemotePlayer(peerId,state){
 const group=new THREE.Group();
 const hitMeshes=[];
 const color=new THREE.Color().setHSL((Math.abs(hashString(peerId))%360)/360,.62,.48);
 const bodyMat=new THREE.MeshLambertMaterial({color});const trimMat=new THREE.MeshLambertMaterial({color:0x243b4f});const headMat=new THREE.MeshLambertMaterial({color:0xe4b990});
 const addHitPart=(geometry,material,position)=>{
   const mesh=new THREE.Mesh(geometry,material);mesh.position.set(...position);mesh.castShadow=true;mesh.userData.remotePeerId=peerId;group.add(mesh);hitMeshes.push(mesh);remotePlayerHitMeshes.push(mesh);return mesh;
 };
 addHitPart(new THREE.BoxGeometry(.62,.82,.34),bodyMat,[0,.92,0]);
 addHitPart(new THREE.BoxGeometry(.42,.42,.42),headMat,[0,1.58,0]);
 for(const side of [-1,1]){addHitPart(new THREE.BoxGeometry(.2,.68,.22),bodyMat,[side*.42,.94,0]);addHitPart(new THREE.BoxGeometry(.24,.55,.27),trimMat,[side*.17,.27,0]);}
 const label=createNameSprite(state?.name||'FRIEND');label.position.y=2.25;group.add(label);
 const heldIndex=Number.isInteger(state?.held)&&state.held>=0&&state.held<weapons.length?state.held:0;
 const heldProp=makeRemoteHeldProp(heldIndex);group.add(heldProp);
 scene.add(group);const record={group,target:new THREE.Vector3(),yaw:0,state:state||{},heldIndex,heldProp,hitMeshes};remotePlayers.set(peerId,record);return record;
}
function hashString(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return h;}
function updateRemotePlayer(peerId,state){
 if(!state||typeof state!=='object'||!state.pos||typeof state.pos!=='object' ||
   ![state.pos.x,state.pos.y,state.pos.z,state.yaw].every(Number.isFinite) ||
   Math.abs(state.pos.x)>128 || Math.abs(state.pos.z)>128 || state.pos.y < -10 || state.pos.y > 50) return;
 if (typeof state.name !== 'string') state = {...state,name:'FRIEND'};
 let remote=remotePlayers.get(peerId);if(!remote)remote=createRemotePlayer(peerId,state);
 remote.target.set(state.pos.x,state.pos.y,state.pos.z);remote.yaw=Number(state.yaw)||0;remote.state=state;
 const heldIndex=Number.isInteger(state.held)&&state.held>=0&&state.held<weapons.length?state.held:0;
 if(heldIndex!==remote.heldIndex){remote.group.remove(remote.heldProp);remote.heldProp.traverse(obj=>{if(obj.geometry)obj.geometry.dispose();if(obj.material)obj.material.dispose();});remote.heldProp=makeRemoteHeldProp(heldIndex);remote.group.add(remote.heldProp);remote.heldIndex=heldIndex;}
}
function removeRemotePlayer(peerId){const remote=remotePlayers.get(peerId);if(remote){scene.remove(remote.group);for(const mesh of remote.hitMeshes||[]){const i=remotePlayerHitMeshes.indexOf(mesh);if(i>=0)remotePlayerHitMeshes.splice(i,1);}remote.group.traverse(obj=>{if(obj.geometry)obj.geometry.dispose();if(obj.material){if(Array.isArray(obj.material))obj.material.forEach(m=>m.dispose());else obj.material.dispose();}});remotePlayers.delete(peerId);updateRoomStatus();}}
function refreshNetworkUi(){updateRoomStatus();if(networkRole==='host')setNetworkStatus(`Room is ready for up to ${MAX_PLAYERS} players. Send code ${roomCode} to four friends. Connected players: ${1+connections.size}/${MAX_PLAYERS}.`);else if(networkRole==='client')setNetworkStatus(hostConnection?.open?`Connected to room ${roomCode}. You can enter the world.`:`Connecting to room ${roomCode}…`);}
function registerConnection(conn){
 conn.on('open',()=>{
   connections.set(conn.peer,conn);
   if(networkRole==='host'){
     sendSnapshot(conn);
     safePeerSend(conn,{type:'spawn',slot:Math.min(MAX_PLAYERS-1,connections.size)});
     safePeerSend(conn,{type:'dayState',elapsed:worldTime});
     safePeerSend(conn,{type:'state',state:localPlayerState()});
     sendMobSnapshot(conn);
     for(const [id,remote] of remotePlayers) safePeerSend(conn,{type:'state',state:remote.state});
   }else if(networkRole==='client'){
     hostConnection=conn;startButton.disabled=false;startButton.textContent='ENTER WORLD';
     if(roomConnectionTimer){clearTimeout(roomConnectionTimer);roomConnectionTimer=null;}
     say('Connected to multiplayer room');
   }
   refreshNetworkUi();
 });
 conn.on('data',message=>{
   if(!message||typeof message!=='object')return;
   if(message.type==='room-full'){setNetworkStatus('This room is full. A room supports 5 players total.');startButton.disabled=true;return;}
   if(message.type==='spawn'&&networkRole==='client'&&Number.isInteger(message.slot)&&message.slot>=1&&message.slot<MAX_PLAYERS){const spawnOffsets=[0,-3,3,-6,6];localSpawnX=spawnOffsets[message.slot]??0;player.pos.set(localSpawnX,2.3,6);camera.position.copy(player.pos);}
   else if(message.type==='damage'&&networkRole==='client'&&Number.isFinite(message.amount)){applyLocalDamage(Math.max(0,Math.min(50,message.amount)),typeof message.source==='string'?message.source:'friend');}
   else if(message.type==='attack'&&networkRole==='host'){handlePlayerAttack(conn.peer,message.targetPeerId,message.weaponIndex);}
   else if(message.type==='mobHit'&&networkRole==='host'&&typeof message.mobId==='string'){handleMobHit(conn.peer,message.mobId,message.weaponIndex);}
   else if(message.type==='mobSnapshot'&&networkRole==='client'&&Array.isArray(message.mobs)&&message.mobs.length<=16){syncMobSnapshot(message.mobs);}
   else if(message.type==='dayState'&&networkRole==='client'&&Number.isFinite(message.elapsed)&&message.elapsed>=0&&message.elapsed<864000){worldTime=message.elapsed;updateDayCycle();}
   else if(message.type==='snapshot'&&Array.isArray(message.changes)&&message.changes.length<=MAX_SNAPSHOT_CHANGES){
     for(const entry of message.changes){if(Array.isArray(entry)&&entry.length===2)applyRemoteBlockChange(entry[0],entry[1]);}
     say('World changes synchronized');
   }else if(message.type==='block'&&isValidBlockKey(message.key)&&isValidBlockValue(message.value)){
     applyRemoteBlockChange(message.key,message.value);
     if(networkRole==='host')networkBroadcast(message,conn.peer);
   }else if(message.type==='state'&&message.state){
     updateRemotePlayer(conn.peer,message.state);
     if(networkRole==='host')networkBroadcast(message,conn.peer);
   }else if(message.type==='leave'&&typeof message.peerId==='string'){
     removeRemotePlayer(message.peerId);
   }else if(message.type==='goodbye'){
     removeRemotePlayer(conn.peer);
   }
 });
 conn.on('close',()=>{
   connections.delete(conn.peer);removeRemotePlayer(conn.peer);
   if(networkRole==='host')networkBroadcast({type:'leave',peerId:conn.peer});
   if(networkRole==='client'&&hostConnection===conn){hostConnection=null;startButton.disabled=true;setNetworkStatus('Disconnected from host. Return to the menu and reconnect.');}
   refreshNetworkUi();
 });
 conn.on('error',err=>{console.warn('Peer connection error',err);setNetworkStatus('Connection issue: '+(err?.type||err?.message||'unknown error'));});
}
function stopNetwork(){
 if(roomConnectionTimer){clearTimeout(roomConnectionTimer);roomConnectionTimer=null;}
 for(const conn of connections.values()){try{conn.close();}catch{}}
 connections.clear();pendingHostConnections=0;hostConnection=null;
 for(const id of [...remotePlayers.keys()])removeRemotePlayer(id);
 if(peer){try{peer.destroy();}catch{}peer=null;}
 networkRole='solo';roomCode='';roomInfo.hidden=true;startButton.disabled=true;startButton.textContent='ENTER WORLD';updateRoomStatus();
}
function ensurePeerAvailable(){if(!window.Peer){setNetworkStatus('PeerJS could not load. Check internet and reload this page.');return false;}return true;}
document.querySelector('#hostRoom').addEventListener('click',()=>{
 if(!ensurePeerAvailable())return;stopNetwork();const code=createRoomCode();roomCode=code;networkRole='host';setNetworkStatus('Creating room…');
 peer=new window.Peer('bf'+code.toLowerCase());
 peer.on('open',()=>{roomInfo.hidden=false;roomCodeLabel.textContent=roomCode;startButton.disabled=false;startButton.textContent='ENTER WORLD';refreshNetworkUi();});
 peer.on('connection',conn=>{
   // Host plus two guests: at most three players in a room.
   if(networkRole!=='host' || connections.size + pendingHostConnections >= MAX_PLAYERS - 1){
     conn.on('open',()=>{safePeerSend(conn,{type:'room-full'});conn.close();});
     return;
   }
   pendingHostConnections++;
   let released=false;
   const releaseClaim=()=>{if(!released){released=true;pendingHostConnections=Math.max(0,pendingHostConnections-1);}};
   conn.on('open',releaseClaim);conn.on('close',releaseClaim);
   registerConnection(conn);
 });
 peer.on('error',err=>{console.warn('PeerJS error',err);if(err?.type==='unavailable-id')setNetworkStatus('That room code is already in use. Click CREATE MULTIPLAYER ROOM again.');else setNetworkStatus('Could not create/join room: '+(err?.type||err?.message||'check internet connection'));if(networkRole==='client')startButton.disabled=true;});
});
document.querySelector('#joinRoom').addEventListener('click',()=>{
 if(!ensurePeerAvailable())return;const code=document.querySelector('#joinCode').value.trim().toUpperCase();
 if(!/^[A-HJ-NP-Z2-9]{10}$/.test(code)){setNetworkStatus('Enter the 10-character room code exactly as your friend shared it.');return;}
 stopNetwork();roomCode=code;networkRole='client';setNetworkStatus('Connecting to room '+code+'…');startButton.disabled=true;
 peer=new window.Peer();
 peer.on('open',()=>{
   const conn=peer.connect('bf'+code.toLowerCase(),{reliable:true});hostConnection=conn;registerConnection(conn);
   roomConnectionTimer=setTimeout(()=>{if(!hostConnection?.open){setNetworkStatus('Could not connect. Check the room code and make sure the host is online.');startButton.disabled=true;}},12000);
 });
 peer.on('error',err=>{console.warn('PeerJS error',err);setNetworkStatus('Connection failed: '+(err?.type||err?.message||'check internet connection'));startButton.disabled=true;});
});
document.querySelector('#solo').addEventListener('click',()=>{stopNetwork();networkRole='solo';startButton.disabled=false;startButton.textContent='ENTER WORLD';roomInfo.hidden=true;setNetworkStatus('Solo mode selected. No other player will join this world.');updateRoomStatus();});
document.querySelector('#copyRoom').addEventListener('click',async()=>{
 try{await navigator.clipboard.writeText(roomCode);setNetworkStatus('Room code copied. Send it to your friend.');}
 catch{setNetworkStatus('Your room code is '+roomCode+'. Select and copy it manually.');}
});
startButton.addEventListener('click',()=>{if(startButton.disabled)return;renderer.domElement.requestPointerLock();paused=false;overlay.style.display='none';});
document.addEventListener('pointerlockchange',()=>{locked=document.pointerLockElement===renderer.domElement;if(!locked&&!paused){paused=true;overlay.style.display='grid';startButton.textContent='RESUME WORLD';}});
document.addEventListener('mousemove',e=>{if(!locked)return;player.yaw-=e.movementX*.0022;player.pitch-=e.movementY*.0022;player.pitch=Math.max(-1.45,Math.min(1.45,player.pitch));});
document.addEventListener('keydown',e=>{keys[e.code]=true;if(/^Digit[1-6]$/.test(e.code)){selected=Number(e.code.slice(5))-1;drawHotbar()}if(e.code==='KeyR')reload();});
document.addEventListener('wheel',e=>{
 if(!locked)return;e.preventDefault();
 const direction=e.deltaY>0?1:-1;selected=(selected+direction+weapons.length)%weapons.length;drawHotbar();
},{passive:false});
document.addEventListener('keyup',e=>keys[e.code]=false);
document.addEventListener('contextmenu',e=>e.preventDefault());
let lastUse=0;
renderer.domElement.addEventListener('mousedown',e=>{if(!locked)return;if(e.button===0)useWeapon();if(e.button===2)placeBlock();});
function say(msg){const el=document.querySelector('#message');el.textContent=msg;el.style.opacity=1;clearTimeout(say.timer);say.timer=setTimeout(()=>el.style.opacity=0,1400);}
const raycaster=new THREE.Raycaster();raycaster.far=5;
const playerRaycaster=new THREE.Raycaster();
function mobMaterial(color,emissive=0x000000){return new THREE.MeshLambertMaterial({color,emissive,emissiveIntensity:emissive?0.9:0});}
function disposeMob(mob){
 if(!mob)return;scene.remove(mob.group);
 for(const mesh of mob.hitMeshes){const i=mobHitMeshes.indexOf(mesh);if(i>=0)mobHitMeshes.splice(i,1);}
 mob.group.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material){if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material.dispose();}});
 mobs.delete(mob.id);
}
function createMob(id,type,state){
 const def=MOB_DEFS[type];if(!def)return null;
 const group=new THREE.Group(),hitMeshes=[];
 const part=(size,color,pos,rot=[0,0,0],hit=true,emissive=0)=>{
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size),mobMaterial(color,emissive));mesh.position.set(...pos);mesh.rotation.set(...rot);mesh.castShadow=true;mesh.receiveShadow=true;mesh.userData.mobId=id;group.add(mesh);
  if(hit){hitMeshes.push(mesh);mobHitMeshes.push(mesh);}return mesh;
 };
 if(type==='zombie'){
  part([.58,.78,.32],0x367c43,[0,.91,0]);part([.48,.48,.46],0x4dab5e,[0,1.57,0]);
  part([.19,.73,.20],0x367c43,[-.42,.94,0],[0,0,-.12]);part([.19,.73,.20],0x367c43,[.42,.94,0],[0,0,.12]);
  part([.23,.52,.25],0x344b9a,[-.17,.27,0]);part([.23,.52,.25],0x344b9a,[.17,.27,0]);
  part([.07,.07,.035],0x171c18,[-.13,1.63,-.235]);part([.07,.07,.035],0x171c18,[.13,1.63,-.235]);
 }else if(type==='skeleton'){
  part([.28,.82,.20],0xd7d9c9,[0,.94,0]);part([.43,.44,.39],0xe4e2d4,[0,1.62,0]);
  part([.11,.74,.12],0xc9ccbf,[-.31,.94,0],[0,0,-.12]);part([.11,.74,.12],0xc9ccbf,[.31,.94,0],[0,0,.12]);
  part([.13,.52,.14],0xb6b9ae,[-.13,.27,0]);part([.13,.52,.14],0xb6b9ae,[.13,.27,0]);
  part([.07,.08,.04],0x312c26,[-.12,1.67,-.205]);part([.07,.08,.04],0x312c26,[.12,1.67,-.205]);
  part([.06,.42,.06],0x6b5137,[.48,.96,.05],[0,0,.35]);part([.35,.05,.05],0x9f875f,[.49,1.13,.05]);
 }else if(type==='creeper'){
  part([.62,1.10,.42],0x4fa64b,[0,.82,0]);part([.55,.55,.50],0x59b44f,[0,1.57,-.02]);
  for(const x of [-.20,.20])for(const z of [-.13,.13])part([.18,.34,.18],0x3b813c,[x,.18,z]);
  part([.12,.15,.04],0x18271b,[-.12,1.62,-.278]);part([.12,.15,.04],0x18271b,[.12,1.62,-.278]);part([.24,.13,.04],0x18271b,[0,1.40,-.28]);
  part([.10,.10,.035],0x18271b,[-.08,1.35,-.28]);part([.10,.10,.035],0x18271b,[.08,1.35,-.28]);
 }else if(type==='spider'){
  part([.62,.34,.75],0x252936,[0,.34,0]);part([.42,.30,.39],0x313846,[0,.31,-.48]);
  part([.09,.09,.05],0xe64c4c,[-.13,.37,-.68],[0,0,0],true,0x9b2020);part([.09,.09,.05],0xe64c4c,[.13,.37,-.68],[0,0,0],true,0x9b2020);
  for(const side of [-1,1])for(const z of [-.48,-.24,0,.24])part([.58,.075,.075],0x171b23,[side*.48,.20,z],[0,side*(z<0?-.45:.45),side*.12]);
 }else if(type==='enderman'){
  part([.34,1.08,.28],0x201b2c,[0,1.52,0]);part([.42,.44,.38],0x211c2c,[0,2.34,0]);
  part([.12,1.14,.13],0x171522,[-.30,1.53,0],[0,0,-.03]);part([.12,1.14,.13],0x171522,[.30,1.53,0],[0,0,.03]);
  part([.13,.90,.14],0x171522,[-.12,.48,0]);part([.13,.90,.14],0x171522,[.12,.48,0]);
  part([.10,.055,.035],0xc16aff,[-.12,2.38,-.205],[0,0,0],true,0x8a31d8);part([.10,.055,.035],0xc16aff,[.12,2.38,-.205],[0,0,0],true,0x8a31d8);
 }
 const h=def.height;
 const barBack=new THREE.Mesh(new THREE.BoxGeometry(.82,.07,.035),mobMaterial(0x191d25));barBack.position.set(0,h+.36,0);barBack.userData.noHit=true;group.add(barBack);
 const barFill=new THREE.Mesh(new THREE.BoxGeometry(.76,.045,.04),mobMaterial(0x53e06b));barFill.position.set(0,h+.36,-.025);barFill.userData.noHit=true;group.add(barFill);
 const label=createNameSprite(type.toUpperCase());label.position.y=h+.64;label.scale.set(1.5,.36,1);group.add(label);
 const x=Number.isFinite(state.x)?state.x:0,z=Number.isFinite(state.z)?state.z:0,y=Number.isFinite(state.y)?state.y:heightAt(Math.round(x),Math.round(z))-.5;
 group.position.set(x,y,z);scene.add(group);
 const mob={id,type,group,hitMeshes,target:new THREE.Vector3(x,y,z),yaw:Number(state.yaw)||0,health:Number.isFinite(state.health)?state.health:def.health,maxHealth:def.health,attackCooldown:1+Math.random(),fuse:Number(state.fuse)||0,teleportCooldown:5+Math.random()*4,barFill,def};
 mob.health=Math.max(0,Math.min(mob.maxHealth,mob.health));barFill.scale.x=Math.max(.01,mob.health/mob.maxHealth);barFill.position.x=-.38*(1-mob.health/mob.maxHealth);
 mobs.set(id,mob);return mob;
}
function updateMobHealthBar(mob){const fraction=Math.max(0,Math.min(1,mob.health/mob.maxHealth));mob.barFill.scale.x=Math.max(.001,fraction);mob.barFill.position.x=-.38*(1-fraction);}
function ensureMob(id,type,state){
 if(!MOB_TYPES.includes(type)||typeof id!=='string'||id.length>80)return null;
 let mob=mobs.get(id);if(!mob)mob=createMob(id,type,state||{});if(!mob)return null;
 if(state&&Number.isFinite(state.x)&&Number.isFinite(state.y)&&Number.isFinite(state.z))mob.target.set(state.x,state.y,state.z);
 if(state&&Number.isFinite(state.health)){mob.health=Math.max(0,Math.min(mob.maxHealth,state.health));updateMobHealthBar(mob);}
 if(state&&Number.isFinite(state.yaw))mob.yaw=state.yaw;
 if(state&&Number.isFinite(state.fuse))mob.fuse=Math.max(0,Math.min(2,state.fuse));
 return mob;
}
function serializeMobs(){return [...mobs.values()].filter(m=>m.health>0).map(m=>({id:m.id,type:m.type,x:m.group.position.x,y:m.group.position.y,z:m.group.position.z,yaw:m.yaw,health:m.health,fuse:m.fuse}));}
function sendMobSnapshot(conn){safePeerSend(conn,{type:'mobSnapshot',mobs:serializeMobs()});}
function syncMobSnapshot(list){
 const seen=new Set();
 for(const state of list){
  if(!state||typeof state.id!=='string'||!MOB_TYPES.includes(state.type)||![state.x,state.y,state.z,state.health].every(Number.isFinite)||Math.abs(state.x)>64||Math.abs(state.z)>64||state.y< -10||state.y>50)continue;
  seen.add(state.id);ensureMob(state.id,state.type,state);
 }
 for(const [id,mob] of [...mobs])if(!seen.has(id))disposeMob(mob);
}
function mobTargetList(){
 const out=[];
 if(networkRole==='solo')out.push({id:'local',x:player.pos.x,z:player.pos.z,local:true});
 else if(networkRole==='host')out.push({id:peer?.id||'host',x:player.pos.x,z:player.pos.z,local:true});
 if(networkRole==='host')for(const [id,remote] of remotePlayers){const p=remote.state?.pos;if(p&&Number.isFinite(p.x)&&Number.isFinite(p.z))out.push({id,x:p.x,z:p.z,local:false});}
 return out;
}
function closestMobTarget(mob){const targets=mobTargetList();let best=null,bestDistance=Infinity;for(const t of targets){const d=Math.hypot(t.x-mob.group.position.x,t.z-mob.group.position.z);if(d<bestDistance){best=t;bestDistance=d;}}return best?{...best,distance:bestDistance}:null;}
function applyMobDamageToPlayer(target,amount,mobType){
 if(target.local){applyLocalDamage(amount,mobType);if(networkRole==='host')networkBroadcast({type:'state',state:localPlayerState()});}
 else if(networkRole==='host')safePeerSend(connections.get(target.id),{type:'damage',amount,source:mobType});
}
function showMobAttackLine(from,to,color=0xd8d6cc){const geo=new THREE.BufferGeometry().setFromPoints([from,to]);const line=new THREE.Line(geo,new THREE.LineBasicMaterial({color}));scene.add(line);setTimeout(()=>{scene.remove(line);geo.dispose();line.material.dispose();},180);}
function updateMobs(dt){
 if(networkRole==='client')return;
 mobSpawnTimer+=dt;const limit=isNight?12:7,interval=isNight?4.5:8.5;
 if(mobs.size<limit&&mobSpawnTimer>=interval){mobSpawnTimer=0;spawnMob(MOB_TYPES[mobTypeIndex%MOB_TYPES.length]);mobTypeIndex++;}
 for(const mob of [...mobs.values()]){
  const target=closestMobTarget(mob);if(!target)continue;
  const pos=mob.group.position;let dx=target.x-pos.x,dz=target.z-pos.z;let distance=Math.hypot(dx,dz);
  mob.attackCooldown=Math.max(0,mob.attackCooldown-dt);mob.teleportCooldown=Math.max(0,mob.teleportCooldown-dt);
  if(mob.type==='creeper'&&distance<3.3){mob.fuse+=dt;mob.group.scale.setScalar(1+Math.sin(mob.fuse*18)*.055);if(mob.fuse>=1.7){
    const center=new THREE.Vector3(pos.x,pos.y+.5,pos.z);for(const t of mobTargetList()){const d=Math.hypot(t.x-pos.x,t.z-pos.z);if(d<4.4)applyMobDamageToPlayer(t,Math.max(6,Math.round(34*(1-d/5))),mob.type);}
    const flash=new THREE.Mesh(new THREE.SphereGeometry(2.8,8,6),new THREE.MeshBasicMaterial({color:0xffd36b,transparent:true,opacity:.55,wireframe:true}));flash.position.copy(center);scene.add(flash);setTimeout(()=>{scene.remove(flash);flash.geometry.dispose();flash.material.dispose();},250);disposeMob(mob);continue;
  }}else if(mob.type==='creeper'){mob.fuse=Math.max(0,mob.fuse-dt*1.5);mob.group.scale.setScalar(1);}
  if(mob.type==='enderman'&&distance<6&&mob.teleportCooldown<=0){const angle=Math.random()*Math.PI*2;const nx=Math.max(-20,Math.min(20,Math.round(target.x+Math.cos(angle)*6)));const nz=Math.max(-20,Math.min(20,Math.round(target.z+Math.sin(angle)*6)));pos.set(nx,heightAt(nx,nz)-.5,nz);mob.target.copy(pos);mob.teleportCooldown=6+Math.random()*4;continue;}
  const chaseRange=mob.type==='skeleton'?11:40;
  if(distance> (mob.type==='spider'?1.3:1.45) && distance<chaseRange){
   const speed=mob.def.speed*(isNight?1.1:1);if(distance>0){pos.x+=(dx/distance)*speed*dt;pos.z+=(dz/distance)*speed*dt;}
   const groundY=heightAt(Math.round(pos.x),Math.round(pos.z))-.5;pos.y+=Math.max(-1,Math.min(1,groundY-pos.y))*Math.min(1,dt*6);
   mob.yaw=Math.atan2(dx,-dz);
  }
  if(mob.attackCooldown<=0){
   if(mob.type==='skeleton'&&distance<12&&distance>2){
    const from=pos.clone().add(new THREE.Vector3(0,1.25,0));const to=new THREE.Vector3(target.x,1,target.z);showMobAttackLine(from,to,0xe3dfce);applyMobDamageToPlayer(target,7,mob.type);mob.attackCooldown=2.2;
   }else if(distance<(mob.type==='spider'?1.7:1.65)&&mob.type!=='creeper'){
    applyMobDamageToPlayer(target,mob.def.damage,mob.type);mob.attackCooldown=mob.type==='enderman'?1.35:1.45;
   }
  }
  mob.target.copy(pos);
 }
}
function spawnMob(type){
 const targets=mobTargetList();const origin=targets.length?targets[Math.floor(Math.random()*targets.length)]:{x:player.pos.x,z:player.pos.z};
 const angle=Math.random()*Math.PI*2,radius=9+Math.random()*6;const x=Math.max(-20,Math.min(20,Math.round(origin.x+Math.cos(angle)*radius))),z=Math.max(-20,Math.min(20,Math.round(origin.z+Math.sin(angle)*radius)));
 const id=`mob-${Date.now().toString(36)}-${++mobCounter}`;const y=heightAt(x,z)-.5;createMob(id,type,{x,y,z,health:MOB_DEFS[type].health});
 if(networkRole==='host')networkBroadcast({type:'mobSnapshot',mobs:serializeMobs()});
}
function targetMob(maxDistance=30){
 playerRaycaster.far=maxDistance;playerRaycaster.setFromCamera(new THREE.Vector2(0,0),camera);
 const hit=playerRaycaster.intersectObjects(mobHitMeshes,false)[0];
 return hit&&hit.object.userData.mobId?{id:hit.object.userData.mobId,hit,mob:mobs.get(hit.object.userData.mobId)}:null;
}
function mobDamageForWeapon(index){return [18,25,14,7,45,0][index]||0;}
function handleMobHit(attackerId,mobId,weaponIndex){
 if(networkRole!=='host'&&networkRole!=='solo')return;
 if(networkRole==='host'&&attackerId!==peer?.id&&!connections.has(attackerId))return;
 if(!Number.isInteger(weaponIndex)||weaponIndex<0||weaponIndex>=weapons.length)return;
 const mob=mobs.get(mobId);if(!mob||mob.health<=0)return;
 const now=Date.now(),rateKey=`${attackerId}:${mobId}`,last=lastMobHitAt.get(rateKey)||0;const weapon=weapons[weaponIndex];
 if(now-last<Math.max(80,(weapon.rate||250)*.75))return;lastMobHitAt.set(rateKey,now);
 const attacker=attackerId===peer?.id||networkRole==='solo'?{x:player.pos.x,z:player.pos.z}:remotePlayers.get(attackerId)?.state?.pos;
 if(!attacker||!Number.isFinite(attacker.x)||!Number.isFinite(attacker.z))return;
 const range=[3.8,30,30,30,4.0,0][weaponIndex];if(!range)return;
 const d=Math.hypot(attacker.x-mob.group.position.x,attacker.z-mob.group.position.z);if(d>range+1)return;
 const damage=mobDamageForWeapon(weaponIndex);if(!damage)return;mob.health=Math.max(0,mob.health-damage);updateMobHealthBar(mob);
 if(mob.health<=0){const type=mob.type;disposeMob(mob);if(attackerId===peer?.id||networkRole==='solo')say(`${type.toUpperCase()} defeated!`);}
 if(networkRole==='host')networkBroadcast({type:'mobSnapshot',mobs:serializeMobs()});
}
function requestMobAttack(mobId,weaponIndex){
 if(networkRole==='client'){safePeerSend(hostConnection,{type:'mobHit',mobId,weaponIndex});}
 else handleMobHit(networkRole==='host'?(peer?.id||'host'):'local',mobId,weaponIndex);
}
function targetBlock(){raycaster.setFromCamera(new THREE.Vector2(0,0),camera);return raycaster.intersectObjects(blockMeshes,false)[0]||null;}
function targetRemotePlayer(maxDistance=30){
 playerRaycaster.far=maxDistance;playerRaycaster.setFromCamera(new THREE.Vector2(0,0),camera);
 const hit=playerRaycaster.intersectObjects(remotePlayerHitMeshes,false)[0];
 return hit&&hit.object.userData.remotePeerId?{peerId:hit.object.userData.remotePeerId,hit}:null;
}
function useWeapon(){
 const now=performance.now(),w=weapons[selected];if(now-lastUse<(w.rate||250))return;lastUse=now;
 if(w.kind==='mine'){
   const mob=targetMob(3.5);if(mob){requestMobAttack(mob.id,selected);say(`Hit ${mob.type}`);return;}
   const foe=targetRemotePlayer(3.5);
   if(foe){requestPlayerAttack(foe.peerId,selected);say('Pickaxe swing!');return;}
   const hit=targetBlock();
   if(hit&&hit.object.userData.removable){removeBlock(hit.object);player.blocks++;say('+1 block');updateStats();}
   else say('Aim at a nearby block');
 }else if(w.kind==='build'){
   placeBlock();
 }else if(w.kind==='melee'){
   const mob=targetMob(3.7);if(mob){requestMobAttack(mob.id,selected);say(`Energy saber hit ${mob.type}`);saberFlash();return;}
   const foe=targetRemotePlayer(3.7);
   if(foe){requestPlayerAttack(foe.peerId,selected);say('Energy saber strike!');}else say('Aim at a friend to strike');
   saberFlash();
 }else{
   if(reloading)return;if(mag<=0){say('Press R to reload');return;}
   mag--;drawHotbar();shootEffect(w.color);
   const mob=targetMob(30);
   const foe=mob?null:targetRemotePlayer(30);
   if(mob)requestMobAttack(mob.id,selected);
   else if(foe)requestPlayerAttack(foe.peerId,selected);
   else{
     const hit=targetBlock();
     if(hit){const p=hit.point;const spark=new THREE.Mesh(new THREE.BoxGeometry(.14,.14,.14),new THREE.MeshBasicMaterial({color:w.color}));spark.position.copy(p);scene.add(spark);setTimeout(()=>{scene.remove(spark);spark.geometry.dispose();spark.material.dispose();},180);}
   }
 }
}
function placeBlock(){
 const hit=targetBlock();if(!hit){say('Look at a block to place beside it');return;}if(player.blocks<=0){say('No blocks left');return;}
 const n=hit.face.normal.clone();const p=hit.object.position.clone().add(n);
 if(p.distanceTo(player.pos)<1.25){say('Too close to place');return;}
 const before=blocks.size;addBlock(Math.round(p.x),Math.round(p.y),Math.round(p.z),'dirt',true,true);
 if(blocks.size>before){player.blocks--;updateStats();say('Block placed');}else say('There is already a block there');
}
function shootEffect(color){
 const dir=new THREE.Vector3();camera.getWorldDirection(dir);
 const start=camera.position.clone().add(dir.clone().multiplyScalar(.65)).add(new THREE.Vector3(.18,-.15,0));
 const end=start.clone().add(dir.multiplyScalar(12));const geo=new THREE.BufferGeometry().setFromPoints([start,end]);const line=new THREE.Line(geo,new THREE.LineBasicMaterial({color}));
 scene.add(line);setTimeout(()=>{scene.remove(line);geo.dispose()},70);
}
let saber=null;
function saberFlash(){
 if(saber)scene.remove(saber);
 saber=new THREE.Mesh(new THREE.BoxGeometry(.07,.07,1.2),new THREE.MeshBasicMaterial({color:weapons[selected].color}));
 saber.position.copy(camera.position);saber.position.add(new THREE.Vector3(.48,-.35,-.8).applyEuler(camera.rotation));saber.rotation.copy(camera.rotation);scene.add(saber);
 setTimeout(()=>{if(saber)scene.remove(saber);saber=null},180);
}
function reload(){if(![1,2,3].includes(selected+1)||reloading||mag===30||ammo<=0)return;reloading=true;say('Reloading…');setTimeout(()=>{const n=Math.min(30-mag,ammo);mag+=n;ammo-=n;reloading=false;drawHotbar();},1000);}
function updateStats(){document.querySelector('#health').textContent=player.health;document.querySelector('#hunger').textContent=Math.floor(player.hunger);document.querySelector('#blocks').textContent=player.blocks;}
const clock=new THREE.Clock();
function collidesAt(pos){
 const px=Math.round(pos.x),pz=Math.round(pos.z), feet=Math.floor(pos.y-1.65), head=Math.floor(pos.y-.1);
 for(let x=px-1;x<=px+1;x++)for(let z=pz-1;z<=pz+1;z++)for(let y=feet;y<=head;y++){
   if(blocks.has(key(x,y,z)) && Math.abs(pos.x-x)<.78 && Math.abs(pos.z-z)<.78 && pos.y-1.65<y+.5 && pos.y-.1>y-.5)return true;
 }
 return false;
}
let tick=0,networkTick=0;
function sendPlayerState(){
 const state=localPlayerState();
 if(networkRole==='host')networkBroadcast({type:'state',state});
 else if(networkRole==='client'&&hostConnection?.open)safePeerSend(hostConnection,{type:'state',state});
}
function animate(){
 requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.04);
 if(!paused&&locked){
   const forward=new THREE.Vector3(-Math.sin(player.yaw),0,-Math.cos(player.yaw));const right=new THREE.Vector3(Math.cos(player.yaw),0,-Math.sin(player.yaw));const move=new THREE.Vector3();
   if(keys.KeyW)move.add(forward);if(keys.KeyS)move.sub(forward);if(keys.KeyD)move.add(right);if(keys.KeyA)move.sub(right);
   if(move.lengthSq())move.normalize().multiplyScalar(5.3*dt);
   const nextX=player.pos.clone();nextX.x+=move.x;if(!collidesAt(nextX))player.pos.x=nextX.x;
   const nextZ=player.pos.clone();nextZ.z+=move.z;if(!collidesAt(nextZ))player.pos.z=nextZ.z;
   if(keys.Space&&player.grounded){player.vel.y=7;player.grounded=false;}
   player.vel.y-=18*dt;player.pos.y+=player.vel.y*dt;
   if(collidesAt(player.pos)){player.pos.y-=player.vel.y*dt;player.vel.y=0;player.grounded=true;}else player.grounded=false;
   if(player.pos.y<-5){player.pos.set(0,3,6);player.vel.set(0,0,0);}
   tick+=dt;if(tick>8){tick=0;player.hunger=Math.max(0,player.hunger-.3);updateStats();}
   if(networkRole!=='client')worldTime+=dt;
   if(networkRole!=='client')updateMobs(dt);
   daySyncTick+=dt;
   if(networkRole==='host'&&daySyncTick>=1){daySyncTick=0;networkBroadcast({type:'dayState',elapsed:worldTime});}
   mobSnapshotTimer+=dt;if(networkRole==='host'&&mobSnapshotTimer>=.3){mobSnapshotTimer=0;networkBroadcast({type:'mobSnapshot',mobs:serializeMobs()});}
   camera.position.copy(player.pos);camera.rotation.order='YXZ';camera.rotation.y=player.yaw;camera.rotation.x=player.pitch;
   networkTick+=dt;if(networkTick>.08){networkTick=0;sendPlayerState();}
 }
 updateDayCycle();
 const mobCountLabel=document.querySelector('#mobCount');if(mobCountLabel)mobCountLabel.textContent=mobs.size;
 heldItemRoot.position.y=-.37 + ((!paused&&locked&&(keys.KeyW||keys.KeyA||keys.KeyS||keys.KeyD))?Math.sin(clock.elapsedTime*11)*.018:0);
 for(const remote of remotePlayers.values()){remote.group.position.lerp(remote.target,.3);remote.group.rotation.y=remote.yaw;}
 if(networkRole==='client')for(const mob of mobs.values()){mob.group.position.lerp(mob.target,.25);mob.group.rotation.y=mob.yaw;mob.group.scale.setScalar(mob.type==='creeper'&&mob.fuse>0?1+Math.sin(mob.fuse*18)*.055:1);}
 renderer.render(scene,camera);
}
animate();
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
