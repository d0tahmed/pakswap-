// User-supplied 3D car models: GLB, glTF (+ .bin and textures), ZIP, FBX and OBJ (+ MTL).
// The model is oriented, scaled to the car's real length, grounded and centred, its body paint
// is found so the paint tab can recolour it, and its wheels are found so they can spin.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import dracoWrapper from '../vendor/draco/draco_wasm_wrapper.txt';
import dracoWasm from '../vendor/draco/draco_decoder.wasm';

class InlineDRACOLoader extends DRACOLoader {
  _loadLibrary(url, responseType) {
    if (url.endsWith('draco_wasm_wrapper.js')) return Promise.resolve(dracoWrapper);
    if (url.endsWith('draco_decoder.wasm')) return Promise.resolve(dracoWasm.slice().buffer);
    return super._loadLibrary(url, responseType);
  }
}
let draco = null;

export const MODEL_ACCEPT = '.glb,.gltf,.zip,.fbx,.obj,.mtl,.bin,.png,.jpg,.jpeg,.webp,.tga,.bmp,.ktx2';
const MAIN_ORDER = ['glb', 'gltf', 'fbx', 'obj'];
const ext = (n) => (n.split('.').pop() || '').toLowerCase();
const base = (n) => n.replace(/\\/g, '/').split('/').pop();
const norm = (n) => decodeURIComponent(n).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').toLowerCase();

// Read File objects (and ZIP archives inside them) into plain entries we can also store.
export async function readModelFiles(fileList) {
  const entries = [];
  for (const f of fileList) {
    const data = await f.arrayBuffer();
    if (ext(f.name) === 'zip') {
      const files = unzipSync(new Uint8Array(data));
      for (const [path, bytes] of Object.entries(files)) {
        if (path.endsWith('/') || /__MACOSX\//.test(path) || base(path).startsWith('._')) continue;
        entries.push({ path, data: bytes.slice().buffer });
      }
    } else entries.push({ path: f.name, data });
  }
  return entries;
}

export function mainEntry(entries) {
  for (const e of MAIN_ORDER) {
    const list = entries.filter((x) => ext(x.path) === e);
    if (list.length) return list.sort((a, b) => b.data.byteLength - a.data.byteLength)[0];
  }
  return null;
}

// Parse entries into a three.js object.
export async function parseModel(entries) {
  const main = mainEntry(entries);
  if (!main) throw new Error('No GLB, glTF, FBX or OBJ file found');
  const urls = new Map();
  const blobs = [];
  for (const e of entries) {
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' }[ext(e.path)] || 'application/octet-stream';
    const u = URL.createObjectURL(new Blob([e.data], { type: mime }));
    blobs.push(u);
    urls.set(norm(e.path), u);
    if (!urls.has(norm(base(e.path)))) urls.set(norm(base(e.path)), u);
  }
  const resolve = (url) => {
    if (/^(data|blob):/i.test(url) && !/^blob:.*\/[^/]*\.[a-z0-9]+$/i.test(url)) return url;
    let p = url.replace(/^blob:[^/]*\/\/[^/]*\//i, '').replace(/^[a-z]+:\/\/[^/]*\//i, '').split('?')[0];
    p = norm(p);
    if (urls.has(p)) return urls.get(p);
    // try progressively shorter path tails, then the bare file name
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) { const t = parts.slice(i).join('/'); if (urls.has(t)) return urls.get(t); }
    return urls.get(norm(base(p))) || url;
  };
  const manager = new THREE.LoadingManager();
  const started = { v: false };
  manager.onStart = () => { started.v = true; };
  manager.setURLModifier(resolve);
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  const kind = ext(main.path);
  let object;
  try {
    if (kind === 'glb' || kind === 'gltf') {
      if (!draco) draco = new InlineDRACOLoader().setDecoderPath('inline/');
      const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
      const data = kind === 'glb' ? main.data : new TextDecoder().decode(main.data);
      const gltf = await loader.parseAsync(data, '');
      object = gltf.scene || gltf.scenes[0];
    } else if (kind === 'fbx') {
      object = new FBXLoader(manager).parse(main.data, '');
      await waitForManager(manager, started);
    } else {
      const text = new TextDecoder().decode(main.data);
      const loader = new OBJLoader(manager);
      const lib = (text.match(/^mtllib\s+(.+)$/m) || [])[1];
      const mtl = entries.find((e) => ext(e.path) === 'mtl' && (!lib || norm(base(e.path)) === norm(base(lib.trim()))) ) || entries.find((e) => ext(e.path) === 'mtl');
      if (mtl) {
        const materials = new MTLLoader(manager).parse(new TextDecoder().decode(mtl.data), '');
        materials.preload();
        loader.setMaterials(materials);
      }
      object = loader.parse(text);
      await waitForManager(manager, started);
    }
  } finally {
    // textures are uploaded once decoded; keep blob URLs alive a little for late loads
    setTimeout(() => blobs.forEach((u) => URL.revokeObjectURL(u)), 30000);
  }
  if (!object) throw new Error('The file did not contain a scene');
  return { object, kind, name: base(main.path) };
}

function waitForManager(manager, started) {
  // resolves when queued textures finish, straight away when nothing was queued
  return new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    manager.onLoad = finish;
    manager.onError = () => {};
    setTimeout(() => { if (!started.v) finish(); }, 80);
    setTimeout(finish, 8000);
  });
}

