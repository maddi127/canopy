import { useContext, useMemo } from 'react';
import { EffectComposer, EffectComposerContext, HueSaturation, BrightnessContrast } from '@react-three/postprocessing';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import * as THREE from 'three';

// ── Watercolor ink pass — a single custom postprocessing Effect that turns the toon render into
// a hand-painted illustration. It still Sobel-edges the scene's depth (built-in DEPTH attribute)
// and normals (from the optional NormalPass) for silhouette + crease lines, but layers a full
// watercolor pipeline around it: softened pigment fills, wet-edge pooling, paper granulation,
// soft toon banding and a paper vignette. All of it is deterministic — every "random" value is a
// hash/value-noise function of screen coordinates only (no time uniforms), so the CaptureBridge
// toDataURL of the composed frame stays reproducible.
//
// Implementation note (postprocessing v6 Effect API): to blur the *fill* colour we need to resample
// the pass input at neighbouring pixels. postprocessing exposes the pass input as the global
// `sampler2D inputBuffer` (same one bokeh/chromatic-aberration read) once the effect declares
// EffectAttribute.CONVOLUTION. Declaring CONVOLUTION also makes @react-three/postprocessing render
// this effect in its OWN EffectPass (see its isConvolution grouping), so the crisp ink + wet edge +
// granulation + vignette all land BEFORE the HueSaturation/BrightnessContrast grade pass — exactly
// the pass order we want. CONVOLUTION | DEPTH together is a supported combo (bokeh uses it).
const inkFragmentShader = /* glsl */ `
  uniform sampler2D normalBuffer;
  uniform vec2 texelSize;
  uniform vec3 lineColor;
  uniform float depthBias;
  uniform float normalBias;
  uniform float lineStrength;
  uniform float wetStrength;
  uniform float granAmount;
  uniform float bandStrength;
  uniform float wobbleAmp;
  uniform float vignetteStart;
  uniform vec3 paperColor;

  // NOTE: readDepth(uv) + the depthBuffer sampler (DEPTH attribute) and the inputBuffer sampler
  // (CONVOLUTION attribute) are auto-injected by postprocessing's EffectPass assembly -- do not
  // redeclare any of them here.

  // Deterministic value noise (coordinate-only; no time, no random()).
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // 3x3 Sobel on linear-ish depth, centred at c with sample radius r, normalised by centre depth.
  float depthEdgeAt(vec2 c, vec2 r, float depth) {
    float d00 = readDepth(c + vec2(-r.x, -r.y));
    float d10 = readDepth(c + vec2( 0.0, -r.y));
    float d20 = readDepth(c + vec2( r.x, -r.y));
    float d01 = readDepth(c + vec2(-r.x,  0.0));
    float d21 = readDepth(c + vec2( r.x,  0.0));
    float d02 = readDepth(c + vec2(-r.x,  r.y));
    float d12 = readDepth(c + vec2( 0.0,  r.y));
    float d22 = readDepth(c + vec2( r.x,  r.y));
    float gx = -d00 - 2.0 * d01 - d02 + d20 + 2.0 * d21 + d22;
    float gy = -d00 - 2.0 * d10 - d20 + d02 + 2.0 * d12 + d22;
    return sqrt(gx * gx + gy * gy) / max(depth, 0.0001);
  }
  // Sobel on the view-space normal buffer (catches creases where depth barely changes).
  float normalEdgeAt(vec2 c, vec2 r) {
    vec3 n00 = texture2D(normalBuffer, c + vec2(-r.x, -r.y)).rgb;
    vec3 n20 = texture2D(normalBuffer, c + vec2( r.x, -r.y)).rgb;
    vec3 n02 = texture2D(normalBuffer, c + vec2(-r.x,  r.y)).rgb;
    vec3 n22 = texture2D(normalBuffer, c + vec2( r.x,  r.y)).rgb;
    vec3 n10 = texture2D(normalBuffer, c + vec2( 0.0, -r.y)).rgb;
    vec3 n12 = texture2D(normalBuffer, c + vec2( 0.0,  r.y)).rgb;
    vec3 n01 = texture2D(normalBuffer, c + vec2(-r.x,  0.0)).rgb;
    vec3 n21 = texture2D(normalBuffer, c + vec2( r.x,  0.0)).rgb;
    vec3 gx = -n00 - 2.0 * n01 - n02 + n20 + 2.0 * n21 + n22;
    vec3 gy = -n00 - 2.0 * n10 - n20 + n02 + 2.0 * n12 + n22;
    return length(gx) + length(gy);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    vec2 t = texelSize;
    vec2 px = uv / t; // screen-space pixel coordinates for coordinate-only noise

    // (1) COLOR SOFTEN — 5-tap cross blur of the fill so pigment bleeds; lines stay crisp because
    // the ink is drawn LAST on top of this softened base (resampling the pass inputBuffer).
    vec3 color = texture2D(inputBuffer, uv).rgb * 0.4;
    color += texture2D(inputBuffer, uv + vec2( 1.5 * t.x, 0.0)).rgb * 0.15;
    color += texture2D(inputBuffer, uv + vec2(-1.5 * t.x, 0.0)).rgb * 0.15;
    color += texture2D(inputBuffer, uv + vec2(0.0,  1.5 * t.y)).rgb * 0.15;
    color += texture2D(inputBuffer, uv + vec2(0.0, -1.5 * t.y)).rgb * 0.15;

    // (2) TOON BANDING — quantise luminance into ~3 soft washes (smoothstep, not hard posterise),
    // keep hue by scaling colour toward the banded value. Subtle by default.
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    float steps = 3.0;
    float ql = floor(lum * steps) / steps;
    ql += smoothstep(0.35, 0.65, fract(lum * steps)) / steps;
    float ratio = (ql + 0.001) / (lum + 0.001);
    color *= mix(1.0, ratio, bandStrength);

    // Hand-stroke fields: a high-freq wobble offset (~22px wavelength) for the ink sampling coord,
    // and a low-freq pen-pressure field (~60px) modulating line strength.
    vec2 woff = vec2(vnoise(px * (1.0 / 22.0)), vnoise(px * (1.0 / 22.0) + vec2(37.2, 11.7))) - 0.5;
    vec2 wuv = uv + woff * 2.0 * wobbleAmp * t; // ~wobbleAmp texels of undulation
    float pressure = mix(0.55, 1.0, vnoise(px * (1.0 / 60.0) + vec2(5.1, 9.3)));

    // (3) WET-EDGE DARKENING — a WIDER Sobel (2.5x radius); instead of drawing ink it multiplies the
    // fill toward a darker, slightly more saturated version of itself in a band just inside
    // silhouettes. This is the watercolor pooling; composited UNDER the crisp ink line.
    float deW = depthEdgeAt(uv, t * 2.5, depth);
    float neW = normalEdgeAt(uv, t * 2.5);
    float wet = max(smoothstep(depthBias * 0.6, depthBias * 3.0, deW),
                    smoothstep(normalBias * 0.6, normalBias * 2.5, neW));
    wet = clamp(wet, 0.0, 1.0) * wetStrength;
    float wl = dot(color, vec3(0.299, 0.587, 0.114));
    vec3 pooled = mix(vec3(wl), color, 1.18) * 0.82; // push saturation up, value down
    color = mix(color, pooled, wet);

    // (4) PAPER GRANULATION — 2-octave value noise multiplied in (~granAmount amplitude) to break
    // flat fills into pigment-on-paper.
    float g = vnoise(px * (1.0 / 150.0)) * 0.6 + vnoise(px * (1.0 / 60.0)) * 0.4;
    color *= 1.0 + (g - 0.5) * granAmount;

    // (5) CRISP INK — the original depth+normal Sobel, but sampled at the wobbled coordinate and
    // with alpha modulated by pen pressure; drawn ON TOP of everything above.
    float deC = depthEdgeAt(wuv, t, depth);
    float neC = normalEdgeAt(wuv, t);
    float hard = (step(depthBias, deC) + step(normalBias, neC)) > 0.0 ? 1.0 : 0.0;
    float mask = smoothstep(0.0, 1.0, max(deC / max(depthBias, 1e-6) - 1.0, neC / max(normalBias, 1e-6) - 1.0));
    mask = clamp(mask * lineStrength, 0.0, 1.0);
    mask = max(mask, hard * lineStrength * 0.6);
    mask *= pressure;
    color = mix(color, lineColor, mask);

    // (6) PAPER VIGNETTE — fade toward paper as aspect-corrected screen distance grows, so the yard
    // floats on the page instead of filling a frame.
    float aspect = t.y / t.x; // width / height
    vec2 vd = (uv - 0.5) * vec2(aspect, 1.0);
    float halfDiag = length(vec2(0.5 * aspect, 0.5));
    float vig = smoothstep(vignetteStart, 1.0, length(vd) / halfDiag);
    color = mix(color, paperColor, vig);

    outputColor = vec4(color, inputColor.a);
  }
`;

