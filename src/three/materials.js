// Materials. The body paint is a MeshPhysicalMaterial with an injected car-space livery,
// panel-gap, carbon-hood and metallic-flake layer, so liveries need no UV unwrap.
import * as THREE from 'three';
import { carbonTexture, truckArtTexture, camoTexture, checkerTexture } from './textures.js';

const LIVERY_ID = { none: 0, stripes: 1, side: 2, truckart: 3, carbon: 4, camo: 5, checker: 6 };

export function makePaintMaterial() {
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
  const u = {
    uLivery: { value: 0 },
    uLiveryColor: { value: new THREE.Color('#ffffff') },
    uLiveryTex: { value: carbonTexture() },
    uCarbon: { value: carbonTexture() },
    uDims: { value: new THREE.Vector4(4, 1.7, 1.45, 0.16) }, // L, W, H, GC
    uBelt: { value: 1.0 },
    uSeamX: { value: [9, 9, 9, 9] },
    uSeamY: { value: new THREE.Vector2(0.3, 1.0) },
    uHood: { value: new THREE.Vector4(9, 9, 0, 0) }, // hood front x, cowl x, half width, carbon flag
    uDeck: { value: new THREE.Vector4(9, 9, 0, 0) }, // deck start x, tail x, half width, enabled
    uSeamOn: { value: 1 },
    uFlake: { value: 0 }, // metallic flake strength
    // world -> car body transform, so the pattern stays put on the body wherever the car is
    // (studio turntable, or driving and leaning in the open world)
    uCarInv: { value: new THREE.Matrix4() },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;\nuniform mat4 uCarInv;')
      // car-space position so liveries and seams line up across separate parts (mirrors, spoilers, scoops)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = (uCarInv * (modelMatrix * vec4(position, 1.0))).xyz;\nvObjNormal = mat3(uCarInv) * (mat3(modelMatrix) * normal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vObjPos;
varying vec3 vObjNormal;
uniform int uLivery;
uniform vec3 uLiveryColor;
uniform sampler2D uLiveryTex;
uniform sampler2D uCarbon;
uniform vec4 uDims;
uniform float uBelt;
uniform float uSeamX[4];
uniform vec2 uSeamY;
uniform vec4 uHood;
uniform vec4 uDeck;
uniform float uSeamOn;
uniform float uFlake;
float band(float v, float a, float b) {
  float w = max(fwidth(v), 1e-4) * 1.2;
  return smoothstep(a - w, a + w, v) * (1.0 - smoothstep(b - w, b + w, v));
}
float line(float v, float c, float hw) {
  float w = max(fwidth(v), 1e-4);
  return 1.0 - smoothstep(hw, hw + w * 1.5, abs(v - c));
}
vec3 triplanar(sampler2D t, vec3 p, vec3 n, float s) {
  vec3 b = pow(abs(n), vec3(4.0)); b /= (b.x + b.y + b.z + 1e-4);
  vec3 cx = texture2D(t, p.zy * s).rgb;
  vec3 cy = texture2D(t, p.xz * s).rgb;
  vec3 cz = texture2D(t, p.xy * s).rgb;
  return cx * b.x + cy * b.y + cz * b.z;
}
vec3 flakeDir(vec3 c) {
  vec3 h = fract(sin(vec3(dot(c, vec3(127.1, 311.7, 74.7)), dot(c, vec3(269.5, 183.3, 246.1)), dot(c, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
  return h * 2.0 - 1.0;
}
float carbonMaskV = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 P = vObjPos; vec3 N = normalize(vObjNormal);
  float L = uDims.x, W = uDims.y, H = uDims.z, GC = uDims.w;
  float az = abs(P.z);
  if (uLivery == 1) {
    float s = band(az, 0.045, 0.16) * step(-0.25, N.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, uLiveryColor, s);
  } else if (uLivery == 2) {
    float side = smoothstep(0.35, 0.6, abs(N.z));
    float yc = mix(GC + 0.2, uBelt - 0.08, 0.55) + (P.x / L) * 0.06;
    float s = band(P.y, yc - 0.05, yc + 0.05) * side * step(-L * 0.42, P.x);
    float s2 = band(P.y, yc - 0.085, yc - 0.065) * side * step(-L * 0.42, P.x);
    diffuseColor.rgb = mix(diffuseColor.rgb, uLiveryColor, max(s, s2));
  } else if (uLivery == 3) {
    vec3 b = pow(abs(N), vec3(3.0)); b /= (b.x + b.y + b.z + 1e-4);
    vec3 cs = texture2D(uLiveryTex, vec2(P.x / 2.2 + 0.5, (P.y - GC) / max(0.3, uBelt - GC + 0.15))).rgb;
    vec3 ct = texture2D(uLiveryTex, vec2(P.x / 1.6, P.z / 1.2 + 0.5)).rgb;
    vec3 cf = texture2D(uLiveryTex, vec2(P.z / 1.6 + 0.5, (P.y - GC) / max(0.3, uBelt - GC + 0.15))).rgb;
    vec3 art = cs * b.z + ct * b.y + cf * b.x;
    diffuseColor.rgb = art;
  } else if (uLivery == 4) {
    diffuseColor.rgb = triplanar(uCarbon, P, N, 7.0) * 0.9;
    carbonMaskV = 1.0;
  } else if (uLivery == 5) {
    diffuseColor.rgb = triplanar(uLiveryTex, P, N, 0.8);
  } else if (uLivery == 6) {
    float side = smoothstep(0.35, 0.6, abs(N.z));
    float yc = mix(GC + 0.2, uBelt - 0.06, 0.5);
    float s = band(P.y, yc - 0.07, yc + 0.07) * side;
    float top = band(az, 0.0, 0.2) * step(0.4, N.y) * step(uHood.y, P.x);
    vec3 chk = triplanar(uLiveryTex, P, N, 3.5);
    diffuseColor.rgb = mix(diffuseColor.rgb, chk, max(s, top));
  }
  if (uHood.w > 0.5) {
    float hm = step(uHood.y, P.x) * step(P.x, uHood.x) * step(az, uHood.z) * smoothstep(0.25, 0.5, N.y);
    if (hm > 0.0) { diffuseColor.rgb = mix(diffuseColor.rgb, triplanar(uCarbon, P, N, 7.0) * 0.9, hm); carbonMaskV = max(carbonMaskV, hm); }
  }
  if (uSeamOn > 0.5) {
    float side = smoothstep(0.4, 0.7, abs(N.z));
    float inY = step(uSeamY.x, P.y) * step(P.y, uSeamY.y);
    float seam = 0.0;
    for (int i = 0; i < 4; i++) seam = max(seam, line(P.x, uSeamX[i], 0.0022) * side * inY);
    float topF = smoothstep(0.35, 0.6, N.y);
    seam = max(seam, line(az, uHood.z, 0.0022) * topF * step(uHood.y, P.x) * step(P.x, uHood.x));
    seam = max(seam, line(P.x, uHood.x, 0.0022) * topF * step(az, uHood.z));
    if (uDeck.w > 0.5) {
      seam = max(seam, line(az, uDeck.z, 0.0022) * topF * step(uDeck.y, P.x) * step(P.x, uDeck.x));
      seam = max(seam, line(P.x, uDeck.x, 0.0022) * topF * step(az, uDeck.z));
    }
    diffuseColor.rgb *= 1.0 - seam * 0.82;
  }
}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.25, carbonMaskV);
roughnessFactor = mix(roughnessFactor, 0.32, carbonMaskV);`)
      // metallic flakes: tiny mirrors under the lacquer tilt the base layer's normal while the
      // clear coat above stays smooth. They fade out once a flake is smaller than a pixel, so the
      // paint sparkles close up and never shimmers from far away.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (uFlake > 0.001 && carbonMaskV < 0.5) {
  float sc = 520.0;
  float fw = max(length(dFdx(vObjPos)), length(dFdy(vObjPos))) * sc;
  float fk = uFlake * (1.0 - smoothstep(0.45, 1.3, fw));
  if (fk > 0.0) {
    vec3 fd = flakeDir(floor(vObjPos * sc)) + 0.5 * flakeDir(floor(vObjPos * sc * 2.03) + 17.0);
    vec3 fv = (viewMatrix * vec4(fd, 0.0)).xyz;
    normal = normalize(normal + fv * fk * 0.16);
  }
}`);
  };
  mat.customProgramCacheKey = () => 'pakswap-paint-v4';
  return mat;
}

export function applyPaint(mat, color, finish) {
  mat.color.set(color);
  // clearcoat, iridescence and sheen bump the material version themselves when they switch
  // on or off, so no forced shader refresh is needed here
  let irid = 0, flake = 0;
  switch (finish) {
    case 'gloss': mat.metalness = 0.05; mat.roughness = 0.32; mat.clearcoat = 1; mat.clearcoatRoughness = 0.03; break;
    case 'metallic': mat.metalness = 0.6; mat.roughness = 0.36; mat.clearcoat = 1; mat.clearcoatRoughness = 0.035; flake = 0.9; break;
    case 'pearl': mat.metalness = 0.35; mat.roughness = 0.3; mat.clearcoat = 1; mat.clearcoatRoughness = 0.03; irid = 0.9; flake = 0.5; break;
    case 'matte': mat.metalness = 0.08; mat.roughness = 0.82; mat.clearcoat = 0; break;
    case 'satin': mat.metalness = 0.4; mat.roughness = 0.55; mat.clearcoat = 0.35; mat.clearcoatRoughness = 0.45; flake = 0.25; break;
    case 'candy': mat.metalness = 0.75; mat.roughness = 0.24; mat.clearcoat = 1; mat.clearcoatRoughness = 0.02; flake = 0.7; break;
    case 'chrome': mat.metalness = 1; mat.roughness = 0.06; mat.clearcoat = 0.3; mat.clearcoatRoughness = 0.05; break;
    default: break;
  }
  mat.sheen = 0;
  mat.iridescence = irid;
  if (irid > 0) { mat.iridescenceIOR = 1.5; mat.iridescenceThicknessRange = [180, 720]; }
  mat.userData.u.uFlake.value = flake;
}

export function applyLivery(mat, livery, color, paint) {
  const u = mat.userData.u;
  u.uLivery.value = LIVERY_ID[livery] || 0;
  u.uLiveryColor.value.set(color || '#ffffff');
  if (livery === 'truckart') u.uLiveryTex.value = truckArtTexture(paint);
  else if (livery === 'camo') u.uLiveryTex.value = camoTexture();
  else if (livery === 'checker') u.uLiveryTex.value = checkerTexture();
  else u.uLiveryTex.value = carbonTexture();
}

// Window glass. Reflections stay bright however light the tint is: the alpha of a fragment is
// raised by the light it mirrors, the way real glass shows the sky over a dark cabin.
export function makeGlassMaterial() {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x0c1218, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.6,
    side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.4, clearcoat: 1, clearcoatRoughness: 0.02,
  });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `diffuseColor.a = clamp(diffuseColor.a + min(dot(outgoingLight, vec3(0.34)), 1.0) * 0.7, 0.0, 1.0);
outgoingLight = min(outgoingLight, vec3(2.2));
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'pakswap-glass-v1';
  return mat;
}

// tint = how dark the film is, in percent
export function setTint(glass, tint) {
  const t = Math.max(0, Math.min(95, tint)) / 100;
  glass.opacity = 0.4 + 0.57 * Math.pow(t, 0.8);
  glass.color.setRGB(0.03 * (1 - t) + 0.006, 0.042 * (1 - t) + 0.008, 0.055 * (1 - t) + 0.011);
}

export const MAT = {};
export function sharedMaterials() {
  if (MAT.ready) return MAT;
  MAT.trim = new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: 0.55, metalness: 0.1 });
  MAT.plastic = new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.8, metalness: 0.0 });
  MAT.rubber = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.92, metalness: 0 });
  MAT.chrome = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.06, metalness: 1 });
  MAT.metal = new THREE.MeshStandardMaterial({ color: 0x8c9096, roughness: 0.35, metalness: 0.9 });
  MAT.darkMetal = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.45, metalness: 0.85 });
  MAT.interior = new THREE.MeshStandardMaterial({ color: 0x1d1d20, roughness: 0.9, metalness: 0 });
  MAT.interiorLight = new THREE.MeshStandardMaterial({ color: 0x5b5148, roughness: 0.85, metalness: 0 });
  MAT.liner = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  MAT.under = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.95, metalness: 0 });
  MAT.carbon = new THREE.MeshPhysicalMaterial({ map: carbonTexture(), roughness: 0.35, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
  MAT.carbon.map.repeat.set(4, 4);
  MAT.orange = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.5, metalness: 0 });
  MAT.ready = true;
  return MAT;
}
