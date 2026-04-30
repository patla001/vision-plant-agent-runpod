"use client";

import { useEffect, useRef } from "react";

export default function HeaderGem({ size = 32 }: { size?: number }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let animId: number;
    let cleanup: (() => void) | undefined;

    (async () => {
      const THREE = await import("three");
      const el = mountRef.current;
      if (!el) return;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(size, size);
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);

      const scene  = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.z = 3;

      // Octahedron gem
      const geo = new THREE.OctahedronGeometry(1, 0);
      const mat = new THREE.MeshBasicMaterial({
        color: "#22d3ee", wireframe: true, transparent: true, opacity: .7,
      });
      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);

      // Inner filled
      const innerMat = new THREE.MeshBasicMaterial({
        color: "#8b5cf6", transparent: true, opacity: .15,
      });
      scene.add(new THREE.Mesh(new THREE.OctahedronGeometry(.85, 0), innerMat));

      const animate = () => {
        animId = requestAnimationFrame(animate);
        mesh.rotation.y += .015;
        mesh.rotation.x += .008;
        renderer.render(scene, camera);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(animId);
        renderer.dispose();
        geo.dispose(); mat.dispose();
        if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
      };
    })();

    return () => cleanup?.();
  }, [size]);

  return <div ref={mountRef} style={{ width: size, height: size, flexShrink: 0 }} />;
}
