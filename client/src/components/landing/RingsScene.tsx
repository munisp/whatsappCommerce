import { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSceneProgress } from "./useSceneProgress";

const MILESTONES = ["Your first order", "Customers who come back", "A storefront of your own", "A business that lasts"];

const RING_COUNT = 9;

/** A hand-drawn looking growth ring: a circle nudged by a few slow waves, the same on every render. */
function ringPath(radius: number, seed: number) {
  const points: string[] = [];
  for (let step = 0; step <= 96; step += 1) {
    const angle = (step / 96) * Math.PI * 2;
    const wobble =
      Math.sin(angle * 3 + seed) * radius * 0.022 + Math.sin(angle * 5 + seed * 2.3) * radius * 0.012;
    const r = radius + wobble;
    points.push(`${step === 0 ? "M" : "L"}${(200 + Math.cos(angle) * r).toFixed(1)} ${(200 + Math.sin(angle) * r).toFixed(1)}`);
  }
  return `${points.join(" ")} Z`;
}

/** The closing shot: rings of an oak grow as the page scrolls, each one a stage of a shop's life. */
export function RingsScene({ ctaLabel, onCta }: { ctaLabel: string; onCta: () => void }) {
  const [reached, setReached] = useState(0);
  const ref = useSceneProgress<HTMLElement>((progress) => {
    setReached(Math.min(MILESTONES.length - 1, Math.floor(progress * MILESTONES.length)));
  });
  const rings = useMemo(
    () => Array.from({ length: RING_COUNT }, (_, index) => ringPath(26 + index * 20, index * 1.7 + 0.4)),
    [],
  );

  return (
    <section ref={ref} className="oak-rings-scene">
      <div className="oak-weave-band" />
      <div className="oak-rings-stage">
        <svg viewBox="0 0 400 400" className="oak-rings" aria-hidden="true">
          {rings.map((path, index) => (
            <path key={path} d={path} pathLength={1} className="oak-ring" style={{ "--ring": index } as React.CSSProperties} />
          ))}
          <circle cx="200" cy="200" r="9" fill="#B08D45" />
        </svg>
        <div className="relative mx-auto w-full max-w-7xl px-6 lg:px-10">
          <h2 className="oak-display max-w-2xl text-5xl leading-[1.05] text-[#F7F2E7] sm:text-7xl">Plant your shop. Watch it grow.</h2>
          <ul className="mt-8 space-y-2">
            {MILESTONES.map((milestone, index) => (
              <li key={milestone} className={`oak-milestone ${index <= reached ? "is-reached" : ""}`}>{milestone}</li>
            ))}
          </ul>
          <Button size="lg" onClick={onCta} className="mt-10 gap-2 bg-[#F7F2E7] text-[var(--oak-forest)] hover:bg-white">
            {ctaLabel} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}
