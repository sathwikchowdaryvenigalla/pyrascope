import * as THREE from 'three';

// Restrained view-space shading shared by the base Earth and every imagery tile, so they always match.
// The "sun" is fixed relative to the viewer: the visible hemisphere is never dark (data stays readable),
// but the globe gets natural limb darkening and a gentle light-to-shade gradient.
const LIGHT = 'normalize(vec3(-0.45, 0.35, 0.82))';

export function applyShade(material) {
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShadeN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShadeN = normalize(normalMatrix * normalize(position));');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShadeN;')
      .replace('#include <opaque_fragment>', `float shadeD = dot(normalize(vShadeN), ${LIGHT});
outgoingLight *= mix(0.68, 1.04, smoothstep(-0.2, 0.7, shadeD));
#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'pyrascope-shade-v1';
  return material;
}

// Thin fresnel atmosphere shell (back faces only): a soft blue rim at the limb, nothing over the surface.
export function createAtmosphere() {
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vN; void main(){ float i = pow(max(0.0, 0.62 - dot(vN, vec3(0.0,0.0,1.0))), 3.2); gl_FragColor = vec4(vec3(0.32, 0.58, 1.0) * i * 1.6, clamp(i * 1.6, 0.0, 1.0)); }',
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.03, 96, 96), mat);
  mesh.renderOrder = -5;
  return mesh;
}