const NOT_PAINT = /glass|window|windscreen|windshield|light|lamp|led|tire|tyre|rubber|wheel|rim|brake|disc|caliper|chrome|interior|seat|dash|plastic|grill|grille|trim|mirror|plate|licen|logo|badge|emblem|black|matte|carbon|engine|under|exhaust|wiper|tread|shadow|floor|ground|leather|fabric|cloth|steer|gauge|screen|reflector|metal_?dark|bolt|nut|chassis/i;
const IS_PAINT = /paint|body|carpaint|car_paint|exterior|shell|coat|lack|karosserie|bodywork|base_?colou?r|primary|color_?1|colour_?1/i;
const IS_GLASS = /glass|window|windscreen|windshield|lens/i;
const IGNORE_MESH = /floor|ground|backdrop|studio|environment|shadow_?plane|shadowplane|^plane$|^plane\.\d+$/i;
const IS_WHEEL = /wheel|tire|tyre|(^|[^a-z])rim([^a-z]|$)|felge|rad_/i;
const NOT_WHEEL = /steer|spare|arch|well|cover|guard|nut|bolt|logo|cap/i;

function triArea(g) {
  const p = g.getAttribute('position');
  if (!p) return 0;
  const idx = g.getIndex();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let s = 0;
  const n = idx ? idx.count : p.count;
  const step = Math.max(3, Math.floor(n / 60000) * 3); // sample big meshes
  for (let i = 0; i + 2 < n; i += step) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2);
    s += b.sub(a).cross(c.sub(a)).length() * 0.5;
  }
  return s * (step / 3);
}

function toStandard(m) {
  if (m.isMeshStandardMaterial) return m;
  const shin = m.shininess != null ? m.shininess : 30;
  const s = new THREE.MeshStandardMaterial({
    name: m.name, color: m.color ? m.color.clone() : new THREE.Color('#ffffff'), map: m.map || null, normalMap: m.normalMap || null,
    emissive: m.emissive ? m.emissive.clone() : new THREE.Color('#000000'), emissiveMap: m.emissiveMap || null, alphaMap: m.alphaMap || null,
    transparent: !!m.transparent, opacity: m.opacity ?? 1, side: m.side, vertexColors: !!m.vertexColors,
    roughness: Math.max(0.08, Math.min(1, 1 - Math.sqrt(Math.min(1, shin / 120)))), metalness: /chrome|metal/i.test(m.name || '') ? 0.9 : 0.1,
  });
  if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
  return s;
}

