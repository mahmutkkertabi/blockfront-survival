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
const NIGHT_START = 65, DAWN_START = 80;
let worldTime = 0, currentDay = 1, isNight = false, daySyncTick = 0;
const mission = { crystals: 0, blocksPlaced: 0, enemiesDefeated: 0, won: false };
const GOAL_DAY = 5, GOAL_CRYSTALS = 5, GOAL_BLOCKS = 10, GOAL_ENEMIES = 8;
const enemies = [], enemyMeshes = [];
const enemyRaycaster = new THREE.Raycaster();
let enemySerial = 0, nightSpawnTimer = 0, enemiesThisNight = 0;

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
 if(networkRole==='host') statusLabel.textContent=`DAY ${currentDay} · ${phase} · ROOM ${roomCode} · ${1+connections.size} PLAYER${connections.size===0?'':'S'}`;
 else if(networkRole==='client') statusLabel.textContent=`DAY ${currentDay} · ${phase} · ROOM ${roomCode} · ${hostConnection?.open?'2 PLAYERS':'CONNECTING'}`;
 else statusLabel.textContent=`DAY ${currentDay} · ${phase} · SOLO`;
}
function updateMissionUI(){
 const dayEl=document.querySelector('#objectiveDay');
 const crystalEl=document.querySelector('#objectiveCrystals');
 const buildEl=document.querySelector('#objectiveBlocks');
 const enemyEl=document.querySelector('#objectiveEnemies');
 if(dayEl)dayEl.textContent=`Reach Day ${GOAL_DAY}: ${Math.min(currentDay,GOAL_DAY)}/${GOAL_DAY}`;
 if(crystalEl)crystalEl.textContent=`Mine crystal ore: ${Math.min(mission.crystals,GOAL_CRYSTALS)}/${GOAL_CRYSTALS}`;
 if(buildEl)buildEl.textContent=`Place blocks: ${Math.min(mission.blocksPlaced,GOAL_BLOCKS)}/${GOAL_BLOCKS}`;
 if(enemyEl)enemyEl.textContent=`Defeat hostiles: ${Math.min(mission.enemiesDefeated,GOAL_ENEMIES)}/${GOAL_ENEMIES}`;
 if(!mission.won && currentDay>=GOAL_DAY && mission.crystals>=GOAL_CRYSTALS && mission.blocksPlaced>=GOAL_BLOCKS && mission.enemiesDefeated>=GOAL_ENEMIES){
   mission.won=true;const banner=document.querySelector('#missionBanner');banner.hidden=false;say('SURVIVAL MISSION COMPLETE!');
 }
}
function addEnemyPart(enemy,geometry,material,position){
 const mesh=new THREE.Mesh(geometry,material);mesh.position.set(...position);mesh.castShadow=true;mesh.userData.enemy=enemy;enemy.group.add(mesh);enemyMeshes.push(mesh);return mesh;
}
function spawnEnemy(){
 if(enemies.length>=5||enemiesThisNight>=3)return;
 let x=0,z=0,tries=0;
 do{
   const angle=Math.random()*Math.PI*2,dist=9+Math.random()*5;
   x=Math.max(-21,Math.min(21,Math.round(player.pos.x+Math.cos(angle)*dist)));
   z=Math.max(-21,Math.min(21,Math.round(player.pos.z+Math.sin(angle)*dist)));
   tries++;
 }while(Math.hypot(x-player.pos.x,z-player.pos.z)<7&&tries<12);
 let h=heightAt(x,z);const group=new THREE.Group();
 if(blocks.has(key(x,h,z))||blocks.has(key(x,h+1,z))){
   x=Math.max(-21,Math.min(21,Math.round(player.pos.x+(Math.random()<.5?-1:1)*(9+Math.random()*5))));
   z=Math.max(-21,Math.min(21,Math.round(player.pos.z+(Math.random()<.5?-1:1)*(9+Math.random()*5))));
   h=heightAt(x,z);
 }
 const bodyMat=new THREE.MeshLambertMaterial({color:0x4b3449}),headMat=new THREE.MeshLambertMaterial({color:0x6d425d}),eyeMat=new THREE.MeshBasicMaterial({color:0xff4c65});
 const enemy={id:++enemySerial,group,health:70,speed:1.35,attackTimer:0,materials:[bodyMat,headMat,eyeMat]};
 addEnemyPart(enemy,new THREE.BoxGeometry(.62,.90,.42),bodyMat,[0,.68,0]);
 addEnemyPart(enemy,new THREE.BoxGeometry(.50,.52,.48),headMat,[0,1.39,-.015]);
 for(const side of [-1,1]){
   addEnemyPart(enemy,new THREE.BoxGeometry(.08,.07,.035),eyeMat,[side*.125,1.42,-.274]);
   addEnemyPart(enemy,new THREE.BoxGeometry(.17,.64,.19),bodyMat,[side*.40,.67,0]);
   addEnemyPart(enemy,new THREE.BoxGeometry(.20,.44,.22),headMat,[side*.17,.23,0]);
 }
 group.position.set(x,h-.5,z);scene.add(group);enemies.push(enemy);enemiesThisNight++;
 say('A hostile cube appeared!');
}
function removeEnemy(enemy,killed=false){
 if(!enemy)return;scene.remove(enemy.group);
 for(let i=enemyMeshes.length-1;i>=0;i--){if(enemyMeshes[i].userData.enemy===enemy)enemyMeshes.splice(i,1);}
 enemy.group.traverse(obj=>{if(obj.geometry)obj.geometry.dispose();});
 for(const material of enemy.materials)material.dispose();
 const idx=enemies.indexOf(enemy);if(idx>=0)enemies.splice(idx,1);
 if(killed){mission.enemiesDefeated++;updateMissionUI();say('Hostile defeated!');}
}
function targetEnemy(maxDistance=30){
 enemyRaycaster.far=maxDistance;enemyRaycaster.setFromCamera(new THREE.Vector2(0,0),camera);
 const hit=enemyRaycaster.intersectObjects(enemyMeshes,false)[0];
 return hit?.object?.userData?.enemy?{enemy:hit.object.userData.enemy,hit}:null;
}
function damageEnemy(enemy,amount){
 if(!enemy||!enemies.includes(enemy))return;
 enemy.health-=amount;
 if(enemy.health<=0)removeEnemy(enemy,true);
}
function updateEnemies(dt){
 if(paused||!locked)return;
 if(isNight){nightSpawnTimer+=dt;if(nightSpawnTimer>=4.5&&enemiesThisNight<3){nightSpawnTimer=0;spawnEnemy();}}
 for(const enemy of [...enemies]){
   const dx=player.pos.x-enemy.group.position.x,dz=player.pos.z-enemy.group.position.z;
   const distance=Math.hypot(dx,dz);
   enemy.group.rotation.y=Math.atan2(-dx,-dz);
   if(distance>1.35){
     const step=enemy.speed*dt;
     const nx=enemy.group.position.x+(dx/distance)*step,nz=enemy.group.position.z+(dz/distance)*step;
     const gx=Math.round(nx),gz=Math.round(nz),gh=heightAt(gx,gz);
     // Avoid walking into a tree or a player-built wall at head height.
     if(!blocks.has(key(gx,gh,gz))&&!blocks.has(key(gx,gh+1,gz))){enemy.group.position.x=nx;enemy.group.position.z=nz;enemy.group.position.y=gh-.5;}
   }else{
     enemy.attackTimer+=dt;
     if(enemy.attackTimer>=1.15){enemy.attackTimer=0;player.health=Math.max(0,player.health-8);updateStats();say('A hostile hit you!');
       if(player.health<=0){player.health=100;player.hunger=Math.max(40,player.hunger);player.blocks=Math.max(5,player.blocks);player.pos.set(0,2.3,6);player.vel.set(0,0,0);updateStats();say('Respawned. Your mission progress remains.');}
     }
   }
 }
}
function updateDayCycle(){
 const wasNight=isNight;
 currentDay=Math.floor(worldTime/DAY_LENGTH)+1;
 const phase=worldTime%DAY_LENGTH;
 isNight=phase>=NIGHT_START&&phase<DAWN_START;
 if(!wasNight&&isNight){nightSpawnTimer=0;enemiesThisNight=0;say('Night falls! Hostile cubes are coming.');}
 if(wasNight&&!isNight){for(const enemy of [...enemies])removeEnemy(enemy,false);say('Dawn has arrived. The hostiles have retreated.');}
 let daylight=1;
 if(phase>=NIGHT_START&&phase<DAWN_START)daylight=.16;
 else if(phase>=NIGHT_START-10&&phase<NIGHT_START)daylight=1-((phase-(NIGHT_START-10))/10)*.84;
 else if(phase>=DAWN_START)daylight=.16+((phase-DAWN_START)/(DAY_LENGTH-DAWN_START))*.84;
 daylight=Math.max(.16,Math.min(1,daylight));
 const darkness=1-daylight;
 scene.background.copy(DAY_SKY).lerp(NIGHT_SKY,darkness);
 scene.fog.color.copy(DAY_FOG).lerp(NIGHT_FOG,darkness);
 hemisphere.intensity=.4+1.7*daylight;
 sun.intensity=.12+2.18*daylight;
 updateRoomStatus();updateMissionUI();
}
function createRoomCode(){
 const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
 // 32 symbols, 10 cryptographically random characters (50 bits of entropy).
 const bytes=crypto.getRandomValues(new Uint8Array(10));
 return Array.from(bytes,b=>chars[b & 31]).join('');
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
 const color=new THREE.Color().setHSL((Math.abs(hashString(peerId))%360)/360,.62,.48);
 const bodyMat=new THREE.MeshLambertMaterial({color});const trimMat=new THREE.MeshLambertMaterial({color:0x243b4f});const headMat=new THREE.MeshLambertMaterial({color:0xe4b990});
 const body=new THREE.Mesh(new THREE.BoxGeometry(.62,.82,.34),bodyMat);body.position.y=.92;body.castShadow=true;group.add(body);
 const head=new THREE.Mesh(new THREE.BoxGeometry(.42,.42,.42),headMat);head.position.y=1.58;head.castShadow=true;group.add(head);
 for(const side of [-1,1]){const arm=new THREE.Mesh(new THREE.BoxGeometry(.2,.68,.22),bodyMat);arm.position.set(side*.42,.94,0);arm.castShadow=true;group.add(arm);const leg=new THREE.Mesh(new THREE.BoxGeometry(.24,.55,.27),trimMat);leg.position.set(side*.17,.27,0);leg.castShadow=true;group.add(leg);}
 const label=createNameSprite(state?.name||'FRIEND');label.position.y=2.25;group.add(label);
 const heldIndex=Number.isInteger(state?.held)&&state.held>=0&&state.held<weapons.length?state.held:0;
 const heldProp=makeRemoteHeldProp(heldIndex);group.add(heldProp);
 scene.add(group);const record={group,target:new THREE.Vector3(),yaw:0,state:state||{},heldIndex,heldProp};remotePlayers.set(peerId,record);return record;
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
function removeRemotePlayer(peerId){const remote=remotePlayers.get(peerId);if(remote){scene.remove(remote.group);remote.group.traverse(obj=>{if(obj.material?.map)obj.material.map.dispose();});remotePlayers.delete(peerId);}}
function refreshNetworkUi(){updateRoomStatus();if(networkRole==='host')setNetworkStatus(`Room is ready. Send code ${roomCode} to your friend. Connected players: ${1+connections.size}.`);else if(networkRole==='client')setNetworkStatus(hostConnection?.open?`Connected to room ${roomCode}. You can enter the world.`:`Connecting to room ${roomCode}…`);}
function registerConnection(conn){
 conn.on('open',()=>{
   connections.set(conn.peer,conn);
   if(networkRole==='host'){
     sendSnapshot(conn);
     safePeerSend(conn,{type:'dayState',elapsed:worldTime});
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
   if(message.type==='room-full'){setNetworkStatus('This room already has a player. Ask the host to create a new room.');startButton.disabled=true;return;}
   if(message.type==='dayState'&&networkRole==='client'&&Number.isFinite(message.elapsed)&&message.elapsed>=0&&message.elapsed<864000){worldTime=message.elapsed;updateDayCycle();}
   else if(message.type==='snapshot'&&Array.isArray(message.changes)&&message.changes.length<=MAX_SNAPSHOT_CHANGES){
     for(const entry of message.changes){if(Array.isArray(entry)&&entry.length===2)applyRemoteBlockChange(entry[0],entry[1]);}
     say('World changes synchronized');
   }else if(message.type==='block'&&isValidBlockKey(message.key)&&isValidBlockValue(message.value)){
     applyRemoteBlockChange(message.key,message.value);
     if(networkRole==='host')networkBroadcast(message,conn.peer);
   }else if(message.type==='state'&&message.state){
     updateRemotePlayer(conn.peer,message.state);
     if(networkRole==='host')networkBroadcast(message,conn.peer);
   }else if(message.type==='goodbye'){
     removeRemotePlayer(conn.peer);
   }
 });
 conn.on('close',()=>{
   connections.delete(conn.peer);removeRemotePlayer(conn.peer);
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
   // This prototype is designed for the host and one friend only.
   if(networkRole!=='host' || connections.size + pendingHostConnections >= 1){
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
function targetBlock(){raycaster.setFromCamera(new THREE.Vector2(0,0),camera);return raycaster.intersectObjects(blockMeshes,false)[0]||null;}
function useWeapon(){
 const now=performance.now(),w=weapons[selected];if(now-lastUse<(w.rate||250))return;lastUse=now;
 if(w.kind==='mine'){
   const enemyHit=targetEnemy(3.5);
   if(enemyHit){damageEnemy(enemyHit.enemy,24);say('Pickaxe strike!');return;}
   const hit=targetBlock();
   if(hit&&hit.object.userData.removable){
     const minedType=hit.object.userData.type;removeBlock(hit.object);player.blocks++;
     if(minedType==='ore'){mission.crystals++;say('Crystal ore collected!');}else say('+1 block');
     updateStats();updateMissionUI();
   }else say('Aim at a nearby block');
 }else if(w.kind==='build'){
   placeBlock();
 }else if(w.kind==='melee'){
   const foe=targetEnemy(3.7);
   if(foe){damageEnemy(foe.enemy,45);say('Energy saber strike!');}else say('Energy saber activated');
   saberFlash();
 }else{
   if(reloading)return;
   if(mag<=0){say('Press R to reload');return;}
   mag--;drawHotbar();shootEffect(w.color);
   const foe=targetEnemy(30);
   if(foe){damageEnemy(foe.enemy,w.damage);}
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
 if(blocks.size>before){player.blocks--;mission.blocksPlaced++;updateStats();updateMissionUI();say('Block placed');}else say('There is already a block there');
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
 const state={name:networkRole==='host'?'HOST':'PLAYER',pos:{x:player.pos.x,y:player.pos.y-1.6,z:player.pos.z},yaw:player.yaw,health:player.health,held:selected};
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
   daySyncTick+=dt;
   if(networkRole==='host'&&daySyncTick>=1){daySyncTick=0;networkBroadcast({type:'dayState',elapsed:worldTime});}
   camera.position.copy(player.pos);camera.rotation.order='YXZ';camera.rotation.y=player.yaw;camera.rotation.x=player.pitch;
   networkTick+=dt;if(networkTick>.08){networkTick=0;sendPlayerState();}
 }
 updateDayCycle();
 updateEnemies(dt);
 heldItemRoot.position.y=-.37 + ((!paused&&locked&&(keys.KeyW||keys.KeyA||keys.KeyS||keys.KeyD))?Math.sin(clock.elapsedTime*11)*.018:0);
 for(const remote of remotePlayers.values()){remote.group.position.lerp(remote.target,.3);remote.group.rotation.y=remote.yaw;}
 renderer.render(scene,camera);
}
animate();
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