class InkOutlineEffectImpl extends Effect {
  constructor({
    normalBuffer,
    lineColor = new THREE.Color('#3a3630'),
    depthBias = 0.0026,
    normalBias = 0.42,
    lineStrength = 0.92,
    wetStrength = 0.18,
    granAmount = 0.08,
    bandStrength = 0.35,
    wobbleAmp = 1.5,
    vignetteStart = 0.78,
    paperColor = new THREE.Color('#f6f1e6'),
  }: {
    normalBuffer: THREE.Texture;
    lineColor?: THREE.Color;
    depthBias?: number;
    normalBias?: number;
    lineStrength?: number;
    wetStrength?: number;
    granAmount?: number;
    bandStrength?: number;
    wobbleAmp?: number;
    vignetteStart?: number;
    paperColor?: THREE.Color;
  }) {
    super('InkOutlineEffect', inkFragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      // CONVOLUTION → resample inputBuffer for the fill blur + gets its own pass (grade runs after).
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      uniforms: new Map<string, any>([
        ['normalBuffer', new THREE.Uniform(normalBuffer)],
        ['texelSize', new THREE.Uniform(new THREE.Vector2())],
        ['lineColor', new THREE.Uniform(lineColor)],
        ['depthBias', new THREE.Uniform(depthBias)],
        ['normalBias', new THREE.Uniform(normalBias)],
        ['lineStrength', new THREE.Uniform(lineStrength)],
        ['wetStrength', new THREE.Uniform(wetStrength)],
        ['granAmount', new THREE.Uniform(granAmount)],
        ['bandStrength', new THREE.Uniform(bandStrength)],
        ['wobbleAmp', new THREE.Uniform(wobbleAmp)],
        ['vignetteStart', new THREE.Uniform(vignetteStart)],
        ['paperColor', new THREE.Uniform(paperColor)],
      ]),
    });
  }
  setSize(width: number, height: number) {
    this.uniforms.get('texelSize')!.value.set(1 / width, 1 / height);
  }
}

