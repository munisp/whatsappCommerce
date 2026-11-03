import { useEffect, useState } from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { OakLogo, OakMark } from "@/components/OakLogo";
import { Button } from "@/components/ui/button";
import { Photo } from "./Photo";

const SEEN_KEY = "oak-intro-seen";
const INTRO_MS = 4900;

const TITLE_CARDS = [
  { word: "Oja", language: "Yoruba", photo: "aso-oke-portrait", position: "50% 22%" },
  { word: "Ahia", language: "Igbo", photo: "ankara-textiles", position: "50% 50%" },
  { word: "Kasuwa", language: "Hausa", photo: "merchant-shop", position: "50% 35%" },
];

function shouldPlayIntro() {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false;
    if (sessionStorage.getItem(SEEN_KEY)) return false;
    sessionStorage.setItem(SEEN_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

type Props = { ctaLabel: string; signInLabel: string; onCta: () => void; onSeeSale: () => void };

/** Opening titles, once per visit, then the market at full screen. Any scroll, key or tap skips them. */
export function LandingHero({ ctaLabel, signInLabel, onCta, onSeeSale }: Props) {
  const [played] = useState(shouldPlayIntro);
  const [showIntro, setShowIntro] = useState(played);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    if (!showIntro) return;
    const timer = window.setTimeout(() => setShowIntro(false), INTRO_MS);
    const skip = () => {
      setSkipped(true);
      setShowIntro(false);
    };
    const events = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    events.forEach((name) => window.addEventListener(name, skip, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, skip));
    };
  }, [showIntro]);

  const heroDelay = played && !skipped ? "4s" : "0s";

  return (
    <header className="oak-hero" style={{ "--intro": heroDelay } as React.CSSProperties}>
      {showIntro && (
        <div className="oak-intro" aria-hidden="true">
          <div className="oak-intro-reel">
            {TITLE_CARDS.map((card, index) => (
              <div key={card.word} className="oak-intro-card" style={{ "--card": index } as React.CSSProperties}>
                <Photo name={card.photo} alt="" largest={1200} position={card.position} priority={index === 0} />
                <div className="oak-intro-title">
                  <span className="oak-display">{card.word}</span>
                  <small className="oak-eyebrow">{card.language} for market</small>
                </div>
              </div>
            ))}
            <div className="oak-intro-mark">
              <OakMark tone="light" className="h-24 w-24 sm:h-32 sm:w-32" />
              <span className="oak-display">OAK</span>
            </div>
          </div>
          <div className="oak-intro-bar oak-intro-bar-top" />
          <div className="oak-intro-bar oak-intro-bar-bottom" />
        </div>
      )}

      <div className="oak-hero-photo">
        <Photo name="market-traders" phone={1200} priority alt="Two women trading vegetables at a busy market" />
      </div>
      <div className="oak-hero-shade" />

      <nav className="oak-hero-nav mx-auto flex w-full max-w-7xl items-center justify-between px-6 pt-6 lg:px-10">
        <OakLogo tone="light" />
        <Button
          variant="outline"
          onClick={onCta}
          className="border-[#F7F2E7]/60 bg-transparent text-[#F7F2E7] hover:bg-[#F7F2E7] hover:text-[var(--oak-forest)]"
        >
          {signInLabel}
        </Button>
      </nav>

      <div className="oak-hero-copy mx-auto w-full max-w-7xl px-6 pb-14 lg:px-10 lg:pb-20">
        <p className="oak-eyebrow oak-rise text-[#E7C98A]" style={{ "--i": 0 } as React.CSSProperties}>Oja · Ahia · Kasuwa</p>
        <h1 className="oak-display oak-hero-title mt-5">
          {["African commerce", "has deep roots.", "Now it has a home."].map((line, index) => (
            <span key={line} className="oak-line">
              <span className="oak-line-inner" style={{ "--i": index + 1 } as React.CSSProperties}>{line}</span>
            </span>
          ))}
        </h1>
        <p className="oak-rise mt-6 max-w-xl text-lg leading-relaxed text-[#F7F2E7]" style={{ "--i": 4 } as React.CSSProperties}>
          OAK gives merchants what a good market always has: trust, regular customers and money that moves safely, in the chat apps people already use.
        </p>
        <div className="oak-rise mt-8 flex flex-wrap items-center gap-3" style={{ "--i": 5 } as React.CSSProperties}>
          <Button size="lg" onClick={onCta} className="gap-2 bg-[#F7F2E7] text-[var(--oak-forest)] hover:bg-white">
            {ctaLabel} <ArrowRight className="h-4 w-4" />
          </Button>
          <button type="button" onClick={onSeeSale} className="oak-hero-link">
            Watch a sale happen <ArrowDown className="oak-nudge h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="oak-weave-band oak-hero-band" />
    </header>
  );
}
