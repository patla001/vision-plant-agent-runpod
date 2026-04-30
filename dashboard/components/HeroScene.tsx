"use client";

import { useEffect, useRef } from "react";

const N            = 140;   // particle count
const LINK_DIST    = 130;   // max connection distance
const MAX_LINKS    = 450;   // pre-allocated line segments
const SPEED        = 0.28;

export default function HeroScene({ className = "" }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let animId: number;
    let cleanup: (() => void) | undefined;
    let aborted = false;   // race guard: component may unmount during await

    (async () => {
      const THREE = await import("three");
      if (aborted) return;
      const el    = mountRef.current;
      if (!el) return;

      /* ── Renderer ─────────────────────────────────────────── */
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(el.clientWidth, el.clientHeight);
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);

      /* ── Scene / Camera ───────────────────────────────────── */
      const scene  = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(65, el.clientWidth / el.clientHeight, 1, 1200);
      camera.position.z = 380;

      /* ── Particles ────────────────────────────────────────── */
      const pPos = new Float32Array(N * 3);
      const pCol = new Float32Array(N * 3);
      const vel  = new Float32Array(N * 3);

      const CYAN   = new THREE.Color("#22d3ee");
      const VIOLET = new THREE.Color("#a78bfa");
      const WHITE  = new THREE.Color("#94a3b8");

      for (let i = 0; i < N; i++) {
        pPos[i*3]   = (Math.random() - .5) * 700;
        pPos[i*3+1] = (Math.random() - .5) * 450;
        pPos[i*3+2] = (Math.random() - .5) * 280;

        vel[i*3]   = (Math.random() - .5) * SPEED;
        vel[i*3+1] = (Math.random() - .5) * SPEED;
        vel[i*3+2] = (Math.random() - .5) * SPEED * .4;

        const t = Math.random();
        const c = t < .5 ? CYAN : t < .82 ? VIOLET : WHITE;
        pCol[i*3] = c.r; pCol[i*3+1] = c.g; pCol[i*3+2] = c.b;
      }

      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
      pGeo.setAttribute("color",    new THREE.BufferAttribute(pCol, 3));

      const pMat = new THREE.PointsMaterial({
        size: 3, vertexColors: true,
        transparent: true, opacity: .85, sizeAttenuation: true,
      });
      scene.add(new THREE.Points(pGeo, pMat));

      /* ── Connection lines (pre-allocated) ─────────────────── */
      const lPos = new Float32Array(MAX_LINKS * 6);
      const lGeo = new THREE.BufferGeometry();
      lGeo.setAttribute("position", new THREE.BufferAttribute(lPos, 3));
      lGeo.setDrawRange(0, 0);

      const lMat = new THREE.LineBasicMaterial({ color: "#06b6d4", transparent: true, opacity: .18 });
      scene.add(new THREE.LineSegments(lGeo, lMat));

      /* ── Mouse parallax ───────────────────────────────────── */
      let mx = 0, my = 0;
      const onMouse = (e: MouseEvent) => {
        mx = (e.clientX / window.innerWidth  - .5) * 2;
        my = (e.clientY / window.innerHeight - .5) * -2;
      };
      window.addEventListener("mousemove", onMouse);

      /* ── Resize ───────────────────────────────────────────── */
      const onResize = () => {
        if (!el) return;
        camera.aspect = el.clientWidth / el.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(el.clientWidth, el.clientHeight);
      };
      window.addEventListener("resize", onResize);

      /* ── Animate ──────────────────────────────────────────── */
      const animate = () => {
        animId = requestAnimationFrame(animate);

        // Move particles + wrap
        for (let i = 0; i < N; i++) {
          pPos[i*3]   += vel[i*3];
          pPos[i*3+1] += vel[i*3+1];
          pPos[i*3+2] += vel[i*3+2];
          if (Math.abs(pPos[i*3])   > 350) vel[i*3]   *= -1;
          if (Math.abs(pPos[i*3+1]) > 225) vel[i*3+1] *= -1;
          if (Math.abs(pPos[i*3+2]) > 140) vel[i*3+2] *= -1;
        }
        pGeo.attributes.position.needsUpdate = true;

        // Rebuild connection segments in pre-allocated buffer
        let li = 0;
        for (let i = 0; i < N && li < MAX_LINKS; i++) {
          for (let j = i + 1; j < N && li < MAX_LINKS; j++) {
            const dx = pPos[i*3] - pPos[j*3];
            const dy = pPos[i*3+1] - pPos[j*3+1];
            const dz = pPos[i*3+2] - pPos[j*3+2];
            if (dx*dx + dy*dy + dz*dz < LINK_DIST * LINK_DIST) {
              lPos[li*6]   = pPos[i*3];   lPos[li*6+1] = pPos[i*3+1]; lPos[li*6+2] = pPos[i*3+2];
              lPos[li*6+3] = pPos[j*3];   lPos[li*6+4] = pPos[j*3+1]; lPos[li*6+5] = pPos[j*3+2];
              li++;
            }
          }
        }
        lGeo.setDrawRange(0, li * 2);
        lGeo.attributes.position.needsUpdate = true;

        // Parallax + slow orbit
        camera.position.x += (mx * 35 - camera.position.x) * .04;
        camera.position.y += (my * 22 - camera.position.y) * .04;
        scene.rotation.y  += .0008;
        camera.lookAt(scene.position);

        renderer.render(scene, camera);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(animId);
        window.removeEventListener("mousemove", onMouse);
        window.removeEventListener("resize",    onResize);
        renderer.dispose();
        pGeo.dispose(); pMat.dispose();
        lGeo.dispose(); lMat.dispose();
        if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
      };
    })();

    return () => {
      aborted = true;
      cleanup?.();
    };
  }, []);

  return <div ref={mountRef} className={`absolute inset-0 ${className}`} />;
}