// Standard r3f effect-wrapper pattern: memoize ONE effect instance and hand it to the composer
// via <primitive>. (Recreating via JSX args each render thrashes the EffectPass, and passing a
// `setSize` PROP would let r3f overwrite the setSize METHOD — the composer calls effect.setSize
// itself on add/resize, so nothing extra is needed for texelSize.)
type InkTuning = {
  lineColor?: string; depthBias?: number; normalBias?: number; lineStrength?: number;
  wetStrength?: number; granAmount?: number; bandStrength?: number; wobbleAmp?: number;
  vignetteStart?: number; paperColor?: string;
};

function InkOutline({
  lineColor = '#3a3630', depthBias = 0.0026, normalBias = 0.42, lineStrength = 0.92,
  wetStrength = 0.18, granAmount = 0.08, bandStrength = 0.35, wobbleAmp = 1.5,
  vignetteStart = 0.78, paperColor = '#f6f1e6',
}: InkTuning) {
  const { normalPass } = useContext(EffectComposerContext);
  const normalBuffer = normalPass?.texture ?? null;
  const effect = useMemo(() => normalBuffer
    ? new InkOutlineEffectImpl({
        normalBuffer, lineColor: new THREE.Color(lineColor), depthBias, normalBias, lineStrength,
        wetStrength, granAmount, bandStrength, wobbleAmp, vignetteStart,
        paperColor: new THREE.Color(paperColor),
      })
    : null,
  [normalBuffer, lineColor, depthBias, normalBias, lineStrength, wetStrength, granAmount, bandStrength, wobbleAmp, vignetteStart, paperColor]);
  if (!effect) return null; // enableNormalPass missing/not ready — no outlines rather than a crash
  return <primitive object={effect} dispose={null} />;
}

// ── Public composer: watercolor ink pass + gentle desaturate/warm color grade. Mounted only when
// illustration mode is on (over both iso and ground illustration views — see Yard3D.tsx). The ink
// pass now folds in color-soften, banding, wet-edge pooling, granulation and a paper vignette; the
// grade runs after it (separate pass, since the ink effect is CONVOLUTION). Saturation is eased a
// touch vs. the old toon look because the wet edge re-saturates pigment — keep the gentle desat. ──
export function IllustrationEffects(props: InkTuning = {}) {
  return (
    <EffectComposer enableNormalPass multisampling={0}>
      <InkOutline {...props} />
      <HueSaturation hue={0} saturation={-0.08} blendFunction={BlendFunction.NORMAL} />
      <BrightnessContrast brightness={0.05} contrast={-0.05} />
    </EffectComposer>
  );
}

// ── Paper grain overlay — a faint canvas-noise texture as a full-frame CSS overlay (see
// Yard3DPage.tsx). Cheap, avoids another render pass, and easy to keep "very subtle". ──
let _paperGrainDataUrl: string | null = null;
export function paperGrainDataUrl(): string {
  if (_paperGrainDataUrl) return _paperGrainDataUrl;
  const S = 200;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  let s = 12345;
  const rnd = () => { s = Math.imul(s ^ (s >>> 15), s | 1); s ^= s + Math.imul(s ^ (s >>> 7), s | 61); return ((s ^ (s >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < S * S; i++) {
    const v = 200 + Math.floor(rnd() * 55);
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = Math.floor(rnd() * 60);
  }
  g.putImageData(img, 0, 0);
  _paperGrainDataUrl = c.toDataURL('image/png');
  return _paperGrainDataUrl;
}
