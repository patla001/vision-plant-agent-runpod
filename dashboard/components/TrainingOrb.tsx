"use client";

import { useEffect, useRef } from "react";

export default function TrainingOrb({ className = "" }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let animId: number;
    let cleanup: (() => void) | undefined;

    (async () => {
      const THREE = await import("three");
      const el = mountRef.current;
      if (!el) return;

      /* ── Renderer ─────────────────────────────────────────── */
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(el.clientWidth, el.clientHeight);
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);

      const scene  = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 500);
      camera.position.z = 5;

      /* ── Core icosahedron wireframe ───────────────────────── */
      const icoGeo = new THREE.IcosahedronGeometry(1.2, 1);
      const icoMat = new THREE.MeshBasicMaterial({
        color: "#22d3ee", wireframe: true, transparent: true, opacity: .35,
      });
      const ico = new THREE.Mesh(icoGeo, icoMat);
      scene.add(ico);

      /* ── Inner glowing sphere ─────────────────────────────── */
      const coreGeo = new THREE.SphereGeometry(.78, 32, 32);
      const coreMat = new THREE.MeshBasicMaterial({
        color: "#06b6d4", transparent: true, opacity: .12,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      scene.add(core);

      /* ── Outer soft sphere (glow halo) ────────────────────── */
      const haloGeo = new THREE.SphereGeometry(1.55, 32, 32);
      const haloMat = new THREE.MeshBasicMaterial({
        color: "#8b5cf6", transparent: true, opacity: .07, side: THREE.BackSide,
      });
      scene.add(new THREE.Mesh(haloGeo, haloMat));

      /* ── Orbiting ring of particles ───────────────────────── */
      const RING_N   = 60;
      const ringPos  = new Float32Array(RING_N * 3);
      const ringCol  = new Float32Array(RING_N * 3);
      const RADIUS   = 2.1;

      const C1 = new THREE.Color("#22d3ee");
      const C2 = new THREE.Color("#a78bfa");

      for (let i = 0; i < RING_N; i++) {
        const angle = (i / RING_N) * Math.PI * 2;
        const jitter = (Math.random() - .5) * .3;
        ringPos[i*3]   = Math.cos(angle) * (RADIUS + jitter);
        ringPos[i*3+1] = (Math.random() - .5) * .4;
        ringPos[i*3+2] = Math.sin(angle) * (RADIUS + jitter);
        const c = i % 2 === 0 ? C1 : C2;
        ringCol[i*3] = c.r; ringCol[i*3+1] = c.g; ringCol[i*3+2] = c.b;
      }

      const ringGeo = new THREE.BufferGeometry();
      ringGeo.setAttribute("position", new THREE.BufferAttribute(ringPos, 3));
      ringGeo.setAttribute("color",    new THREE.BufferAttribute(ringCol, 3));
      const ringMat = new THREE.PointsMaterial({
        size: 3.5, vertexColors: true, transparent: true, opacity: .8, sizeAttenuation: true,
      });
      const ring = new THREE.Points(ringGeo, ringMat);
      scene.add(ring);

      /* ── Second tilted ring ───────────────────────────────── */
      const ring2Pos = new Float32Array(RING_N * 3);
      for (let i = 0; i < RING_N; i++) {
        const angle = (i / RING_N) * Math.PI * 2 + .5;
        const jitter = (Math.random() - .5) * .3;
        ring2Pos[i*3]   = Math.cos(angle) * (RADIUS * .85 + jitter);
        ring2Pos[i*3+1] = Math.sin(angle * .6) * .7;
        ring2Pos[i*3+2] = Math.sin(angle) * (RADIUS * .85 + jitter);
      }
      const ring2Geo = new THREE.BufferGeometry();
      ring2Geo.setAttribute("position", new THREE.BufferAttribute(ring2Pos, 3));
      ring2Geo.setAttribute("color",    new THREE.BufferAttribute(ringCol, 3));
      const ring2 = new THREE.Points(ring2Geo, new THREE.PointsMaterial({
        size: 2.5, vertexColors: true, transparent: true, opacity: .5, sizeAttenuation: true,
      }));
      ring2.rotation.x = Math.PI / 3;
      scene.add(ring2);

      /* ── Resize ───────────────────────────────────────────── */
      const onResize = () => {
        if (!el) return;
        camera.aspect = el.clientWidth / el.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(el.clientWidth, el.clientHeight);
      };
      window.addEventListener("resize", onResize);

      /* ── Animate ──────────────────────────────────────────── */
      let t = 0;
      const animate = () => {
        animId = requestAnimationFrame(animate);
        t += 0.012;

        // Pulsing scale on core + wireframe
        const pulse = 1 + Math.sin(t * 1.4) * .06;
        ico.scale.setScalar(pulse);
        core.scale.setScalar(pulse * 1.05);
        coreMat.opacity = .08 + Math.sin(t) * .06;
        icoMat.opacity  = .28 + Math.sin(t * 1.2) * .1;

        // Rotation
        ico.rotation.y  += .008;
        ico.rotation.x  += .004;
        ring.rotation.y += .006;
        ring2.rotation.y -= .004;
        ring2.rotation.z += .003;

        renderer.render(scene, camera);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(animId);
        window.removeEventListener("resize", onResize);
        renderer.dispose();
        icoGeo.dispose(); icoMat.dispose();
        coreGeo.dispose(); coreMat.dispose();
        haloGeo.dispose(); haloMat.dispose();
        ringGeo.dispose(); ringMat.dispose();
        ring2Geo.dispose();
        if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
      };
    })();

    return () => cleanup?.();
  }, []);

  return <div ref={mountRef} className={`${className}`} />;
}
