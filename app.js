const $ = id => document.getElementById(id);
const video=$('camera'), canvas=$('effects'),ctx=canvas.getContext('2d'),stage=$('stage');
const state={mode:'idle',hand:null,face:null,open:.35,smile:0,jaw:0,particles:[],lastBurst:0};
let handModel,faceModel,stream,raf=0,runId=0,lastHand=0,lastFace=0,lastVideo=-1,frames=0,frameStart=0,lastPaint=0,modelPromise;
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const mix=(a,b,t)=>a+(b-a)*t;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const edges=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
function resize(){const d=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.round(stage.clientWidth*d);canvas.height=Math.round(stage.clientHeight*d);ctx.setTransform(d,0,0,d,0,0)}
new ResizeObserver(resize).observe(stage);
function project(p){const w=stage.clientWidth,h=stage.clientHeight,vw=video.videoWidth||640,vh=video.videoHeight||480,s=Math.max(w/vw,h/vh);return {x:w-(p.x*vw*s+(w-vw*s)/2),y:p.y*vh*s+(h-vh*s)/2}}
function setCaption(text){if($('caption').textContent!==text)$('caption').textContent=text}
async function loadModels(){
 if(!modelPromise) modelPromise=(async()=>{
  const {FilesetResolver,HandLandmarker,FaceLandmarker}=await import('./assets/vision_bundle.mjs');
  const files=await FilesetResolver.forVisionTasks('./assets/wasm');
  const create=async delegate=>{
   let hand;
   try{
    hand=await HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'./assets/hand_landmarker.task',delegate},runningMode:'VIDEO',numHands:1,minHandDetectionConfidence:.5,minTrackingConfidence:.5});
    const face=await FaceLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'./assets/face_landmarker.task',delegate},runningMode:'VIDEO',numFaces:1,outputFaceBlendshapes:true,minFaceDetectionConfidence:.5,minTrackingConfidence:.5});
    return [hand,face];
   }catch(e){hand?.close();throw e}
  };
  try{return await create('GPU')}catch(e){console.warn('GPU unavailable; trying CPU',e);return await create('CPU')}
 })().catch(e=>{modelPromise=null;throw e});
 [handModel,faceModel]=await modelPromise;
}
function reset(){state.hand=null;state.face=null;state.open=.35;state.smile=0;state.jaw=0;state.particles=[];lastHand=lastFace=0;lastVideo=-1;lastPaint=0;frames=0;frameStart=performance.now()}
function stop(){runId++;cancelAnimationFrame(raf);if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;state.mode='idle';reset();ctx.clearRect(0,0,stage.clientWidth,stage.clientHeight);$('welcome').hidden=false;$('start').disabled=false;$('demo').disabled=false;$('stop').disabled=true;$('modeTag').textContent='已关闭';$('liveText').textContent='CAMERA OFF';$('fps').textContent='手势 × 表情';updateMeters(false,false);setCaption('摄像头已关闭，可以重新开启')}
async function start(){
 stop();const id=runId;state.mode='loading';$('start').disabled=true;$('modeTag').textContent='加载中';setCaption('正在准备摄像头和识别模型，请稍候…');$('stop').disabled=false;
 try{
  if(!isSecureContext)throw new Error('请通过 HTTPS 打开网页；手机不能使用电脑的普通 HTTP 地址。');
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器无法调用摄像头，请换用支持摄像头的浏览器。');
  const newStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:24,max:30}},audio:false});
  if(id!==runId){newStream.getTracks().forEach(t=>t.stop());return}
  stream=newStream;video.srcObject=stream;await video.play();
  await loadModels();if(id!==runId)return;
  reset();state.mode='camera';$('welcome').hidden=true;$('modeTag').textContent='真实识别';$('liveText').textContent='LIVE CAMERA';$('demo').disabled=false;setCaption('把脸和一只手放进画面，试着张开手掌');raf=requestAnimationFrame(loop);
 }catch(e){if(id!==runId)return;stop();$('modeTag').textContent='开启失败';const errors={NotAllowedError:'摄像头权限未允许，请在浏览器的网站权限中开启摄像头后重试。',NotFoundError:'没有找到摄像头，请检查设备。',NotReadableError:'摄像头被占用，请关闭其它相机或视频应用后重试。'};setCaption(errors[e.name]||'启动失败：'+e.message);console.error(e)}
}
function demo(){stop();reset();state.mode='demo';$('welcome').hidden=true;$('modeTag').textContent='模拟演示';$('liveText').textContent='DEMO · 模拟数据';$('stop').disabled=false;$('demo').disabled=true;setCaption('模拟演示：自动展示手势缩放、微笑换色和张嘴星光');raf=requestAnimationFrame(loop)}
function handOpenness(points){
 const scale=Math.max(distance(points[0],points[9]),.001);
 const ratios=[8,12,16,20].map((tip,i)=>distance(points[tip],points[[5,9,13,17][i]])/scale);
 return clamp((ratios.reduce((a,b)=>a+b,0)/4-.22)/.85);
}
function updateMeters(hasHand,hasFace){$('handLabel').textContent=hasHand?'手掌开放 '+Math.round(state.open*100)+'%':'未检测到手';$('handMeter').style.width=hasHand?state.open*100+'%':'0%';$('faceLabel').textContent=hasFace?(state.jaw>.22?'张嘴 · 星光释放':'微笑强度 '+Math.round(state.smile*100)+'%'):'未检测到脸';$('faceMeter').style.width=hasFace?Math.max(state.smile,state.jaw)*100+'%':'0%'}
function detect(now){
 if(video.readyState<2||lastVideo===video.currentTime)return;lastVideo=video.currentTime;
 const interval=$('lowPower').checked?100:65;
 // Alternate the two synchronous tasks, keeping drawing between inference frames.
 if(now-lastHand>=interval && lastHand<=lastFace){
  const result=handModel.detectForVideo(video,now);lastHand=now;
  state.hand=result.landmarks[0]||null;
  if(state.hand)state.open=mix(state.open,handOpenness(state.hand),.32);
 }else if(now-lastFace>=interval){
  const result=faceModel.detectForVideo(video,now);lastFace=now;
  state.face=result.faceLandmarks[0]||null;
  const scores=Object.fromEntries((result.faceBlendshapes[0]?.categories||[]).map(c=>[c.categoryName,c.score]));
  state.smile=mix(state.smile,state.face?((scores.mouthSmileLeft||0)+(scores.mouthSmileRight||0))/2:0,.35);
  state.jaw=mix(state.jaw,state.face?(scores.jawOpen||0):0,.4);
 }
}
function star(x,y,r,color,alpha=1){ctx.globalAlpha=alpha;ctx.fillStyle=color;ctx.beginPath();for(let i=0;i<8;i++){let a=i*Math.PI/4-Math.PI/2,rr=i%2?r*.28:r;const px=x+Math.cos(a)*rr,py=y+Math.sin(a)*rr;i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.closePath();ctx.fill();ctx.globalAlpha=1}
function draw(now,dt){
 const w=stage.clientWidth,h=stage.clientHeight,t=now/1000;ctx.clearRect(0,0,w,h);
 const demo=state.mode==='demo';let palm,face;
 if(demo){state.open=(Math.sin(t*1.3)+1)/2;state.smile=(Math.sin(t*.8)+1)/2;state.jaw=Math.sin(t*2)>.7?.7:0;palm={x:w*.68+Math.sin(t)*w*.08,y:h*.64};face={x:w*.38,y:h*.32,width:w*.28,mouth:{x:w*.38,y:h*.47}};
  ctx.fillStyle='#ffffff07';ctx.beginPath();ctx.ellipse(face.x,h*.4,w*.14,h*.2,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#ffffff18';ctx.stroke();star(face.x-w*.045,h*.38,5,'#aeced4');star(face.x+w*.045,h*.38,5,'#aeced4');
 }else{
  if(state.hand){const points=state.hand;const p={x:0,y:0};[0,5,9,13,17].forEach(i=>{p.x+=points[i].x/5;p.y+=points[i].y/5});palm=project(p);
   if($('skeleton').checked){ctx.strokeStyle='#a4f4e8aa';ctx.lineWidth=1.4;for(const [a,b]of edges){const pa=project(points[a]),pb=project(points[b]);ctx.beginPath();ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);ctx.stroke()}for(const point of points){const p=project(point);ctx.fillStyle='#e2fff6';ctx.beginPath();ctx.arc(p.x,p.y,2,0,7);ctx.fill()}}
  }
  if(state.face){const p=state.face,left=project(p[234]),right=project(p[454]),brow=project(p[10]),mouth=project(p[13]);face={x:brow.x,y:brow.y,width:Math.hypot(left.x-right.x,left.y-right.y),mouth}}
 }
 const hue=mix(174,330,clamp(state.smile*1.8));const color=`hsl(${hue},90%,78%)`;
 if(palm){const radius=24+state.open*Math.min(w*.22,95);const glow=ctx.createRadialGradient(palm.x,palm.y,0,palm.x,palm.y,radius*1.8);glow.addColorStop(0,`hsla(${hue},90%,70%,.22)`);glow.addColorStop(1,`hsla(${hue},90%,70%,0)`);ctx.fillStyle=glow;ctx.fillRect(palm.x-radius*1.8,palm.y-radius*1.8,radius*3.6,radius*3.6);
  ctx.save();ctx.translate(palm.x,palm.y);ctx.rotate(t*.5);ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.shadowColor=color;ctx.shadowBlur=14;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,radius,radius*(.38+i*.18),i*Math.PI/3,0,Math.PI*2);ctx.stroke()}ctx.shadowBlur=0;for(let i=0;i<10;i++){const a=i/10*Math.PI*2;star(Math.cos(a)*radius,Math.sin(a)*radius,3+(i%3),color)}star(0,0,9+state.open*8,'#fff7dd');ctx.restore();
 }
 if(face){const r=clamp(face.width*.68,35,w*.45),y=face.y-15;ctx.save();ctx.translate(face.x,y);ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.shadowColor=color;ctx.shadowBlur=10;ctx.beginPath();ctx.ellipse(0,0,r,r*.25,0,0,Math.PI*2);ctx.stroke();ctx.shadowBlur=0;for(let i=0;i<7;i++){let a=i/7*Math.PI*2+t*.5;star(Math.cos(a)*r,Math.sin(a)*r*.25,4+(i%2)*3,color)}ctx.restore();
  if(state.jaw>.22 && now-state.lastBurst>90){state.lastBurst=now;for(let i=0;i<5;i++){if(state.particles.length>=100)break;state.particles.push({x:face.mouth.x,y:face.mouth.y,vx:(Math.random()-.5)*140,vy:-40-Math.random()*130,life:1,size:3+Math.random()*5,hue})}}
 }
 for(let i=state.particles.length-1;i>=0;i--){const p=state.particles[i];p.life-=dt*.8;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=30*dt;if(p.life<=0){state.particles.splice(i,1);continue}star(p.x,p.y,p.size,`hsl(${p.hue},90%,80%)`,p.life)}
 updateMeters(!!palm,!!face);
 if(!demo){setCaption(!palm&&!face?'请让脸和一只手进入画面':!face?'手势已识别 · 请让脸进入画面':!palm?'表情已识别 · 请在脸侧伸出一只手':state.jaw>.22?'星光释放！保持张嘴，试着移动手掌':state.smile>.3?'微笑已点亮粉金星环':'张开手掌放大星环，微笑换色，张嘴释放星光')}
}
function loop(now){if(!['camera','demo'].includes(state.mode))return;try{if(state.mode==='camera')detect(now);const dt=Math.min((now-(lastPaint||now))/1000,.05);lastPaint=now;draw(now,dt);frames++;if(now-frameStart>1000){$('fps').textContent=Math.round(frames*1000/(now-frameStart))+' FPS';frames=0;frameStart=now}raf=requestAnimationFrame(loop)}catch(e){console.error(e);stop();setCaption('识别中断：'+e.message+'。可开启省电模式后重试。')}}
$('start').addEventListener('click',start);$('stop').addEventListener('click',stop);$('demo').addEventListener('click',demo);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.mode!=='idle')stop()});
window.addEventListener('pagehide',stop);