// A fitted custom model for one car.
export class CustomCar {
  constructor(object, meta) {
    this.object = object;
    this.meta = meta;
    this.root = new THREE.Group(); this.root.name = 'custom-car';
    this.pivot = new THREE.Group();
    this.root.add(this.pivot); this.pivot.add(object);
    this.stats = { meshes: 0, tris: 0, materials: 0 };
    this.paintMats = [];
    this.allMats = [];
    this.orig = new Map();
    this.prepare();
  }

  prepare() {
    this.object.updateMatrixWorld(true);
    const mats = new Map();
    const area = new Map();
    this.object.traverse((o) => {
      if (!o.isMesh) return;
      if (IGNORE_MESH.test(o.name || '')) { o.visible = false; return; }
      this.stats.meshes++;
      const g = o.geometry;
      if (g) this.stats.tris += Math.round((g.index ? g.index.count : g.getAttribute('position')?.count || 0) / 3);
      if (g && !g.getAttribute('normal')) g.computeVertexNormals();
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const conv = list.map((m) => { if (!m) return m; if (!mats.has(m)) mats.set(m, toStandard(m)); return mats.get(m); });
      o.material = Array.isArray(o.material) ? conv : conv[0];
      o.castShadow = true; o.receiveShadow = true;
      const a = g ? triArea(g) * Math.abs(o.matrixWorld.determinant() || 1) ** (2 / 3) : 0;
      if (Array.isArray(o.material) && g && g.groups.length) {
        for (const gr of g.groups) { const m = o.material[gr.materialIndex]; if (m) area.set(m, (area.get(m) || 0) + a * (gr.count / Math.max(1, g.index ? g.index.count : g.getAttribute('position').count))); }
      } else if (!Array.isArray(o.material) && o.material) area.set(o.material, (area.get(o.material) || 0) + a);
    });
    const uniq = [...new Set([...mats.values()])].filter(Boolean);
    this.stats.materials = uniq.length;
    for (const m of uniq) {
      if (IS_GLASS.test(m.name || '') || (m.transparent && m.opacity < 0.9)) { m.transparent = true; m.depthWrite = false; m.opacity = Math.min(m.opacity ?? 1, 0.55); m.roughness = 0.05; m.metalness = 0.1; }
      if (m.map) m.map.anisotropy = 4;
      m.envMapIntensity = 1;
      this.orig.set(m, { color: m.color.clone(), transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite, metalness: m.metalness, roughness: m.roughness });
    }
    this.allMats = uniq;
    // body paint: named paint materials, else the biggest opaque surface
    let paint = uniq.filter((m) => IS_PAINT.test(m.name || '') && !NOT_PAINT.test(m.name || '') && !IS_GLASS.test(m.name || ''));
    if (!paint.length) {
      const cand = uniq.filter((m) => !m.transparent && !NOT_PAINT.test(m.name || '') && !IS_GLASS.test(m.name || ''));
      cand.sort((a, b) => (area.get(b) || 0) - (area.get(a) || 0));
      if (cand.length) paint = [cand[0]];
    }
    // paint gets a clearcoat so the paint tab looks like the built-in cars
    this.paintMats = paint.map((m) => {
      const p = new THREE.MeshPhysicalMaterial({ name: m.name, color: m.color.clone(), map: m.map, normalMap: m.normalMap, roughness: Math.min(m.roughness, 0.4), metalness: m.metalness, clearcoat: 1, clearcoatRoughness: 0.05, vertexColors: m.vertexColors, side: m.side });
      this.orig.set(p, { ...this.orig.get(m), color: m.color.clone() });
      this.object.traverse((o) => {
        if (!o.isMesh) return;
        if (Array.isArray(o.material)) o.material = o.material.map((x) => (x === m ? p : x));
        else if (o.material === m) o.material = p;
      });
      return p;
    });
    this.allMats = this.allMats.filter((m) => !paint.includes(m)).concat(this.paintMats);
  }

