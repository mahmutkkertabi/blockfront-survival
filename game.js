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
const renderer = new THREE.WebGLRenderer({antialias:false});
renderer.setSize(innerWidth,innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xd8f2ff,0x5c6446,2.1));
const sun = new THREE.DirectionalLight(0xfff2cf,2.3); sun.position.set(-12,22,9); sun.castShadow=true; scene.add(sun);

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
function drawHotbar(){hotbar.innerHTML='';weapons.forEach((w,i)=>{const d=document.createElement('div');d.className='slot'+(i===selected?' active':'');d.innerHTML=`<span class="num">${i+1}</span><span class="emoji">${w.icon}</span><span>${w.name}</span>`;hotbar.appendChild(d)});document.querySelector('#weaponLabel').textContent=`${selected+1} · ${weapons[selected].name} ${[1,2,3].includes(selected+1)?`· ${mag}/${ammo}`:''}`;}
drawHotbar();
const overlay=document.querySelector('#overlay');
const startButton=document.querySelector('#start');
const netStatus=document.querySelector('#netStatus');
const roomInfo=document.querySelector('#roomInfo');
const roomCodeLabel=document.querySelector('#roomCode');
const statusLabel=document.querySelector('#status');
function setNetworkStatus(text){netStatus.textContent=text;}
function updateRoomStatus(){
 if(networkRole==='host') statusLabel.textContent=`DAY 1 · ROOM ${roomCode} · ${1+connections.size} PLAYER${connections.size===0?'':'S'}`;
 else if(networkRole==='client') statusLabel.textContent=`DAY 1 · ROOM ${roomCode} · ${hostConnection?.open?'2 PLAYERS':'CONNECTING'}`;
 else statusLabel.textContent='DAY 1 · SOLO';
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
function createRemotePlayer(peerId,state){
 const group=new THREE.Group();
 const color=new THREE.Color().setHSL((Math.abs(hashString(peerId))%360)/360,.62,.48);
 const bodyMat=new THREE.MeshLambertMaterial({color});const trimMat=new THREE.MeshLambertMaterial({color:0x243b4f});const headMat=new THREE.MeshLambertMaterial({color:0xe4b990});
 const body=new THREE.Mesh(new THREE.BoxGeometry(.62,.82,.34),bodyMat);body.position.y=.92;body.castShadow=true;group.add(body);
 const head=new THREE.Mesh(new THREE.BoxGeometry(.42,.42,.42),headMat);head.position.y=1.58;head.castShadow=true;group.add(head);
 for(const side of [-1,1]){const arm=new THREE.Mesh(new THREE.BoxGeometry(.2,.68,.22),bodyMat);arm.position.set(side*.42,.94,0);arm.castShadow=true;group.add(arm);const leg=new THREE.Mesh(new THREE.BoxGeometry(.24,.55,.27),trimMat);leg.position.set(side*.17,.27,0);leg.castShadow=true;group.add(leg);}
 const label=createNameSprite(state?.name||'FRIEND');label.position.y=2.25;group.add(label);
 scene.add(group);const record={group,target:new THREE.Vector3(),yaw:0,state:state||{}};remotePlayers.set(peerId,record);return record;
}
function hashString(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return h;}
function updateRemotePlayer(peerId,state){
 if(!state||typeof state!=='object'||!state.pos||typeof state.pos!=='object' ||
   ![state.pos.x,state.pos.y,state.pos.z,state.yaw].every(Number.isFinite) ||
   Math.abs(state.pos.x)>128 || Math.abs(state.pos.z)>128 || state.pos.y < -10 || state.pos.y > 50) return;
 if (typeof state.name !== 'string') state = {...state,name:'FRIEND'};
 let remote=remotePlayers.get(peerId);if(!remote)remote=createRemotePlayer(peerId,state);
 remote.target.set(state.pos.x,state.pos.y,state.pos.z);remote.yaw=Number(state.yaw)||0;remote.state=state;
}
function removeRemotePlayer(peerId){const remote=remotePlayers.get(peerId);if(remote){scene.remove(remote.group);remote.group.traverse(obj=>{if(obj.material?.map)obj.material.map.dispose();});remotePlayers.delete(peerId);}}
function refreshNetworkUi(){updateRoomStatus();if(networkRole==='host')setNetworkStatus(`Room is ready. Send code ${roomCode} to your friend. Connected players: ${1+connections.size}.`);else if(networkRole==='client')setNetworkStatus(hostConnection?.open?`Connected to room ${roomCode}. You can enter the world.`:`Connecting to room ${roomCode}…`);}
function registerConnection(conn){
 conn.on('open',()=>{
   connections.set(conn.peer,conn);
   if(networkRole==='host'){
     sendSnapshot(conn);
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
   if(message.type==='snapshot'&&Array.isArray(message.changes)&&message.changes.length<=MAX_SNAPSHOT_CHANGES){
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
   const hit=targetBlock();if(hit&&hit.object.userData.removable){removeBlock(hit.object);player.blocks+=1;updateStats();say('+1 block');}else say('Aim at a nearby block');
 }else if(w.kind==='build'){placeBlock();}
 else if(w.kind==='melee'){
   const hit=targetBlock();if(hit)say('Energy saber hums — no enemies nearby yet');else say('Energy saber activated');saberFlash();
 }else{
   if(reloading)return;if(mag<=0){say('Press R to reload');return;}mag--;drawHotbar();shootEffect(w.color);const hit=targetBlock();
   if(hit){const p=hit.point;const spark=new THREE.Mesh(new THREE.BoxGeometry(.14,.14,.14),new THREE.MeshBasicMaterial({color:w.color}));spark.position.copy(p);scene.add(spark);setTimeout(()=>scene.remove(spark),180);}
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
   camera.position.copy(player.pos);camera.rotation.order='YXZ';camera.rotation.y=player.yaw;camera.rotation.x=player.pitch;
   networkTick+=dt;if(networkTick>.08){networkTick=0;sendPlayerState();}
 }
 for(const remote of remotePlayers.values()){remote.group.position.lerp(remote.target,.3);remote.group.rotation.y=remote.yaw;}
 renderer.render(scene,camera);
}
animate();
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
