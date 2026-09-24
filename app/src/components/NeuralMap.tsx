import createGlobe from 'cobe';
import { useEffect, useRef } from 'react';

// Approximate coordinates for common region labels; unknown regions are not plotted.
const REGION_COORDS: Record<string, [number, number]> = {
  egypt: [30.04, 31.24], 'europe-central': [50.11, 8.68], eu: [50.11, 8.68], 'us-east': [39.04, -77.49],
  'us-west': [37.77, -122.42], asia: [1.35, 103.82], india: [19.07, 72.87], cloud: [39.04, -77.49],
};

export function NeuralMap({ regions }: { regions: string[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const key = regions.join('|');

  useEffect(() => {
    if (!canvasRef.current) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const markers = key
      .split('|')
      .map((r) => REGION_COORDS[r.toLowerCase()])
      .filter(Boolean)
      .map((location) => ({ location: location as [number, number], size: 0.06 }));
    let phi = 0;
    let frame = 0;
    const globe = createGlobe(canvasRef.current, {
      devicePixelRatio: 2,
      width: 1000,
      height: 1000,
      phi: 0,
      theta: 0.2,
      dark: 0,
      diffuse: 1.2,
      mapSamples: 16000,
      mapBrightness: 6,
      baseColor: [1, 1, 1],
      markerColor: [0.1, 0.45, 0.9],
      glowColor: [1, 1, 1],
      markers,
    });
    const tick = () => {
      if (!reduceMotion) phi += 0.003;
      globe.update({ phi });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      globe.destroy();
    };
  }, [key]);

  return <canvas ref={canvasRef} width={1000} height={1000} aria-hidden className="w-[420px] h-[420px] max-w-full aspect-square opacity-90" />;
}