  // orient = { up: 0 | 1 | 2, yaw: quarter turns }. Returns the auto orientation when orient is null.
  fit(car, orient) {
    const L = car.dims[0] / 1000;
    const savedY = this.root.position.y;
    this.root.position.set(0, 0, 0);
    this.pivot.position.set(0, 0, 0); this.pivot.scale.setScalar(1); this.pivot.quaternion.identity();
    const box = new THREE.Box3();
    const measure = () => { this.root.updateMatrixWorld(true); box.makeEmpty(); this.object.traverse((o) => { if (o.isMesh && o.visible && o.geometry) { o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); box.union(b); } }); return box; };
    let auto = null;
    if (!orient) {
      // glTF is Y-up by definition; FBX and OBJ usually are too, unless the length runs along Y (a Z-up export)
      const s = measure().getSize(new THREE.Vector3());
      const gltf = this.meta && /^(glb|gltf)$/.test(this.meta.kind || '');
      const up = !gltf && s.y > Math.max(s.x, s.z) * 1.15 ? 1 : 0;
      const X = s.x, Z = up === 1 ? s.y : s.z;
      auto = { up, yaw: Z > X ? 1 : 0 };
      orient = auto;
    }
    const qUp = new THREE.Quaternion();
    if (orient.up === 1) qUp.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    else if (orient.up === 2) qUp.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((orient.yaw || 0) % 4) * Math.PI / 2);
    this.pivot.quaternion.copy(qYaw.multiply(qUp));
    let s = measure().getSize(new THREE.Vector3());
    const k = L / Math.max(1e-6, s.x);
    this.pivot.scale.setScalar(k);
    const b2 = measure();
    const c = b2.getCenter(new THREE.Vector3());
    this.pivot.position.set(-c.x, -b2.min.y, -c.z);
    this.root.position.y = savedY;
    this.root.updateMatrixWorld(true);
    this.size = measure().getSize(new THREE.Vector3());
    this.root.position.y = savedY;
    this.orient = orient;
    if (auto && this.frontSign() < 0) {
      // named lamps, grille or exhaust say the car faces the other way
      auto.yaw = (auto.yaw + 2) % 4;
      this.fit(car, auto);
      return auto;
    }
    this.setupWheels();
    return auto;
  }

  // +1 when front-only parts sit at +x, -1 when they sit at -x, 0 when the names do not tell.
  frontSign() {
    const FRONT = /head.?l(igh|am)p|headlight|front.?(light|lamp|bumper)|grill|radiator|bonnet|hood/i;
    const REAR = /tail.?(light|lamp)|rear.?(light|lamp|bumper)|brake.?light|stop.?light|exhaust|muffler|tail.?pipe|trunk|boot/i;
    const v = new THREE.Vector3();
    let fs = 0, fn = 0, rs = 0, rn = 0;
    this.root.updateMatrixWorld(true);
    this.object.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const names = [o.name, o.parent && o.parent.name, ...(Array.isArray(o.material) ? o.material : [o.material]).map((m) => m && m.name)].join(' ');
      const isF = FRONT.test(names), isR = REAR.test(names);
      if (isF === isR) return;
      new THREE.Box3().setFromObject(o).getCenter(v);
      if (isF) { fs += v.x; fn++; } else { rs += v.x; rn++; }
    });
    if (!fn || !rn) return 0;
    const d = fs / fn - rs / rn;
    return Math.abs(d) < 0.3 ? 0 : Math.sign(d);
  }

  setupWheels() {
    this.wheels = [];
    const found = [];
    this.object.traverse((o) => {
      if (!IS_WHEEL.test(o.name || '') || NOT_WHEEL.test(o.name || '')) return;
      let p = o.parent, nested = false;
      while (p && p !== this.object) { if (IS_WHEEL.test(p.name || '') && !NOT_WHEEL.test(p.name || '')) { nested = true; break; } p = p.parent; }
      if (!nested) found.push(o);
    });
    if (found.length < 2 || found.length > 12) return;
    this.root.updateMatrixWorld(true);
    const L = this.size ? this.size.x : 4;
    for (const o of found) {
      const box = new THREE.Box3().setFromObject(o);
      if (box.isEmpty()) continue;
      const sz = box.getSize(new THREE.Vector3());
      if (sz.x > L * 0.33 || sz.y < 0.25 || sz.y > 1.4) continue; // one mesh holding all wheels, or not a wheel
      const center = box.getCenter(new THREE.Vector3());
      const parent = o.parent;
      const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      const cLocal = center.clone().applyMatrix4(inv);
      const axis = new THREE.Vector3(0, 0, 1).transformDirection(inv).normalize();
      this.wheels.push({ o, c: cLocal, axis, p0: o.position.clone(), q0: o.quaternion.clone(), r: sz.y / 2, side: center.z >= 0 ? 1 : -1 });
    }
  }

  spin(dist) {
    if (!this.wheels) return;
    const q = new THREE.Quaternion();
    for (const w of this.wheels) {
      q.setFromAxisAngle(w.axis, -dist / Math.max(0.1, w.r));
      w.o.quaternion.copy(q).multiply(w.q0);
      w.o.position.copy(w.p0).sub(w.c).applyQuaternion(q).add(w.c);
    }
  }

  applyPaint(color, finish, enabled) {
    for (const m of this.paintMats) {
      const o = this.orig.get(m);
      if (enabled) {
        m.color.set(color);
        const f = { gloss: [0.05, 0.3, 1], metallic: [0.55, 0.32, 1], pearl: [0.35, 0.3, 1], matte: [0.08, 0.8, 0], satin: [0.4, 0.55, 0.35], candy: [0.75, 0.22, 1], chrome: [1, 0.06, 0.3] }[finish] || [0.5, 0.32, 1];
        m.metalness = f[0]; m.roughness = f[1]; m.clearcoat = f[2];
      } else if (o) { m.color.copy(o.color); m.metalness = o.metalness; m.roughness = o.roughness; m.clearcoat = 0.6; }
      m.needsUpdate = true;
    }
  }

  setXray(on) {
    for (const m of this.allMats) {
      const o = this.orig.get(m) || {};
      m.transparent = on ? true : !!o.transparent;
      m.opacity = on ? 0.14 : (o.opacity ?? 1);
      m.depthWrite = on ? false : (o.depthWrite ?? true);
      m.needsUpdate = true;
    }
  }

  dispose() {
    const seen = new Set();
    this.object.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m || seen.has(m)) continue; seen.add(m);
          for (const k of ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap']) m[k]?.dispose?.();
          m.dispose();
        }
      }
    });
    this.root.removeFromParent();
  }
}

// ---------------------------------------------------------------- per-car storage (IndexedDB)
const DB = 'pakswap-models', STORE = 'models';
function openDB() {
  return new Promise((res, rej) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
}
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    const req = fn(st);
    t.oncomplete = () => { res(req && req.result); db.close(); };
    t.onerror = () => { rej(t.error); db.close(); };
    t.onabort = () => { rej(t.error); db.close(); };
  });
}
export async function saveModel(carId, record) { try { await tx('readwrite', (s) => s.put(record, carId)); return true; } catch (e) { return false; } }
export async function loadModelRecord(carId) { try { return (await tx('readonly', (s) => s.get(carId))) || null; } catch (e) { return null; } }
export async function deleteModel(carId) { try { await tx('readwrite', (s) => s.delete(carId)); return true; } catch (e) { return false; } }
export async function listModels() { try { return (await tx('readonly', (s) => s.getAllKeys())) || []; } catch (e) { return []; } }
