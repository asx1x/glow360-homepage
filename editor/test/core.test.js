global.window = global; global.document={createElement:()=>({getContext:()=>null,style:{}}),documentElement:{style:{}}};
global.navigator={userAgent:'node'};
const M = require('marzipano/dist/marzipano.js');
const G = require('../src/core.js');
let fail = 0; const ok=(c,m)=>{ if(!c){fail++;console.log('FAIL',m);} };

// 1. Oracle: face corner directions vs Marzipano's own CubeTile.vertices()
for (const levelSize of [512, 1024]) {
  const levels=[{tileSize:512,size:levelSize}];
  const g = new M.CubeGeometry(levels); const n = levelSize/512;
  for (const f of G.FACES) for (let ty=0;ty<n;ty++) for (let tx=0;tx<n;tx++) {
    const t = new g.Tile(f,tx,ty,0,g); const v = t.vertices();
    // corners TL,TR,BR,BL in tile-local pixel space of the whole face
    const F = levelSize, corners=[[tx*512,ty*512],[(tx+1)*512,ty*512],[(tx+1)*512,(ty+1)*512],[tx*512,(ty+1)*512]];
    corners.forEach((c,i)=>{
      const out=[0,0,0]; G.faceDir(f, c[0]/F-0.5, 0.5-c[1]/F, out);
      for(let k=0;k<3;k++) ok(Math.abs(out[k]-v[i][k])<1e-6, `vertex ${f} ${tx},${ty} c${i} axis${k}: ${out[k]} vs ${v[i][k]}`);
    });
  }
}
console.log('oracle vs Marzipano CubeTile.vertices: done');

// 2. Yaw/pitch convention vs Marzipano view (right = +yaw, up = negative pitch)
const view = new M.RectilinearView({yaw:0,pitch:0,fov:Math.PI/2}); view.setSize({width:800,height:800});
for (const [sx,sy] of [[600,400],[200,400],[400,200],[400,600],[650,250]]) {
  const c = view.screenToCoordinates({x:sx,y:sy});
  // direction of that pixel in world: view looks down -z, camera space -> world with yaw=pitch=0 is identity
  const nx=(sx/800-0.5)*2*Math.tan(Math.PI/4), ny=(0.5-sy/800)*2*Math.tan(Math.PI/4);
  const yp = G.dirToYawPitch(nx,ny,-1);
  ok(Math.abs(yp.yaw-c.yaw)<1e-6 && Math.abs(yp.pitch-c.pitch)<1e-6, `yaw/pitch mismatch at ${sx},${sy}: ${JSON.stringify(yp)} vs ${JSON.stringify(c)}`);
}
console.log('yaw/pitch convention vs Marzipano view: done');

// 3. End-to-end: synthetic equirect encoding yaw/pitch; tile front/right/up faces and read back centre
const W=1024,H=512, src=new Uint8ClampedArray(W*H*4);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const o=(y*W+x)*4;src[o]=Math.round(x/W*255);src[o+1]=Math.round(y/H*255);src[o+2]=0;src[o+3]=255;}
const F=256, dst=new Uint8ClampedArray(F*F*4);
const centre=(face)=>{G.renderFaceRows(src,W,H,face,F,0,F,dst);const o=((F/2)*F+F/2)*4;return [dst[o],dst[o+1]];};
const exp={f:[128,128],r:[192,128],b:[0,128],l:[64,128],u:[128,0],d:[128,255]};
for(const f of G.FACES){const c=centre(f);const e=exp[f];const dx=Math.min(Math.abs(c[0]-e[0]),255-Math.abs(c[0]-e[0])); const pole=(f==='u'||f==='d'); ok((pole||dx<=3)&&Math.abs(c[1]-e[1])<=3,`face ${f} centre ${c} expected ${e}`);}
console.log('synthetic equirect centres: done');

// 4. Utilities
ok(G.pickFaceSize(8192,2048)===2048 && G.pickFaceSize(5760,2048)===1024 && G.pickFaceSize(3000,2048)===512,'pickFaceSize');
ok(JSON.stringify(G.buildLevels(2048).map(l=>l.size))==='[256,512,1024,2048]','levels');
const vp = G.aspectFov(390,844,Math.PI/2.4,Math.PI/2,Math.PI*100/180);
ok(vp>Math.PI/2.4,'portrait widens vfov'); ok(G.aspectFov(1200,700,Math.PI/2.4,Math.PI/2,2)===Math.PI/2.4,'landscape unchanged');
const evil = G.serializeData({t:'</script><img src=x onerror=alert(1)>'});
ok(!/<\/script/i.test(evil) && !evil.includes('<'), 'data.js safe'); ok(G.esc('<b>"\'&')==='&lt;b&gt;&quot;&#39;&amp;','esc');
const U=G.normalizeListingUrl;
ok(U('').ok&&U('').value==='','empty url ok');
ok(U('trademe.co.nz/a/residential/sale/listing/123').value==='https://trademe.co.nz/a/residential/sale/listing/123','adds https');
ok(U('https://www.zillow.com/homedetails/1-Main-St/123_zpid/').ok,'zillow');
ok(U('  https://example.com/x?y=1  ').value==='https://example.com/x?y=1','trims');
for(const bad of ['javascript:alert(1)','JaVaScRiPt:alert(1)','data:text/html,<b>','ftp://x.com/a','https://user:pw@example.com/','https://exa mple.com','https://localhost/a','vbscript:x','https://'+'a'.repeat(600)+'.com']) ok(!U(bad).ok,'should reject '+bad.slice(0,30));
const A=G.validateAddress;
ok(A('12 Example Street, Remuera').ok && A('12 Example Street, Remuera').warn==='','address ok');
ok(A('Example Street').ok && A('Example Street').warn!=='','warn no number');
ok(!A('').ok&&!A('abc').ok&&!A('12345').ok&&!A('x'.repeat(121)).ok,'address rejects');
ok(A('  12   Example\u0000 St ').value==='12 Example St','address cleaned');
ok(G.defaultSceneName('IMG_20260915_165304_00_merged.jpg',3)==='Scene 3'&&G.defaultSceneName('Living_room.jpg',1)==='Living room','scene names');
const P1=G.priceFor(1),P10=G.priceFor(10),P15=G.priceFor(15);
ok(P1.subtotal===1000&&P1.gst===150&&P1.total===1150,'price 1');
ok(P10.subtotal===10000&&P10.gst===1500&&P10.total===11500,'price 10');
ok(P15.subtotal===15000&&P15.gst===2250&&P15.total===17250,'price 15');
for(let n=1;n<=15;n++){const p=G.priceFor(n); ok(Number.isInteger(p.gst)&&p.total===p.subtotal+p.gst,'integer cents '+n);}
ok(!G.validateSceneCount(0).ok&&G.validateSceneCount(1).ok&&G.validateSceneCount(15).ok&&!G.validateSceneCount(16).ok&&!G.validateSceneCount(NaN).ok,'scene count limits');
ok(G.fmtMoney(1000)==='$10'&&G.fmtMoney(1150)==='$11.50'&&G.fmtMoney(17250)==='$172.50','money format');
console.log(fail? fail+' FAILURES':'ALL TESTS PASSED');
process.exit(fail?1:0);
